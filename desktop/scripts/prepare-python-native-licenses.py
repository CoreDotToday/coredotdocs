"""Collect Rust dependencies from the exact uv-locked native Python sdists.

This maintainer command uses archive checksums from backend/uv.lock. Packaging
uses the generated, reviewed inventory offline and rejects version mismatches.
"""
from __future__ import annotations

import concurrent.futures
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("rust_notices", Path(__file__).with_name("prepare-rust-licenses.py"))
rust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rust)
NATIVE = {"pydantic-core", "rpds-py", "watchfiles"}


def main() -> None:
    lock = tomllib.loads((ROOT / "backend/uv.lock").read_text(encoding="utf8"))
    projects, crates = [], {}
    for package in lock["package"]:
        if package["name"] not in NATIVE:
            continue
        source = package["sdist"]
        cached = rust.CACHE / f"python-{package['name']}-{package['version']}.tar.gz"
        data = cached.read_bytes() if cached.exists() else rust.download(source["url"])
        if "sha256:" + rust.sha(data) != source["hash"]:
            raise ValueError("Native Python sdist checksum mismatch")
        cached.write_bytes(data)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            locks = [m for m in archive.getmembers() if m.isfile() and m.name.endswith("/Cargo.lock")]
            if not locks:
                raise ValueError(f"No Cargo.lock in {package['name']}; review native dependencies")
            project_crates = set()
            for member in locks:
                cargo = tomllib.loads(archive.extractfile(member).read().decode())
                for crate in cargo["package"]:
                    if not crate.get("source"):
                        continue
                    if crate["source"] != "registry+https://github.com/rust-lang/crates.io-index":
                        raise ValueError(f"Non-registry native dependency requires review: {crate['name']}")
                    key = f"{crate['name']}@{crate['version']}"
                    crates[key] = crate
                    project_crates.add(key)
        projects.append({"name": package["name"], "version": package["version"],
                         "source": source["url"], "sourceSha256": source["hash"][7:],
                         "crates": sorted(project_crates)})
    if {p["name"] for p in projects} != NATIVE:
        raise ValueError("Native Python project removed or renamed; review inventory")
    records, errors = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(rust.crate_notices, p): p for p in crates.values()}
        for future in concurrent.futures.as_completed(futures):
            try:
                records.append(future.result())
            except Exception as error:
                errors.append(str(error))
    if errors:
        raise ValueError("\n".join(sorted(errors)))
    texts = {}
    for record in records:
        refs = {}
        for file, text in sorted(record.pop("notices").items()):
            digest = rust.sha(text.encode())
            texts[digest] = text
            refs[file] = digest
        record["noticeTexts"] = refs
    result = {"schemaVersion": 1, "scope": "Conservative native Python Cargo.lock notice superset including optional/dev crates.",
              "projects": sorted(projects, key=lambda p: p["name"]),
              "packages": sorted(records, key=lambda p: (p["name"], p["version"])), "texts": dict(sorted(texts.items()))}
    out = ROOT / "desktop/licenses/python-native.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Verified {len(projects)} Python sdists and {len(records)} crates -> {out}")


if __name__ == "__main__":
    main()
