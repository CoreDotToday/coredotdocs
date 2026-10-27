"""Refresh CanvasKit's reviewed native notice inventory from immutable upstream refs.

No upstream code is executed. The npm archive integrity and installed default
WASM are checked, then exact Skia DEPS/build inputs select a conservative notice
superset. Packaging consumes this checked-in inventory without network access.
"""
from __future__ import annotations

import base64
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "desktop/dist/license-cache/canvaskit/sources"
VERSION = "0.42.0"
COMMIT = "e2def78fa232884d4aedcf3ad92d4a0dd673b898"
EMSCRIPTEN_COMMIT = "8eaf19f1c6a9a1b0cd0f9a91657366829e34ae5c"  # upstream 3.1.26 tag
WASM_SHA256 = "25ebed8e60158c5854f8dc807b936daca21354f8bfb6a2231266b0a93812f301"
EVIDENCE = {
    "DEPS": "2b5dc93b229ae782d82f42e0c5d0eb6c810285bd8ae65196badee3364f1687db",
    "modules/canvaskit/compile.sh": "8b88398fd494e3d2ff6049df97e5f4d3f687dd21b7872ec39034ad6f23120bb5",
    "modules/canvaskit/Makefile": "b07b8967ace41879487ce8c6db9581d92a1ba8ba2ed73e2138a7decd8a31a880",
    "modules/canvaskit/BUILD.gn": "8cb2d97839b0c4b62386706b3c4b52d54e06d0ff610569f162d5682a12f86b6e",
    "infra/canvaskit/docker/canvaskit-emsdk/Dockerfile": "3d1efd2762fee7b3990d53ac53a8cd6474fc65d5a72e55d519df5e93630c944f",
}
DEPENDENCIES = {
    "brotli": ("MIT", ["LICENSE"]),
    "expat": ("MIT", ["COPYING"]),
    "freetype": ("FTL", ["LICENSE.TXT", "docs/FTL.TXT"]),
    "harfbuzz": ("MIT", ["COPYING", "AUTHORS"]),
    "icu": ("Unicode-3.0 AND other notices", ["LICENSE", "license.html"]),
    "libjpeg-turbo": ("IJG AND BSD-3-Clause AND Zlib", ["LICENSE.md", "README.ijg"]),
    "libpng": ("libpng-2.0", ["LICENSE", "AUTHORS"]),
    "libwebp": ("BSD-3-Clause", ["COPYING", "PATENTS", "AUTHORS"]),
    "wuffs": ("Apache-2.0", ["LICENSE"]),
    "zlib": ("Zlib", ["LICENSE"]),
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str) -> bytes:
    cached = CACHE / sha(url.encode())
    if cached.exists():
        return cached.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "coredotdocs-license-inventory/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    cached.write_bytes(data)
    return data


def github_file(repo: str, commit: str, file: str) -> tuple[str, bytes]:
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{file}"
    return url, download(url)


