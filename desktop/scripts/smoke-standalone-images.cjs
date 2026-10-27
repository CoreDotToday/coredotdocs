// Exercise the packaged standalone server without launching Electron or user data.
// The existing DOCX regression checks embedded PNG decode, page snapshots and PDF.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '../..');
const resources = path.resolve(process.argv[2] || path.join(root, 'desktop/dist-next/win-unpacked/resources'));
const out = fs.mkdtempSync(path.join(root, 'desktop/dist/public-readiness/standalone-images-'));
const processes = [];
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
function launch(command, args, options, name) {
  const log = fs.openSync(path.join(out, `${name}.log`), 'w');
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', log, log] });
  child.on('error', (error) => { child.launchError = error; });
  fs.closeSync(log);
  processes.push(child);
  return child;
}
async function healthy(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.launchError) throw child.launchError;
    if (child.exitCode !== null) throw new Error(`Owned test server exited: ${url}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Owned test server did not start: ${url}`);
}

(async () => {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(resources, 'web/.next/required-server-files.json'))).config;
    assert.equal(config.images.unoptimized, true);
    for (const name of ['sharp', '@img']) assert.equal(fs.existsSync(path.join(resources, 'web/node_modules', name)), false, `${name} must not ship`);
    const apiPort = await port();
    let webPort = await port();
    while (webPort === apiPort) webPort = await port();
    const api = `http://127.0.0.1:${apiPort}`, web = `http://127.0.0.1:${webPort}`;
    const backend = launch(path.join(resources, 'backend/editor-server', process.platform === 'win32' ? 'editor-server.exe' : 'editor-server'), [], {
      cwd: out, env: { ...process.env, EDITOR_PORT: String(apiPort), EDITOR_HOST: '127.0.0.1',
        EDITOR_DATABASE_URL: `sqlite:///${path.join(out, 'test.sqlite').replaceAll('\\', '/')}`,
        EDITOR_CORS_ORIGINS: JSON.stringify([web]), EDITOR_LOG_LEVEL: 'warning', EDITOR_NODE_BIN: process.execPath,
        EDITOR_RHWP_DIR: path.join(resources, 'web/public/rhwp-core') },
    }, 'backend');
    await healthy(`${api}/api/health`, backend);
    const frontend = launch(process.execPath, [path.join(resources, 'web/server.js')], {
      cwd: path.join(resources, 'web'), env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(webPort), API_PUBLIC_URL: api, API_INTERNAL_URL: api },
    }, 'frontend');
    await healthy(web, frontend);
    const staticImage = await fetch(`${web}/rhwp/icons/icon-128.png`);
    assert.equal(staticImage.status, 200);
    assert.match(staticImage.headers.get('content-type'), /^image\/png/);
    assert.ok((await staticImage.arrayBuffer()).byteLength > 0);
    const optimizer = await fetch(`${web}/_next/image?url=%2Frhwp%2Ficons%2Ficon-128.png&w=128&q=75`);
    assert.equal(optimizer.status, 404);
    const testConfig = { testDir: path.join(root, 'frontend/e2e'), testMatch: 'docx-print.spec.ts',
      timeout: 90_000, workers: 1, retries: 0, reporter: 'list',
      outputDir: path.join(out, 'results'), use: { baseURL: web, locale: 'ko-KR', headless: true } };
    const configPath = path.join(out, 'playwright.config.cjs');
    fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(testConfig, null, 2)};\nmodule.exports.grep = /embeds images/;\n`);
    const runner = launch(process.execPath, [path.join(root, 'frontend/node_modules/@playwright/test/cli.js'), 'test', '--config', configPath], {
      cwd: path.join(root, 'frontend'), env: { ...process.env, EDITOR_E2E_API_URL: api },
    }, 'e2e');
    const [code] = await once(runner, 'exit');
    assert.equal(code, 0, `DOCX image/PDF regression failed; see ${out}`);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: true, optimizerStatus: 404, staticImageStatus: 200, embeddedDocxImagePdfE2E: 'passed' }, null, 2));
    console.log(`Standalone static/dynamic DOCX images/PDF passed with sharp absent: ${out}`);
  } finally {
    // Stop only servers created by this invocation, never existing user apps.
    for (const child of processes.reverse()) if (child.exitCode === null) child.kill();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
