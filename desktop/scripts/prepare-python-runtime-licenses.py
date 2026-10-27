"""Pin notices for native libraries in the reviewed Windows CPython runtime.

Run with the uv-managed Python 3.13.18 (standalone build 20261026). Downloads
are checksum-pinned metadata, notice texts and source archives. Only exact
notice members are read in memory; no downloaded code runs or is extracted.
Use --check for an offline check of the committed inventory and current runtime.
"""
from __future__ import annotations

import argparse
import decimal
import hashlib
import io
import json
from pathlib import Path
import platform
import pyexpat
import sqlite3
import ssl
import sys
import tarfile
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "desktop/dist/license-cache"
OUT = ROOT / "desktop/licenses/python-runtime-3.13.18.json"
VERSION = "3.13.18"
BUILD = "20261026"
COMMIT = "fa506e0858ac9f2cc5b289c137b888a2aa24d1ee"
BASE = f"https://raw.githubusercontent.com/astral-sh/python-build-standalone/{COMMIT}/"
METADATA_SHA = "8b0e472c66797dcd58dfa461171c7f416602503924091e5e4629e776221b8a27"
NATIVE_VERSIONS = {
    "openssl": "3.5.9", "sqlite": "3.53.1", "zlib": "1.3.2",
    "expat": "2.9.0", "mpdecimal": "4.0.0",
}
# The standalone builder overrides CPython's PCbuild dependency versions. Its
# exact build manifest, rather than the CPython source defaults, is authoritative.
COMPONENTS = {
    "openssl-3.5": ("OpenSSL", "3.5.9", "Apache-2.0", "openssl-3",
                    "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a"),
    "libffi": ("libffi", "3.8.0", "MIT", "libffi",
               "deaf3a42effb551a5b140fa9afefed183a27f1341c6d1bf430d106a5e6931fc0"),
    "zlib": ("zlib", "1.3.2", "Zlib", "zlib",
             "818922b2620f12801a12bf78e399644a30990e66824abd8ca8ec24d451d6f92c"),
    "expat": ("Expat", "2.9.0", "MIT", "expat",
              "122f2c27000472a201d337b9b31f7eb2b52d091b02857061a8880371612d9534"),
    "xz": ("liblzma", "5.8.4", "0BSD", "liblzma",
           "9a4062de0a2c388a98cf35a35d348b62fa97c838a71c3c28ee1a2d7d0a565b02"),
    "sqlite": ("SQLite", "3530100", "LicenseRef-SQLite-Public-Domain", "sqlite",
               "38bef3d28b24f145ea293bd3b6eb4b20396982abc8303128fb493986ea5bc719"),
    "bzip2": ("bzip2", "1.0.8", "bzip2-1.0.6", "bzip2",
              "1f38bbc7caacafd65169276d759c0d88c991b753b643ce35d0e45ea1971dd441"),
    "mpdecimal": ("mpdecimal", "4.0.0", "BSD-2-Clause", "mpdecimal",
                  "669512af7219f58be03a398766d7c9da11a3b3df9d3f05cb74c5ceca25c8da3b"),
}
# Preserve the distributor's notices and the exact source release notices. Some
# distributor copies have older copyright years than the source it compiles.
ARCHIVE_NOTICES = {
    "libffi": ("libffi-3.8.0/LICENSE", "17b64dc60f3b6897a60f971e288b973f655c2edcdf08b25f3c3dd5549857881c"),
    "zlib": ("zlib-1.3.2/LICENSE", "e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2"),
    "expat": ("expat-2.9.0/COPYING", "31b15de82aa19a845156169a17a5488bf597e561b2c318d159ed583139b25e87"),
    "xz": ("xz-5.8.4/COPYING.0BSD", "0b01625d853911cd0e2e088dcfb743261034a091bb379246cb25a14cc4c74bf1"),
    "bzip2": ("bzip2-1.0.8/LICENSE", "c6dbbf828498be844a89eaa3b84adbab3199e342eb5cb2ed2f0d4ba7ec0f38a3"),
    "mpdecimal": ("mpdecimal-4.0.0/COPYRIGHT.txt", "2713324211652ce4a60e6e21e54f9dc3004299e591b0933a352f1a89c5fb53c2"),
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_bytes(data: bytes, expected: str, name: str) -> bytes:
    if sha(data) != expected:
        raise ValueError(f"Upstream checksum mismatch: {name}")
    return data


def pinned_download(relative: str, expected: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"python-runtime-{expected}.txt"
    if cached.exists():
        return checked_bytes(cached.read_bytes(), expected, relative)
    request = urllib.request.Request(BASE + relative, headers={"User-Agent": "coredotdocs-license-inventory"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(2_000_001)
    if len(data) > 2_000_000:
        raise ValueError(f"Unexpectedly large upstream metadata: {relative}")
    checked_bytes(data, expected, relative)
    cached.write_bytes(data)
    return data


def source_notice(key: str, source: dict) -> tuple[str, str, str]:
    member_name, expected = ARCHIVE_NOTICES[key]
    cached = CACHE / f"python-runtime-{key}-{source['version']}.tar"
    if cached.exists():
        data = checked_bytes(cached.read_bytes(), source["sha256"], key)
    else:
        request = urllib.request.Request(source["url"], headers={"User-Agent": "coredotdocs-license-inventory"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(64_000_001)
        if len(data) > 64_000_000:
            raise ValueError(f"Unexpectedly large source archive: {key}")
        checked_bytes(data, source["sha256"], key)
        cached.write_bytes(data)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        matches = [member for member in archive.getmembers() if member.name == member_name]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 1_000_000:
            raise ValueError(f"Missing or ambiguous exact source notice: {member_name}")
        text = checked_bytes(archive.extractfile(matches[0]).read(), expected, member_name).decode("utf8")
    if sha(text.encode("utf8")) != expected:
        raise ValueError(f"Notice must be exact UTF-8: {member_name}")
    return member_name, expected, text


def runtime_info() -> dict:
    if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise ValueError("This reviewed inventory is Windows x64 only; review other platforms separately")
    if platform.python_version() != VERSION:
        raise ValueError(f"Expected Python {VERSION}, got {platform.python_version()}")
    runtime = Path(sys.base_prefix)
    if (runtime / "BUILD").read_text(encoding="utf8").strip() != BUILD:
        raise ValueError(f"Expected python-build-standalone build {BUILD}")
    versions = {
        "openssl": ssl.OPENSSL_VERSION.split()[1],
        "sqlite": sqlite3.sqlite_version,
        "zlib": zlib.ZLIB_RUNTIME_VERSION,
        "expat": pyexpat.EXPAT_VERSION.removeprefix("expat_"),
        "mpdecimal": decimal.__libmpdec_version__,
    }
    if versions != NATIVE_VERSIONS:
        raise ValueError(f"Native runtime versions need review: {versions}")
    binaries = {}
    for directory in (runtime, runtime / "DLLs"):
        for binary in sorted(directory.iterdir()):
            if binary.is_file() and binary.suffix.lower() in {".dll", ".pyd"}:
                if binary.name in binaries:
                    raise ValueError(f"Ambiguous runtime binary: {binary.name}")
                binaries[binary.name] = sha(binary.read_bytes())
    required = {"python313.dll", "libffi-8.dll", "libssl-3-x64.dll", "libcrypto-3-x64.dll",
                "sqlite3.dll", "zlib1.dll", "pyexpat.pyd", "_bz2.pyd", "_lzma.pyd", "_decimal.pyd"}
    if not required.issubset(binaries):
        raise ValueError(f"Runtime binaries missing: {sorted(required - binaries.keys())}")
    return {"runtimeVersion": VERSION, "runtimeBuild": BUILD, "nativeVersions": versions,
            "runtimeBinarySha256": {"win32-x64": dict(sorted(binaries.items()))}}


def build_inventory() -> dict:
    runtime = runtime_info()
    downloads = json.loads(pinned_download("pythonbuild/downloads.json", METADATA_SHA))
    packages, texts = [], {}
    for key, (name, version, license_id, notice_name, notice_sha) in COMPONENTS.items():
        source = downloads[key]
        notice_file = f"LICENSE.{notice_name}.txt"
        if source["version"] != version or source["license_file"] != notice_file:
            raise ValueError(f"Unexpected runtime build component: {key}")
        text = pinned_download(notice_file, notice_sha).decode("utf8")
        if not text.strip() or sha(text.encode("utf8")) != notice_sha:
            raise ValueError(f"Notice must be nonempty, exact UTF-8: {notice_file}")
        texts[notice_sha] = text
        package = {"name": name, "version": "3.53.1" if key == "sqlite" else version,
                   "license": license_id, "source": source.get("upstream_url", source["url"]),
                   "sourceArchive": source["url"], "sourceSha256": source["sha256"],
                   "noticeSource": BASE + notice_file, "noticeTexts": {notice_file: notice_sha}}
        if key == "xz":
            package["scope"] = "liblzma library only; xz command-line tools are not distributed."
        if key in ARCHIVE_NOTICES:
            source_file, source_digest, source_text = source_notice(key, source)
            texts[source_digest] = source_text
            package["noticeTexts"][source_file] = source_digest
        packages.append(package)
    return {"schemaVersion": 1, "component": "CPython Windows native runtime libraries",
            "scope": "Native libraries in the Windows x64 CPython standalone runtime; CPython, Tcl/Tk and Microsoft notices are collected separately from the installed runtime. Other operating systems require separate native dependency review.",
            **runtime, "buildSource": f"https://github.com/astral-sh/python-build-standalone/tree/{COMMIT}",
            "buildManifest": {"source": BASE + "pythonbuild/downloads.json", "sha256": METADATA_SHA},
            "packages": sorted(packages, key=lambda p: p["name"].lower()), "texts": dict(sorted(texts.items()))}


def verify_inventory(inventory: dict) -> None:
    if inventory.get("schemaVersion") != 1:
        raise ValueError("Unsupported runtime inventory schema")
    for key, expected in runtime_info().items():
        if inventory.get(key) != expected:
            raise ValueError(f"Runtime inventory mismatch: {key}")
    if len(inventory.get("packages", [])) != len(COMPONENTS):
        raise ValueError("Runtime notice components missing")
    expected_packages = {}
    for key, (name, version, license_id, notice_name, digest) in COMPONENTS.items():
        notices = {f"LICENSE.{notice_name}.txt": digest}
        if key in ARCHIVE_NOTICES:
            source_file, source_digest = ARCHIVE_NOTICES[key]
            notices[source_file] = source_digest
        expected_packages[name] = {"version": "3.53.1" if key == "sqlite" else version,
                                   "license": license_id, "noticeTexts": notices}
    observed = set()
    for package in inventory["packages"]:
        name = package.get("name")
        expected = expected_packages.get(name)
        if not expected or name in observed or any(package.get(key) != value for key, value in expected.items()):
            raise ValueError(f"Runtime component provenance changed: {name}")
        observed.add(name)
    expected_notices = {entry[4] for entry in COMPONENTS.values()}
    expected_notices.update(entry[1] for entry in ARCHIVE_NOTICES.values())
    if set(inventory.get("texts", {})) != expected_notices:
        raise ValueError("Runtime notice texts changed")
    for digest, text in inventory["texts"].items():
        checked_bytes(text.encode("utf8"), digest, "runtime notice")
    if {digest for p in inventory["packages"] for digest in p["noticeTexts"].values()} != expected_notices:
        raise ValueError("Runtime notice references missing")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify the inventory and runtime offline")
    args = parser.parse_args()
    if args.check:
        inventory = json.loads(OUT.read_text(encoding="utf8"))
        verify_inventory(inventory)
    else:
        inventory = build_inventory()
        verify_inventory(inventory)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Verified Python {VERSION} build {BUILD}: {len(inventory['packages'])} native components, "
          f"{len(inventory['runtimeBinarySha256']['win32-x64'])} runtime binary checksums -> {OUT}")


if __name__ == "__main__":
    main()
