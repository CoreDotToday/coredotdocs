const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { trustedSender, permittedPermission, FileGrants } = require('../security');

function renderer() {
  const frame = { url: 'http://127.0.0.1:47370/documents/test' };
  const wc = { mainFrame: frame, getURL: () => frame.url };
  const window = { isDestroyed: () => false, webContents: wc };
  return { window, event: { sender: wc, senderFrame: frame }, webUrl: 'http://127.0.0.1:47370' };
}

test('IPC trusts only the current first-party main frame', () => {
  const { window, event, webUrl } = renderer();
  assert.equal(trustedSender(event, window, webUrl), true);
  assert.equal(trustedSender({ ...event, senderFrame: { url: event.senderFrame.url } }, window, webUrl), false);
  assert.equal(trustedSender({ ...event, sender: {} }, window, webUrl), false);
  event.senderFrame.url = 'https://untrusted.example';
  assert.equal(trustedSender(event, window, webUrl), false);
  assert.equal(trustedSender(event, null, webUrl), false);
});

test('only local-fonts for this app is permitted', () => {
  const { window, event, webUrl } = renderer();
  assert.equal(permittedPermission('local-fonts', event.sender, webUrl, window, webUrl), true);
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'unknown']) {
    assert.equal(permittedPermission(permission, event.sender, webUrl, window, webUrl), false);
  }
  assert.equal(permittedPermission('local-fonts', {}, webUrl, window, webUrl), false);
  assert.equal(permittedPermission('local-fonts', event.sender, 'https://untrusted.example', window, webUrl), false);
});

test('file grants persist exact native selections, not siblings or relative paths', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-grants-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selected = path.join(dir, 'selected.docx');
  fs.writeFileSync(selected, 'PK');
  const grants = new FileGrants(path.join(dir, 'grants.json'));
  assert.equal(grants.has(selected), false);
  grants.grant(selected);
  assert.equal(new FileGrants(path.join(dir, 'grants.json')).has(selected), true);
  assert.equal(grants.has(path.join(dir, 'selected.docx-other.docx')), false);
  assert.equal(grants.has('selected.docx'), false);
  assert.throws(() => grants.grant('relative.docx'));
});

test('native selection is required before renderer paths can be read or written', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-ipc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selected = path.join(dir, 'selected.docx');
  const other = path.join(dir, 'other.docx');
  fs.writeFileSync(selected, 'PKselected'); fs.writeFileSync(other, 'PKother');
  const handlers = new Map(), listeners = new Map();
  let opens = 0, saves = 0;
  let openResult = { canceled: true, filePaths: [] };
  const electron = {
    app: { setName() {}, getVersion: () => '1.0.0', getPath: () => dir, isPackaged: false, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), addRecentDocument() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    dialog: { showOpenDialog: async () => { opens++; return openResult; }, showSaveDialog: async () => { saves++; return { canceled: true }; } },
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === './fonts' ? { installedFonts: async () => [] } : name === './security' ? require('../security') : require(name),
    __dirname: path.resolve(__dirname, '..'), process: { ...process, on() {} }, Buffer, URL, console, setTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const { window, event, webUrl } = renderer();
  context.testWindow = window; context.testServers = { webUrl };
  vm.runInContext('win = testWindow; servers = testServers;', context);
  assert.throws(() => handlers.get('file:read')({ ...event, senderFrame: { url: webUrl } }, selected), /허용되지/);
  assert.equal(await handlers.get('file:read')(event, selected), null);
  assert.equal(opens, 1);
  openResult = { canceled: false, filePaths: [selected] };
  const chosen = await handlers.get('file:open-dialog')(event);
  assert.equal(chosen[0].data.toString(), 'PKselected');
  assert.equal((await handlers.get('file:read')(event, selected)).data.toString(), 'PKselected');
  assert.equal(opens, 2, 'granted recent paths do not prompt repeatedly');
  assert.equal(await handlers.get('file:save')(event, { path: other, suggestedName: 'other.docx', data: Buffer.from('PKchanged') }), null);
  assert.equal(saves, 1); assert.equal(fs.readFileSync(other, 'utf8'), 'PKother');
  await handlers.get('file:save')(event, { path: selected, suggestedName: 'selected.docx', data: Buffer.from('PKsaved') });
  assert.equal(fs.readFileSync(selected, 'utf8'), 'PKsaved');
  assert.equal(fs.readFileSync(`${selected}.bak`, 'utf8'), 'PKselected');
  await assert.rejects(handlers.get('print:pdf')(event, { html: '<p>test</p>', path: path.join(dir, 'unguarded.pdf') }), /선택한 PDF/);
});