def record(name: str, version: str, license: str, source: str, files: list[str], github: bool = False) -> dict:
    texts, sources, source_hashes = {}, {}, {}
    for file in files:
        if github:
            url, data = github_file(source, version, file)
        else:
            url = f"{source}/+/{version}/{file}?format=TEXT"
            data = base64.b64decode(download(url), validate=True)
        text = data.decode("utf-8-sig")
        if not text.strip():
            raise ValueError(f"Empty license notice: {name}/{file}")
        texts[file] = text
        sources[file] = url
        source_hashes[file] = sha(data)
    return {"name": name, "version": version, "license": license,
            "source": f"https://github.com/{source}/tree/{version}" if github else f"{source}/+/{version}",
            "noticeSources": sources, "noticeSourceSha256": source_hashes, "notices": texts}


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    evidence, evidence_text = [], {}
    for file, digest in EVIDENCE.items():
        url, data = github_file("google/skia", COMMIT, file)
        if sha(data) != digest:
            raise ValueError(f"Skia build evidence checksum mismatch: {file}")
        evidence.append({"path": file, "source": url, "sha256": digest})
        evidence_text[file] = data.decode()
    metadata = json.loads(download(f"https://registry.npmjs.org/canvaskit-wasm/{VERSION}"))
    if metadata["gitHead"] != COMMIT:
        raise ValueError("CanvasKit npm gitHead differs from the reviewed Skia revision")
    package = download(metadata["dist"]["tarball"])
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(package).digest()).decode()
    if integrity != metadata["dist"]["integrity"]:
        raise ValueError("CanvasKit npm integrity mismatch")
    with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
        wasm = archive.extractfile("package/bin/canvaskit.wasm").read()
    if sha(wasm) != WASM_SHA256:
        raise ValueError("CanvasKit default WASM changed; review its native inventory")
    installed = ROOT / f"frontend/node_modules/.pnpm/canvaskit-wasm@{VERSION}/node_modules/canvaskit-wasm/bin/canvaskit.wasm"
    if not installed.is_file() or sha(installed.read_bytes()) != WASM_SHA256:
        raise ValueError("Installed CanvasKit WASM does not match the reviewed npm artifact")
    requests = []
    for name, (license, files) in DEPENDENCIES.items():
        match = re.search(r'"third_party/externals/' + re.escape(name) + r'"\s*:\s*"([^"]+)"', evidence_text["DEPS"])
        if match is None:
            raise ValueError(f"Missing immutable Skia dependency: {name}")
        repository, commit = match[1].rsplit("@", 1)
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError(f"Unpinned Skia dependency: {name}")
        requests.append((name, commit, license, repository, files, False))
    requests.extend([
        ("skia", COMMIT, "BSD-3-Clause", "google/skia", ["LICENSE"], True),
        ("skcms", COMMIT, "BSD-3-Clause", "google/skia", ["modules/skcms/LICENSE"], True),
        ("emscripten-runtime", EMSCRIPTEN_COMMIT, "SEE LICENSE FILES", "emscripten-core/emscripten",
         ["LICENSE", "system/lib/libc/musl/COPYRIGHT", "system/lib/libcxx/LICENSE.TXT", "system/lib/libcxxabi/LICENSE.TXT", "system/lib/compiler-rt/LICENSE.TXT"], True),
    ])
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(record, *request): request[0] for request in requests}
        errors = []
        for future in concurrent.futures.as_completed(futures):
            try:
                records.append(future.result())
            except Exception as error:
                errors.append(f"{futures[future]}: {error}")
        if errors:
            raise ValueError("\n".join(sorted(errors)))
    texts = {}
    for item in records:
        refs = {}
        for file, text in sorted(item.pop("notices").items()):
            digest = sha(text.encode())
            texts[digest] = text
            refs[file] = digest
        item["noticeTexts"] = refs
        if item["name"] == "freetype":
            header_url = item["source"] + "/include/freetype/freetype.h?format=TEXT"
            header = base64.b64decode(download(header_url), validate=True)
            copyright_years = re.search(r"Copyright \(C\) ([0-9-]+) by", header.decode()[:1800])
            if copyright_years is None:
                raise ValueError("FreeType copyright year needs review for its FTL acknowledgement")
            item["acknowledgement"] = f"Portions of this software are copyright © {copyright_years[1]} The FreeType Project (www.freetype.org). All rights reserved."
            item["acknowledgementSource"] = {"source": header_url, "sha256": sha(header)}
    result = {
        "schemaVersion": 1, "component": f"canvaskit-wasm {VERSION}", "commit": COMMIT, "wasmSha256": WASM_SHA256,
        "scope": "Conservative default CanvasKit native-runtime notice superset from pinned Skia DEPS and build files. Expat is included conservatively although viewer mode alone enables it. Standard npm bin disables embedded fonts; this does not cover bin/full or custom rebuilds.",
        "npmArtifact": {"source": metadata["dist"]["tarball"], "integrity": integrity, "sourceSha256": sha(package), "wasmMember": "package/bin/canvaskit.wasm"},
        "buildEvidence": evidence,
        "packages": sorted(records, key=lambda item: item["name"]), "texts": dict(sorted(texts.items())),
    }
    output = ROOT / f"desktop/licenses/canvaskit-{VERSION}.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Verified npm WASM and {len(records)} native components / {len(texts)} notice texts -> {output}")


if __name__ == "__main__":
    main()
