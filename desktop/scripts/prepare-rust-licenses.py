"""Refresh checked-in rhwp dependency notices from checksum-verified crate sources.

Run only when updating rhwp. Packaging consumes the reviewed JSON offline. The
whole lockfile is deliberately covered, including optional/native/dev crates;
this is a notice superset, not a claim that all these crates enter the WASM.
No downloaded code is executed or extracted into the source tree.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tomllib
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
COMMIT = "1a76570e833917d15817415a53c09ad61ab3203f"
LOCK_SHA256 = "f24e98940a42000cea09500bea090cc571773e761c3d068769227e82a0e2f024"
VERSION = "0.8.7"
CACHE = ROOT / "desktop/dist/license-cache"
OUTPUT = ROOT / f"desktop/licenses/rhwp-{VERSION}.json"
NOTICE_NAME = re.compile(r"^(licen[cs]es?|copying|copyright|notices?|unlicense)([._-].*)?$", re.I)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "coredotdocs-license-inventory/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def crate_notices(package: dict) -> dict:
    name, version, checksum = package["name"], package["version"], package["checksum"]
    url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
    cache = CACHE / f"{name}-{version}.crate"
    data = cache.read_bytes() if cache.exists() else download(url)
    if sha(data) != checksum:
        raise ValueError(f"Crate checksum mismatch: {name}@{version}")
    if not cache.exists():
        cache.write_bytes(data)
    notices = {}
    extra_sources = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        prefix = f"{name}-{version}/"
        manifest = tomllib.loads(archive.extractfile(prefix + "Cargo.toml").read().decode())
        license_file = manifest["package"].get("license-file")
        for entry in archive.getmembers():
            if not entry.isfile() or not entry.name.startswith(prefix):
                continue
            relative = entry.name[len(prefix):]
            if ".." in Path(relative).parts:
                raise ValueError(f"Unsafe crate member: {entry.name}")
            if NOTICE_NAME.match(Path(relative).name) or "licenses" in [p.lower() for p in Path(relative).parts[:-1]] or Path(relative).name == "AUTHORS" or relative == license_file:
                notices[relative] = archive.extractfile(entry).read().decode("utf-8-sig", errors="replace")
        # These published r-efi archives explicitly offer Apache-2.0 and retain
        # attribution in AUTHORS, but do not ship a license file. Select Apache
        # rather than its alternative LGPL grant; preserve AUTHORS verbatim.
        if name == "r-efi" and version in {"5.3.0", "6.0.0"}:
            notices["LICENSE-APACHE-2.0-selected.txt"] = (ROOT / "LICENSE").read_text(encoding="utf8")
        # hexf is explicitly dedicated under CC0 in its verified Cargo.toml;
        # upstream supplies no legalcode file, so include the canonical text.
        if name == "hexf-parse" and version == "0.2.1":
            source = "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/CC0-1.0.txt"
            cached_notice = CACHE / "CC0-1.0-v3.27.0.txt"
            content = cached_notice.read_bytes() if cached_notice.exists() else download(source)
            cached_notice.write_bytes(content)
            notices["CC0-1.0.txt"] = content.decode("utf8")
            extra_sources["CC0-1.0.txt"] = {"url": source, "sha256": sha(content)}
        # A few workspace crates omit the workspace-root license from the crate
        # archive. Their signed-in crate metadata pins its original Git commit.
        # Read that commit's license, never the repository's mutable default branch.
        if not notices:
            vcs_entry = archive.extractfile(prefix + ".cargo_vcs_info.json") if prefix + ".cargo_vcs_info.json" in archive.getnames() else None
            vcs = json.loads(vcs_entry.read()) if vcs_entry else {}
            repository = (manifest["package"].get("repository") or manifest["package"].get("homepage", "")).removesuffix(".git")
            match = re.match(r"https?://github.com/([\w.-]+/[\w.-]+)(?:/|$)", repository)
            commit = vcs.get("git", {}).get("sha1", "")
            if match and re.fullmatch(r"[a-f0-9]{40}", commit):
                tree_url = f"https://api.github.com/repos/{match[1]}/git/trees/{commit}?recursive=1"
                tree_cache = CACHE / (sha(tree_url.encode()) + ".json")
                tree_data = tree_cache.read_bytes() if tree_cache.exists() else download(tree_url)
                tree_cache.write_bytes(tree_data)
                tree = json.loads(tree_data)
                if tree.get("truncated"):
                    raise ValueError("Truncated upstream license tree")
                files = [p["path"] for p in tree["tree"] if p["type"] == "blob" and len(Path(p["path"]).parts) <= 2
                         and (NOTICE_NAME.match(Path(p["path"]).name) or Path(p["path"]).parts[0].lower() == "licenses")]
                for filename in files:
                    source = f"https://raw.githubusercontent.com/{match[1]}/{commit}/{filename}"
                    cached_notice = CACHE / (sha(source.encode()) + ".license")
                    try:
                        content = cached_notice.read_bytes() if cached_notice.exists() else download(source)
                    except urllib.error.HTTPError as error:
                        if error.code == 404:
                            continue
                        raise
                    if not cached_notice.exists():
                        cached_notice.write_bytes(content)
                    notices["workspace/" + filename] = content.decode("utf-8-sig")
                    extra_sources["workspace/" + filename] = {"url": source, "sha256": sha(content)}
    if not notices:
        raise ValueError(f"No license text in verified crate: {name}@{version}")
    return {"name": name, "version": version, "license": manifest["package"].get("license", "SEE LICENSE FILE"),
            "selectedLicense": "Apache-2.0" if name == "r-efi" else None,
            "authors": manifest["package"].get("authors", []),
            "source": url, "sourceSha256": checksum, "extraSources": extra_sources, "notices": notices}


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    lock_url = f"https://raw.githubusercontent.com/edwardkim/rhwp/{COMMIT}/Cargo.lock"
    lock = download(lock_url)
    if sha(lock) != LOCK_SHA256:
        raise ValueError("Pinned rhwp Cargo.lock checksum mismatch")
    packages = tomllib.loads(lock.decode())["package"]
    external = [p for p in packages if p.get("source")]
    if any(p["source"] != "registry+https://github.com/rust-lang/crates.io-index" for p in external):
        raise ValueError("New non-registry dependency requires a provenance review")
    records, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(crate_notices, package): package for package in external}
        for future in concurrent.futures.as_completed(futures):
            try:
                records.append(future.result())
            except Exception as error:
                package = futures[future]
                failures.append(f"{package['name']}@{package['version']}: {error}")
    if failures:
        raise ValueError("Incomplete license inventory:\n" + "\n".join(sorted(failures)))
    texts = {}
    for record in records:
        refs = {}
        for file, text in sorted(record.pop("notices").items()):
            digest = sha(text.encode())
            texts[digest] = text
            refs[file] = digest
        record["noticeTexts"] = refs
    core_wasm = ROOT / "frontend/node_modules/@rhwp/core/rhwp_bg.wasm"
    result = {"schemaVersion": 1, "component": f"rhwp {VERSION}", "commit": COMMIT,
              "lockSource": lock_url, "lockSha256": LOCK_SHA256,
              "wasmSha256": sha(core_wasm.read_bytes()),
              "scope": "Conservative complete Cargo.lock notice superset, including optional/native/dev dependencies.",
              "packages": sorted(records, key=lambda p: (p["name"], p["version"])),
              "texts": dict(sorted(texts.items()))}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Verified {len(records)} crate archives; {len(texts)} distinct notice texts -> {OUTPUT}")


if __name__ == "__main__":
    main()
