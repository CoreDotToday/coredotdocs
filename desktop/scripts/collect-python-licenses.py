"""Report exact PyInstaller inputs and their installed distribution notices.

Called with the backend build venv, never the system Python. No network access.
License contents are returned to the packager; build-machine paths are omitted.
"""
from __future__ import annotations

import ast
import decimal
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import pyexpat
import sqlite3
import ssl
import sys
import zlib

ROOT = Path(__file__).resolve().parents[2]
NOTICE = re.compile(r"^(licen[cs]es?|copying|copyright|notices?|unlicense)([._-].*)?$", re.I)


def normalized(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def source_paths(value):
    if isinstance(value, (tuple, list)):
        for item in value:
            yield from source_paths(item)
    elif isinstance(value, str) and Path(value).is_absolute():
        yield normalized(Path(value))


def notice(path: Path, relative: str) -> dict:
    data = path.read_bytes()
    if not data.strip():
        raise ValueError(f"Empty license: {relative}")
    return {"file": relative, "sha256": hashlib.sha256(data).hexdigest(),
            "text": data.decode("utf-8-sig", errors="replace")}


def collect() -> dict:
    expected = Path(__file__).with_name("python-version.txt").read_text().strip()
    actual = ".".join(map(str, sys.version_info[:3]))
    if actual != expected:
        raise ValueError(f"Expected build Python {expected}, got {actual}; rebuild backend")
    toc = ROOT / "backend/build/editor-server/Analysis-00.toc"
    inputs = set(source_paths(ast.literal_eval(toc.read_text(encoding="utf8"))))
    runtime_inputs = [p for p in inputs if re.match(r"(?:lib)?python3(?:13|\.13).*(?:dll|dylib|so)", Path(p).name, re.I)]
    if not runtime_inputs or not all(p.startswith(normalized(Path(sys.base_prefix)) + os.sep) for p in runtime_inputs):
        raise ValueError("Analysis was produced by another Python runtime; rebuild backend")
    # SQLAlchemy keeps pure-Python dialect classes for shared JSONB model types;
    # only the actual top-level driver distributions/native libraries are excluded.
    if any(re.search(r"[/\\]site-packages[/\\]psycopg(?:_binary|_c|2)?(?:[/\\.-]|$)", p, re.I) for p in inputs):
        raise ValueError("PostgreSQL driver present in desktop Analysis; rebuild with desktop exclusions")
    records = []
    owned_inputs = set()
    for distribution in importlib.metadata.distributions():
        files = distribution.files or []
        paths = {normalized(Path(distribution.locate_file(f))): f for f in files}
        used = inputs.intersection(paths)
        if not used:
            continue
        owned_inputs.update(used)
        name, version = distribution.metadata["Name"], distribution.version
        notices = []
        for file in files:
            if NOTICE.match(Path(file).name) or "licenses" in [p.lower() for p in Path(file).parts[:-1]]:
                path = Path(distribution.locate_file(file))
                if path.is_file():
                    notices.append(notice(path, str(file).replace("\\", "/")))
        if not notices:
            raise ValueError(f"No installed license text for bundled Python package {name}@{version}")
        records.append({"name": name, "version": version,
                        "license": distribution.metadata.get("License-Expression") or distribution.metadata.get("License") or "SEE LICENSE FILES",
                        "source": f"https://pypi.org/project/{name}/{version}/",
                        "notices": sorted(notices, key=lambda n: n["file"])})
    unowned = [p for p in inputs - owned_inputs if "site-packages" in Path(p).parts and Path(p).suffix]
    if unowned:
        # Report only module basenames: build-machine/user paths are not shipped.
        raise ValueError("Unattributed site-packages build inputs: " + ", ".join(sorted(Path(p).name for p in unowned)))
    prefix = Path(sys.base_prefix)
    runtime_notices = []
    for current, dirs, files in os.walk(prefix):
        dirs[:] = [d for d in dirs if d.lower() not in {"site-packages", "__pycache__", "test", "tests", "demos"}]
        for file in files:
            if NOTICE.match(file):
                path = Path(current) / file
                runtime_notices.append(notice(path, path.relative_to(prefix).as_posix()))
    if not any("PYTHON SOFTWARE FOUNDATION LICENSE" in n["text"] for n in runtime_notices):
        raise ValueError("Exact Python runtime PSF license is missing; use uv-managed Python")
    # PyInstaller's bootloader/runtime exception must accompany its runtime code.
    if not any(p["name"].lower() == "pyinstaller" for p in records):
        raise ValueError("PyInstaller runtime license absent from Analysis inventory")
    build_file = prefix / "BUILD"
    if not build_file.is_file():
        raise ValueError("Managed Python build identifier is missing")
    return {"runtimeBuild": build_file.read_text().strip(),
            "nativeVersions": {"openssl": ssl.OPENSSL_VERSION.split()[1], "sqlite": sqlite3.sqlite_version,
                               "zlib": zlib.ZLIB_RUNTIME_VERSION, "expat": pyexpat.EXPAT_VERSION.removeprefix("expat_"),
                               "mpdecimal": decimal.__libmpdec_version__},
            "runtime": {"name": "CPython", "version": actual, "license": "PSF-2.0 and bundled component licenses",
                        "source": f"https://www.python.org/downloads/release/python-{actual.replace('.', '')}/",
                        "notices": sorted(runtime_notices, key=lambda n: n["file"])},
            "packages": sorted(records, key=lambda p: p["name"].lower())}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf8")
    result = collect()
    if "--write" in sys.argv:
        bundle = ROOT / "backend/dist/editor-server"
        result["schemaVersion"] = 1
        result["sourceLockSha256"] = hashlib.sha256((ROOT / "backend/uv.lock").read_bytes()).hexdigest()
        result["bundleFiles"] = {}
        for file in sorted(bundle.rglob("*")):
            relative = file.relative_to(bundle).as_posix()
            if relative == "license-build.json":
                continue
            if file.is_symlink():
                result["bundleFiles"][relative] = {"symlink": os.readlink(file)}
            elif file.is_file():
                result["bundleFiles"][relative] = {"sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
        if not result["bundleFiles"]:
            raise ValueError("No backend build output to certify")
        target = bundle / "license-build.json"
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        print(f"Frozen Python {result['runtime']['version']} notices for {len(result['packages'])} distributions and {len(result['bundleFiles'])} build files: {target}")
    else:
        print(json.dumps(result, ensure_ascii=False))
