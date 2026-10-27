"""Preserve notices omitted from two published npm archives, with provenance.

No copyright holder is guessed for client-only: its publisher supplies only an
MIT declaration. Keep that declaration and its complete tiny source alongside
the standard permission/warranty terms, rather than borrowing React's copyright.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def fetch(url):
    return urllib.request.urlopen(url, timeout=30).read().decode("utf8")


def record(name, version, source, text):
    return {"name": name, "version": version, "source": source,
            "sha256": hashlib.sha256(text.encode()).hexdigest(), "text": text}


nodable = "https://raw.githubusercontent.com/nodable/val-parsers/ac48e7ea591da372be023a481875c747535812b3/LICENSE"
mit_source = "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt"
mit = fetch(mit_source)
# The SPDX template's copyright placeholder is not a real notice. The publisher
# omitted a copyright statement; retain its original files and do not invent one.
terms = mit[mit.index("Permission is hereby"):]
client = ROOT / "frontend/node_modules/.pnpm/client-only@0.0.1/node_modules/client-only"
client_text = ("client-only 0.0.1\nPublisher-declared license: MIT\n"
               "The published archive contains no copyright statement or LICENSE file. "
               "No copyright owner has been inferred. Original published source and package metadata follow.\n\n")
for name in ["package.json", "index.js", "error.js"]:
    client_text += f"--- {name} ---\n" + (client / name).read_text(encoding="utf8") + "\n"
client_text += f"\nStandard MIT permission and warranty terms ({mit_source}):\n\n" + terms
out = {"schemaVersion": 1, "packages": [record("@nodable/entities", "3.1.0", nodable, fetch(nodable)),
         record("client-only", "0.0.1", "https://registry.npmjs.org/client-only/-/client-only-0.0.1.tgz", client_text)]}
(ROOT / "desktop/licenses/npm-supplements.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print("Prepared two version-pinned npm notice supplements")
