// Exercise the packaged --mcp executable over standard newline-delimited JSON-RPC.
// node desktop/scripts/smoke-mcp-win.cjs [path/to/coredotdocs.exe]
// Uses only generated documents and an isolated database; no external AI configuration or key.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const desktop = path.resolve(__dirname, '..');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const executable = path.resolve(process.argv[2] || path.join(desktop, 'dist', 'win-unpacked', 'coredotdocs.exe'));
const backendDirectory = path.join(path.dirname(executable), 'resources', 'backend', 'editor-server');
const backendExecutable = path.join(backendDirectory, 'editor-server.exe');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]);
  } finally { clearTimeout(timer); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startChild(args, env, logFile) {
  const child = spawn(backendExecutable, args, { cwd: backendDirectory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-65536); });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const process = { child, exited, exitResult: null, saveLog: () => fs.writeFileSync(logFile, stderr), stderr: () => stderr };
  exited.then((result) => { process.exitResult = result; });
  return process;
}

class McpClient {
  constructor(process) {
    this.process = process;
    this.pending = new Map();
    this.nextId = 1;
    this.transcript = [];
    process.child.stdin.on('error', (error) => this.fail(error));
    const lines = readline.createInterface({ input: process.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error(`MCP stdout contained a non-JSON line: ${line.slice(0, 200)}`)); return; }
      this.transcript.push({ receive: message });
      if (!Object.hasOwn(message, 'id')) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    process.exited.then((result) => this.fail(new Error(`MCP process exited: ${JSON.stringify(result)}`)));
  }

  fail(error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }

  notify(method, params = {}) {
    const message = { jsonrpc: '2.0', method, params };
    this.transcript.push({ send: message });
    this.process.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    this.transcript.push({ send: message });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.child.stdin.write(JSON.stringify(message) + '\n', (error) => { if (error) this.fail(error); });
    });
  }

  call(name, arguments_) { return this.request('tools/call', { name, arguments: arguments_ }); }
}

