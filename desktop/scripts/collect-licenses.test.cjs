const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyInventory, verifyBackendSnapshot, verifyPublicWasm } = require('./collect-licenses.cjs');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-license-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function inventory() {
  const text = 'Retain the actual upstream copyright and license text.';
  return { schemaVersion: 1, component: 'test', wasmSha256: sha('reviewed-wasm'),
    packages: [{ name: 'example', version: '1', license: 'MIT', source: 'https://example.com/source', noticeTexts: { LICENSE: sha(text) } }],
    texts: { [sha(text)]: text } };
}

test('native inventory verifies reviewed source bytes and rejects a changed WASM', (t) => {
  const file = path.join(temporary(t), 'engine.wasm');
  fs.writeFileSync(file, 'reviewed-wasm');
  verifyInventory(inventory(), file);
  fs.writeFileSync(file, 'different-binary');
  assert.throws(() => verifyInventory(inventory(), file), /stale/);
});

test('native inventory rejects changed license text and unresolved references', () => {
  const changed = inventory();
  changed.texts[Object.keys(changed.texts)[0]] += 'edited';
  assert.throws(() => verifyInventory(changed), /Corrupt license/);
  const missing = inventory();
  missing.packages[0].noticeTexts.LICENSE = '0'.repeat(64);
  assert.throws(() => verifyInventory(missing), /Unresolved native notice/);
});

test('native component cannot silently omit provenance or all notices', () => {
  const missing = inventory();
  delete missing.packages[0].source;
  assert.throws(() => verifyInventory(missing), /provenance/);
  const empty = inventory();
  empty.packages[0].noticeTexts = {};
  assert.throws(() => verifyInventory(empty), /Missing native notices/);
});

function backend(t) {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'editor-server.exe'), 'built-backend');
  fs.writeFileSync(path.join(dir, 'license-build.json'), '{}');
  return { dir, snapshot: { schemaVersion: 1, sourceLockSha256: 'lock-digest',
    bundleFiles: { 'editor-server.exe': { sha256: sha('built-backend') } } } };
}

test('backend snapshot rejects copied binaries from a different build', (t) => {
  const { dir, snapshot } = backend(t);
  verifyBackendSnapshot(snapshot, dir, 'lock-digest');
  fs.writeFileSync(path.join(dir, 'editor-server.exe'), 'stale-backend');
  assert.throws(() => verifyBackendSnapshot(snapshot, dir, 'lock-digest'), /differs/);
});

test('backend snapshot rejects unreviewed extra files and changed lock', (t) => {
  const { dir, snapshot } = backend(t);
  assert.throws(() => verifyBackendSnapshot(snapshot, dir, 'new-lock'), /Stale/);
  fs.writeFileSync(path.join(dir, 'unexpected.dll'), 'unreviewed');
  assert.throws(() => verifyBackendSnapshot(snapshot, dir, 'lock-digest'), /unreviewed/);
});

test('backend snapshot rejects paths outside the app bundle', (t) => {
  const { dir, snapshot } = backend(t);
  snapshot.bundleFiles['../outside'] = { sha256: sha('outside') };
  assert.throws(() => verifyBackendSnapshot(snapshot, dir, 'lock-digest'), /escapes/);
});

test('public WASM validation checks copied assets, including hashed asset names', (t) => {
  const dir = temporary(t);
  const core = sha('core'), canvas = sha('canvas');
  fs.writeFileSync(path.join(dir, 'rhwp_bg-asset.wasm'), 'core');
  fs.writeFileSync(path.join(dir, 'canvaskit-asset.wasm'), 'canvas');
  verifyPublicWasm(dir, core, canvas);
  fs.writeFileSync(path.join(dir, 'rhwp_bg-asset.wasm'), 'old-core');
  assert.throws(() => verifyPublicWasm(dir, core, canvas), /Unreviewed/);
});

test('public WASM validation rejects incomplete and additional engines', (t) => {
  const dir = temporary(t), core = sha('core'), canvas = sha('canvas');
  fs.writeFileSync(path.join(dir, 'core.wasm'), 'core');
  assert.throws(() => verifyPublicWasm(dir, core, canvas), /does not match/);
  fs.writeFileSync(path.join(dir, 'canvas.wasm'), 'canvas');
  fs.writeFileSync(path.join(dir, 'extra.wasm'), 'unknown');
  assert.throws(() => verifyPublicWasm(dir, core, canvas), /Unreviewed/);
});
