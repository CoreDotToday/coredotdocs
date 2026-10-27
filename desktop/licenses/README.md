# Desktop dependency notices

`after-pack.js` generates `resources/THIRD-PARTY-NOTICES.txt`, a machine-readable
`resources/third-party-manifest.json`, and the complete notice files under
`resources/licenses/`. Original upstream copyright contacts are retained. These
contacts are third-party attribution, not the application's contact information.

Packaging is offline. It collects the installed frontend runtime dependency
closure, explicitly includes CanvasKit and noble/hashes bundled by rhwp-studio,
and includes nested licenses such as Next's compiled dependencies. Small npm
archives that omit license files have version-pinned supplements with provenance;
`client-only`'s absent copyright statement is documented without inventing an owner.

Python notices are captured immediately after PyInstaller by
`scripts/collect-python-licenses.py --write`. This records the exact Python version,
standalone build, exposed native library versions, distribution inputs and output
file hashes. Packaging verifies the copied backend against that snapshot and
consumes the build-only snapshot before signing. The published manifest hashes
license texts, which code signing does not change.

Desktop builds use the uv-managed version in `scripts/python-version.txt`.
PostgreSQL native drivers are excluded; shared SQLAlchemy types remain available.
Next's unused HTTP image optimizer is disabled through supported configuration,
and sharp/libvips and the build-only SWC compiler are not distributed. Document
images continue to be rendered by the editors.

The checked-in native inventories deliberately cover conservative dependency
supersets. An entry is not a claim that every optional/native/development crate is
linked into the product. Source references, archive checksums, full notice text
hashes and published WASM hashes are retained for review.

To refresh after an upstream update, run from the repository root with the build
Python (Windows: `backend/.venv/Scripts/python.exe`; Unix: `backend/.venv/bin/python`):

```text
<python> desktop/scripts/prepare-rust-licenses.py
<python> desktop/scripts/prepare-python-native-licenses.py
<python> desktop/scripts/prepare-canvaskit-licenses.py
<python> desktop/scripts/prepare-python-runtime-licenses.py
<python> desktop/scripts/prepare-npm-supplement-licenses.py
```

Review the pinned versions, source grants, selected license alternatives and
required acknowledgements before committing regenerated inventories. Network
access occurs in these maintainer preparation commands; verified downloads are
cached under ignored build output. A version/hash mismatch or missing notice
stops packaging rather than silently using an old inventory.

The reviewed Python native runtime platform is currently **Windows x64**.
macOS/Linux packaging stops until an inventory for that platform is reviewed,
including platform-specific dependencies and their source notices. Adding a
platform hash entry alone is not a substitute for that review. Existing Windows
notice coverage must not be presented as native Mac validation.

Run `node --test desktop/scripts/collect-licenses.test.cjs` for corruption,
missing-file, unexpected-binary and copied-WASM regression checks.