function toolText(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.content), 'MCP tool content missing');
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(fs.existsSync(backendExecutable), `Missing packaged backend: ${backendExecutable}`);
  fs.mkdirSync(path.join(desktop, 'dist'), { recursive: true });
  const output = fs.mkdtempSync(path.join(desktop, 'dist', 'mcp-smoke-'));
  const report = { output, backendExecutable, startedAt: new Date().toISOString(), checks: [], cleanupErrors: [] };
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['CDT_API_KEY', 'EDITOR_CDT_API_KEY', 'EDITOR_API_URL', 'EDITOR_STATE_FILE', 'EDITOR_AI_TOKEN'].includes(key.toUpperCase())) delete env[key];
  }
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  Object.assign(env, {
    EDITOR_HOST: '127.0.0.1', EDITOR_PORT: String(port), EDITOR_DATABASE_URL: `sqlite:///${path.join(output, 'test.db')}`,
    EDITOR_ALLOW_ANONYMOUS_TOOLS: 'false', EDITOR_LOG_LEVEL: 'warning',
    EDITOR_NODE_BIN: executable, EDITOR_RHWP_DIR: path.join(path.dirname(executable), 'resources', 'web', 'public', 'rhwp-core'),
  });
  const backend = startChild([], env, path.join(output, 'backend.log'));
  backend.child.stdout.resume();
  let bridge;
  let client;
  let failure;
  const documents = [];
  const passed = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
  async function apiRequest(route, options = {}, status = 200) {
    const response = await fetch(api + route, { ...options, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, status, `${route}: ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  }
  const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await bounded((async () => {
      while (true) {
        if (backend.exitResult) throw new Error(`Packaged backend exited: ${JSON.stringify(backend.exitResult)} ${backend.stderr()}`);
        try { if ((await apiRequest('/api/health')).ok === true) return; } catch { /* wait for bind */ }
        await delay(300);
      }
    })(), 60000, 'Packaged backend startup');
    passed('isolated packaged backend with token-required tools');
    for (const format of ['hwpx', 'docx']) {
      const document = await apiRequest('/api/documents/new', post({ title: `MCP ${format} smoke`, format, markdown: 'BUNDLED_MCP_BEFORE 한글\n\nUNCHANGED' }), 201);
      documents.push(document);
    }
    const session = await apiRequest('/api/ai/sessions', post({ name: 'packaged-mcp-smoke', document_ids: documents.map((document) => document.id) }), 201);
    assert.equal(typeof session.token, 'string');
    const stateFile = path.join(output, 'server.json');
    fs.writeFileSync(stateFile, JSON.stringify({ api_url: api }));
    bridge = startChild(['--mcp'], { ...env, EDITOR_STATE_FILE: stateFile, EDITOR_AI_TOKEN: session.token }, path.join(output, 'mcp-stderr.log'));
    client = new McpClient(bridge);
    const initialized = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coredotdocs-release-smoke', version: '1.0.0' } });
    assert.equal(initialized.protocolVersion, '2025-06-18');
    assert.equal(initialized.serverInfo.name, 'coredotdocs');
    assert.equal(initialized.serverInfo.version, expectedVersion, 'Packaged MCP version must match the release');
    assert.ok(initialized.capabilities.tools);
    report.serverInfo = initialized.serverInfo;
    client.notify('notifications/initialized');
    assert.deepEqual(await client.request('ping'), {});
    const listed = await client.request('tools/list');
    assert.ok(Array.isArray(listed.tools));
    for (const name of ['list_documents', 'read_document', 'replace_text', 'undo_last_edit']) assert.ok(listed.tools.some((tool) => tool.name === name), `Missing MCP tool ${name}`);
    assert.equal(listed.tools.find((tool) => tool.name === 'read_document').title, '문서 읽기', 'MCP must emit UTF-8 Korean JSON');
    report.toolCount = listed.tools.length;
    passed('stdio initialize/initialized/ping/tools-list and UTF-8');
    const listing = toolText(await client.call('list_documents', {}));
    for (const document of documents) assert.ok(listing.includes(document.id));
    passed('authenticated MCP list_documents through state-file discovery');
    for (const document of documents) {
      const baseline = await apiRequest(`/api/documents/${document.id}/read`);
      const read = toolText(await client.call('read_document', { document_id: document.id }));
      assert.ok(read.includes('BUNDLED_MCP_BEFORE 한글'));
      toolText(await client.call('replace_text', { document_id: document.id, find: 'BUNDLED_MCP_BEFORE', replace: 'BUNDLED_MCP_AFTER', expected_revision: baseline.revision_seq }));
      const edited = toolText(await client.call('read_document', { document_id: document.id }));
      assert.ok(edited.includes('BUNDLED_MCP_AFTER 한글') && !edited.includes('BUNDLED_MCP_BEFORE'));
      assert.equal((await apiRequest(`/api/documents/${document.id}/read`)).text, baseline.text.replace('BUNDLED_MCP_BEFORE', 'BUNDLED_MCP_AFTER'));
      toolText(await client.call('undo_last_edit', { document_id: document.id, steps: 1 }));
      assert.equal((await apiRequest(`/api/documents/${document.id}/read`)).text, baseline.text);
      passed(`${document.format.toUpperCase()} MCP read/edit/readback/undo`);
    }
  } catch (error) { failure = error; report.error = error.stack || String(error); }
  finally {
    if (bridge) {
      bridge.child.stdin.end();
      try { assert.equal((await bounded(bridge.exited, 5000, 'MCP stdin-EOF shutdown')).code, 0); }
      catch (error) {
        report.cleanupErrors.push(error.message);
        if (!bridge.exitResult && bridge.child.pid) bridge.child.kill();
        try { await bounded(bridge.exited, 3000, 'Test MCP child cleanup'); }
        catch (cleanupError) { report.cleanupErrors.push(cleanupError.message); }
      }
      bridge.saveLog();
    }
    for (const document of documents) {
      try { await apiRequest(`/api/documents/${document.id}`, { method: 'DELETE' }, 204); }
      catch (error) { report.cleanupErrors.push(error.message); }
    }
    // This PID is the isolated backend spawned by this harness, never a user app.
    if (backend.child.exitCode === null && backend.child.signalCode === null) backend.child.kill();
    try { await bounded(backend.exited, 5000, 'Isolated backend shutdown'); }
    catch (error) { report.cleanupErrors.push(error.message); }
    backend.saveLog();
    if (client) fs.writeFileSync(path.join(output, 'mcp-transcript.json'), JSON.stringify(client.transcript, null, 2));
    report.finishedAt = new Date().toISOString();
    report.ok = !failure && report.cleanupErrors.length === 0;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`MCP smoke report: ${path.join(output, 'report.json')}`);
  }
  if (failure) throw failure;
  assert.deepEqual(report.cleanupErrors, []);
  console.log('Windows packaged MCP smoke OK');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
