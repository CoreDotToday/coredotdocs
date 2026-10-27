// Windows packaged-app smoke test. Requires frontend's Playwright dependency.
// node desktop/scripts/smoke-app-win.cjs [path/to/coredotdocs.exe]
// Keeps its isolated profile, sample documents, screenshot and report under desktop/dist/smoke-*.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const desktop = path.resolve(__dirname, '..');
const frontendRequire = createRequire(path.join(desktop, '..', 'frontend', 'package.json'));
const { _electron } = frontendRequire('@playwright/test');
const executable = path.resolve(process.argv[2] || path.join(desktop, 'dist', 'win-unpacked', 'coredotdocs.exe'));
const resources = path.join(path.dirname(executable), 'resources');
const sidecar = path.join(resources, 'backend', 'editor-server', '_internal', 'app', 'engine', 'rhwp_convert.mjs');
const engine = path.join(resources, 'web', 'public', 'rhwp-core');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(work, ms, label, startupFailure) {
  const deadline = Date.now() + ms;
  let lastError;
  while (Date.now() < deadline) {
    const startupError = startupFailure?.();
    if (startupError) throw new Error(startupError);
    try {
      const result = await work();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ''}`);
}

async function request(url, options = {}, status = 200, timeout = 10000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  if (response.status !== status) {
    throw new Error(`${options.method || 'GET'} ${url}: expected ${status}, got ${response.status}: ${(await response.text()).slice(0, 1500)}`);
  }
  return response;
}

function checkLocalUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port, 'Server URL must include its actual port');
  return url.origin;
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke test requires Windows');
  for (const file of [executable, sidecar, path.join(engine, 'rhwp.js'), path.join(engine, 'rhwp_bg.wasm')]) {
    assert.ok(fs.existsSync(file), `Missing packaged file: ${file}`);
  }
  for (const file of ['node_modules/next/dist/compiled/tar', 'node_modules/next/dist/lib/download-swc.js', 'node_modules/next/dist/lib/download-swc.js.map']) {
    assert.ok(!fs.existsSync(path.join(resources, 'web', file)), `Build-only dependency must not ship: ${file}`);
  }
  fs.mkdirSync(path.join(desktop, 'dist'), { recursive: true });
  const output = fs.mkdtempSync(path.join(desktop, 'dist', 'smoke-'));
  const userData = path.join(output, 'user-data');
  fs.mkdirSync(userData);
  const report = { executable, output, userData, startedAt: new Date().toISOString(), checks: [], cleanupErrors: [] };
  let application;
  let processHandle;
  let api;
  let failure;
  let processLog = '';
  const documents = new Set();
  const pageErrors = [];
  const passed = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
  const apiRequest = (route, options, status, timeout) => request(`${api}${route}`, options, status, timeout);
  const jsonPost = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const marker = 'Windows smoke 한글 문서 hello';

  const notices = path.join(resources, 'licenses');
  assert.match(fs.readFileSync(path.join(notices, 'LICENSE'), 'utf8'), /Apache License/);
  assert.match(fs.readFileSync(path.join(notices, 'NOTICE'), 'utf8'), /CoreDotToday/);
  for (const vendor of ['genoffice-docx', 'ieumoffice-hwp']) {
    assert.ok(fs.readFileSync(path.join(notices, 'third_party', vendor, 'NOTICE'), 'utf8').trim());
    assert.ok(fs.readFileSync(path.join(notices, 'third_party', vendor, 'LICENSE'), 'utf8').trim());
  }
  assert.match(fs.readFileSync(path.join(notices, 'third_party', 'rhwp', 'LICENSE-core.txt'), 'utf8'), /MIT/);
  assert.match(fs.readFileSync(path.join(notices, 'third_party', 'emf-converter', 'LICENSE'), 'utf8'), /Apache License/);
  const thirdParty = JSON.parse(fs.readFileSync(path.join(resources, 'third-party-manifest.json'), 'utf8'));
  assert.equal(thirdParty.schemaVersion, 1);
  for (const required of ['next', '@tiptap/core', 'CPython']) {
    assert.ok(thirdParty.packages.some((entry) => entry.name === required), `Missing packaged attribution: ${required}`);
  }
  assert.ok(!thirdParty.packages.some((entry) => /^psycopg(?:[-_]|$)/i.test(entry.name)), 'Unused PostgreSQL driver must not ship');
  for (const entry of thirdParty.packages) {
    assert.ok(entry.licenseFiles.length, `Missing license text: ${entry.name}`);
    for (const file of entry.licenseFiles) {
      const target = path.resolve(resources, file.path);
      assert.ok(target.startsWith(resources + path.sep), 'License path must stay inside packaged resources');
      assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'), file.sha256);
    }
  }
  const aggregate = fs.readFileSync(path.join(resources, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  for (const required of ['Vercel', 'Tiptap GmbH', 'PYTHON SOFTWARE FOUNDATION LICENSE', 'FreeType']) assert.ok(aggregate.includes(required));
  passed('bundled application and editor license notices');

  async function deleteDocument(id) {
    await apiRequest(`/api/documents/${id}`, { method: 'DELETE' }, 204);
    documents.delete(id);
    await apiRequest(`/api/documents/${id}`, {}, 404);
  }

  try {
    const env = { ...process.env, CDD_TEST_AUTO_CLOSE: '1' };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
    }
    application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], cwd: path.dirname(executable), env, timeout: 90000 });
    application.on('window', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
    processHandle = application.process();
    const capture = (chunk) => { processLog = (processLog + chunk.toString()).slice(-65536); };
    processHandle.stdout?.on('data', capture);
    processHandle.stderr?.on('data', capture);
    const appState = await bounded(application.evaluate(({ app }) => ({ userData: app.getPath('userData'), pid: process.pid })), 10000, 'Read app state');
    const actualUserData = appState.userData;
    report.actualUserData = actualUserData;
    report.appPid = appState.pid;
    assert.equal(path.resolve(actualUserData).toLowerCase(), path.resolve(userData).toLowerCase(), 'App must use the isolated profile before any API test');
    passed('isolated userData');

    const statePath = path.join(userData, 'server.json');
    const state = await waitFor(() => fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, 'utf8')), 70000, 'Server state');
    assert.equal(state.pid, appState.pid, 'State file must belong to this launched app');
    assert.equal(state.version, require(path.join(desktop, 'package.json')).version, 'Packaged app version must match release metadata');
    api = checkLocalUrl(state.api_url);
    const web = checkLocalUrl(state.web_url);
    report.api = api;
    report.web = web;
    const startupFailure = () => {
      const logPath = path.join(userData, 'editor.log');
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      return /(?:웹 서버|백엔드) 종료 \((?!0\))/.test(log) ? `Packaged server exited during startup:\n${log.slice(-5000)}` : null;
    };
    await waitFor(async () => (await (await request(`${api}/api/health`, {}, 200, 2000)).json()).ok === true, 70000, 'Backend health', startupFailure);
    passed('packaged backend health');
    const webHtml = await waitFor(async () => (await request(web, {}, 200, 3000)).text(), 70000, 'Web server', startupFailure);
    assert.match(webHtml, /<html/i);
    passed('packaged web server');
    assert.deepEqual(await (await apiRequest('/api/documents')).json(), [], 'Isolated database should start empty');

    const page = await application.firstWindow({ timeout: 70000 });
    await page.waitForFunction(() => Boolean(window.coredotdocs) && document.body.innerText.trim().length > 0, undefined, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.coredotdocs.version), require(path.join(desktop, 'package.json')).version, 'Main-frame preload IPC must receive the app version');
    await page.getByRole('button', { name: 'Claude Desktop에 연결…' }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(new URL(page.url()).origin, web);
    report.windowTitle = await page.title();
    report.screenshot = path.join(output, 'app.png');
    await page.screenshot({ path: report.screenshot, timeout: 15000 });
    passed('Electron window and preload');

    const nativeHelp = await application.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu().items.find((item) => item.label === '도움말');
      const guide = menu.submenu.items.find((item) => item.label === '코어닷독스 도움말');
      guide.click();
      return { labels: menu.submenu.items.map((item) => item.label), accelerator: guide.accelerator };
    });
    assert.equal(nativeHelp.accelerator, 'F1');
    assert.ok(!nativeHelp.labels.some((label) => /rhwp/i.test(label)));
    const help = page.getByRole('dialog', { name: '코어닷독스 사용 안내' });
    await help.waitFor({ state: 'visible' });
    assert.ok(!(await help.innerText()).toLowerCase().includes('rhwp'));
    await help.getByLabel('도움말 검색').fill('존재하지않는검색어123');
    await help.getByText('일치하는 도움말이 없습니다.').waitFor({ state: 'visible' });
    await help.getByLabel('도움말 검색').fill('저장');
    await help.getByRole('heading', { name: /검색 결과/ }).waitFor({ state: 'visible' });
    await help.getByRole('button', { name: /열기와 저장/ }).last().click();
    await help.getByRole('heading', { name: '열기와 저장', exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(output, 'help-guide.png') });
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === '도움말').submenu.items.find((item) => item.label === '코어닷독스 정보').click());
    await help.getByRole('heading', { name: '코어닷독스 정보', exact: true }).waitFor({ state: 'visible' });
    assert.ok((await help.innerText()).includes(state.version));
    assert.equal(await help.getByRole('link', { name: /GitHub 릴리스 및 변경/ }).getAttribute('href'), 'https://github.com/CoreDotToday/coredotdocs/releases');
    await page.screenshot({ path: path.join(output, 'help-about.png') });
    await page.keyboard.press('Escape');
    await help.waitFor({ state: 'detached' });
    passed('native help menu, search, version, GitHub release link and Escape');

    let hwpxFile;
    for (const format of ['hwpx', 'docx']) {
      const created = await (await apiRequest('/api/documents/new', jsonPost({ title: `Windows smoke ${format}`, markdown: marker, format }), 201)).json();
      assert.ok(created.id);
      documents.add(created.id);
      assert.equal(created.format, format);
      const read = await (await apiRequest(`/api/documents/${created.id}/read`)).json();
      assert.ok(read.text.includes(marker), `${format} text must round-trip`);
      const bytes = Buffer.from(await (await apiRequest(`/api/documents/${created.id}/download`)).arrayBuffer());
      assert.equal(bytes.subarray(0, 2).toString(), 'PK');
      const sample = path.join(output, `sample.${format}`);
      fs.writeFileSync(sample, bytes);
      if (format === 'hwpx') hwpxFile = sample;
      await deleteDocument(created.id);
      passed(`${format.toUpperCase()} create/read/download/delete`);
    }

    const hwpFile = path.join(output, 'roundtrip.hwp');
    const conversion = await runFile(executable, [sidecar, engine, 'hwp', hwpxFile, hwpFile], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: output, windowsHide: true, timeout: 65000, maxBuffer: 1024 * 1024,
    });
    report.sidecarOutput = conversion.stdout.trim();
    const hwp = fs.readFileSync(hwpFile);
    assert.deepEqual(hwp.subarray(0, 4), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    passed('bundled Electron/sidecar HWP export');
    const form = new FormData();
    form.append('file', new Blob([hwp], { type: 'application/x-hwp' }), 'roundtrip.hwp');
    const converted = await (await apiRequest('/api/documents', { method: 'POST', body: form }, 201, 70000)).json();
    assert.ok(converted.id);
    documents.add(converted.id);
    assert.equal(converted.format, 'hwpx');
    const convertedRead = await (await apiRequest(`/api/documents/${converted.id}/read`)).json();
    assert.ok(convertedRead.text.includes(marker), 'HWP upload conversion must preserve Korean and English text');
    const metadata = await (await apiRequest(`/api/documents/${converted.id}`)).json();
    assert.ok(metadata.filename.endsWith('.hwpx'));
    const convertedBytes = Buffer.from(await (await apiRequest(`/api/documents/${converted.id}/download`)).arrayBuffer());
    assert.equal(convertedBytes.subarray(0, 2).toString(), 'PK');
    await deleteDocument(converted.id);
    passed('packaged backend HWP upload/conversion/read/download/delete');

    const printDocs = [];
    for (const [title, markdown] of [['Hidden print fixture', 'THIS_MUST_NOT_BE_PRINTED'], ['Visible print fixture', 'ONLY_THIS_DOCUMENT_PRINTS']]) {
      const created = await (await apiRequest('/api/documents/new', jsonPost({ title, markdown, format: 'docx' }), 201)).json();
      documents.add(created.id);
      printDocs.push(created.id);
      await page.goto(`${web}/documents/${created.id}`);
      await page.locator(`[data-cdd-doc="${created.id}"]`).waitFor({ state: 'visible' });
      await page.locator(`[data-cdd-doc="${created.id}"][data-ready="1"]`).waitFor({ timeout: 30000 });
    }
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.getByTestId(`docview-${printDocs[0]}`).evaluate((element) => getComputedStyle(element).display), 'none');
    assert.notEqual(await page.getByTestId(`docview-${printDocs[1]}`).evaluate((element) => getComputedStyle(element).display), 'none');
    await page.emulateMedia({ media: null });
    const pdfPath = path.join(output, 'current-document.pdf');
    await application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, pdfPath);
    const pdfResult = await page.evaluate(async (id) => {
      const html = await window.__coredotdocs.printHtml(id);
      if (!html.includes('ONLY_THIS_DOCUMENT_PRINTS') || html.includes('THIS_MUST_NOT_BE_PRINTED')) throw new Error('Print document must contain only the selected tab');
      return window.coredotdocs.printToPdf({ html, suggestedName: 'current-document.pdf' });
    }, printDocs[1]);
    assert.equal(path.resolve(pdfResult.path), pdfPath);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');
    // This fixture is exactly one page; Chromium writes page dictionaries outside object streams.
    assert.equal((fs.readFileSync(pdfPath).toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1, 'One-page DOCX must not add blank PDF pages');
    report.pdf = pdfPath;
    await page.evaluate((ids) => ids.forEach((id) => window.__coredotdocs.workspace.close(id)), printDocs);
    for (const id of printDocs) await deleteDocument(id);
    passed('DOCX PDF export and inactive-document print isolation');
    assert.deepEqual(await (await apiRequest('/api/documents')).json(), []);
    assert.deepEqual(pageErrors, [], 'Renderer should not report uncaught exceptions during smoke');
  } catch (error) {
    failure = error;
    report.error = error.stack || String(error);
  } finally {
    for (const id of documents) {
      try { await apiRequest(`/api/documents/${id}`, { method: 'DELETE' }, 204, 3000); }
      catch (error) { report.cleanupErrors.push(error.message); }
    }
    if (application) {
      try { await bounded(application.close(), 15000, 'Close Electron'); }
      catch (error) {
        report.cleanupErrors.push(error.message);
        if (process.env.CDD_TEST_NO_FORCE_KILL !== '1' && processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
          try { await runFile('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); }
          catch (killError) { report.cleanupErrors.push(killError.message); }
        }
      }
    }
    report.finishedAt = new Date().toISOString();
    report.ok = !failure && report.cleanupErrors.length === 0;
    report.pageErrors = pageErrors;
    fs.writeFileSync(path.join(output, 'process.log'), processLog);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Smoke report: ${path.join(output, 'report.json')}`);
  }
  if (failure) throw failure;
  assert.equal(report.cleanupErrors.length, 0, `Cleanup failed: ${report.cleanupErrors.join('; ')}`);
  console.log('Windows packaged-app smoke OK');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
