// coredotdocs 데스크톱 셸.
// 앱 안의 백엔드(PyInstaller editor-server, SQLite)와 Next 서버(standalone server.js, Electron의 Node로 실행)를 띄우고
// 창에 http://127.0.0.1:<포트>를 연다. 파일 열기/저장·메뉴·파일 연결·AI 앱 등록은 여기(메인)가 맡고, 화면은 preload의
// window.coredotdocs 로 부탁한다.
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, utilityProcess } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { installedFonts } = require("./fonts");
const { trustedSender, permittedPermission, FileGrants } = require("./security");

app.setName("coredotdocs");

const PREFERRED = { api: 47371, web: 47370 };
const MAX_FILE = 50 * 1024 * 1024;
const FILE_FILTERS = [
  { name: "문서 (HWPX, HWP, DOCX)", extensions: ["hwpx", "hwp", "docx"] },
  { name: "한글 문서 (HWPX)", extensions: ["hwpx"] },
  { name: "옛 한글 문서 (HWP)", extensions: ["hwp"] },
  { name: "Word 문서 (DOCX)", extensions: ["docx"] },
];
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "resources");
const backendDir = path.join(resources, "backend", "editor-server");
const backendBin = path.join(backendDir, process.platform === "win32" ? "editor-server.exe" : "editor-server");
const webDir = path.join(resources, "web");

let backend = null;
let web = null;
let log = null;
let win = null;
let servers = null;
let dirty = false;
let rendererReady = false;
let stoppingServers = false;
let serverFailure = null;
const pendingFiles = [];

function handleIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, win, servers?.webUrl)) throw new Error("허용되지 않은 화면의 요청입니다.");
    return handler(event, ...args);
  });
}
function onIpc(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!trustedSender(event, win, servers?.webUrl)) { event.returnValue = null; return; }
    return handler(event, ...args);
  });
}

// ───────────────────────────── 서버 ─────────────────────────────

function freePort(preferred) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once("error", () => (port ? tryPort(0) : resolve(0)));
      srv.listen(port, "127.0.0.1", () => {
        const chosen = srv.address().port;
        srv.close(() => resolve(chosen));
      });
    };
    tryPort(preferred);
  });
}

function waitHttp(url, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      if (serverFailure) return reject(serverFailure);
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error(`${label}이(가) ${timeoutMs / 1000}초 안에 응답하지 않습니다 (${url}). 로그: ${logPath()}`));
      setTimeout(probe, 300);
    };
    probe();
  });
}

const userData = () => app.getPath("userData");
const logPath = () => path.join(userData(), "editor.log");
const stateFile = () => path.join(userData(), "server.json");

function writeLog(message) {
  if (log && !log.destroyed && !log.writableEnded) log.write(message);
}

function serverFailed(label, detail) {
  if (stoppingServers || serverFailure) return;
  serverFailure = new Error(`${label}: ${detail}\n로그: ${logPath()}`);
  writeLog(`${serverFailure.message}\n`);
  // Startup failures are reported by startServers. Once running, keep the editor
  // open and make a lost child process visible instead of failing silently.
  if (servers && win && !win.isDestroyed()) dialog.showErrorBox("내장 서버 연결이 끊겼습니다", serverFailure.message);
}

async function startServers() {
  stoppingServers = false;
  serverFailure = null;
  fs.mkdirSync(userData(), { recursive: true });
  log = fs.createWriteStream(logPath(), { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} 시작 (v${app.getVersion()})\n`);
  if (!fs.existsSync(backendBin)) throw new Error(`백엔드 실행 파일이 없습니다: ${backendBin}`);
  if (!fs.existsSync(path.join(webDir, "server.js"))) throw new Error(`웹 서버 파일이 없습니다: ${webDir}`);

  const apiPort = await freePort(PREFERRED.api);
  const webPort = await freePort(PREFERRED.web);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const dbPath = path.join(userData(), "editor.db");

  backend = spawn(backendBin, [], {
    cwd: backendDir,
    windowsHide: true,
    // EDITOR_NODE_BIN/EDITOR_RHWP_DIR: 백엔드의 rhwp 사이드카(옛 HWP → HWPX)가 Electron을 Node로 쓰고 번들된 엔진을 읽는다
    env: { ...process.env, EDITOR_HOST: "127.0.0.1", EDITOR_PORT: String(apiPort), EDITOR_DATABASE_URL: `sqlite:///${dbPath}`, EDITOR_CORS_ORIGINS: JSON.stringify([webUrl]), EDITOR_LOG_LEVEL: "warning", EDITOR_NODE_BIN: process.execPath, EDITOR_RHWP_DIR: path.join(resources, "web", "public", "rhwp-core") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.pipe(log, { end: false });
  backend.stderr.pipe(log, { end: false });
  backend.on("error", (error) => serverFailed("백엔드를 실행하지 못했습니다", error.message));
  backend.on("exit", (code) => {
    writeLog(`백엔드 종료 (${code})\n`);
    serverFailed("백엔드가 종료됐습니다", `종료 코드 ${code}`);
  });

  // 외부 AI 앱(MCP)은 포트가 바뀌어도 되도록 주소를 굳히지 않고 상태 파일 경로만 받는다 (editor-server --mcp 가 읽는다)
  const mcpCommand = { command: backendBin, args: ["--mcp"], env: { EDITOR_STATE_FILE: stateFile() } };
  fs.writeFileSync(stateFile(), JSON.stringify({ api_url: apiUrl, web_url: webUrl, pid: process.pid, version: app.getVersion(), started_at: new Date().toISOString() }, null, 2), { mode: 0o600 });

  web = utilityProcess.fork(path.join(webDir, "server.js"), [], {
    cwd: webDir,
    env: { ...process.env, NODE_ENV: "production", PORT: String(webPort), HOSTNAME: "127.0.0.1", API_INTERNAL_URL: apiUrl, API_PUBLIC_URL: apiUrl, MCP_COMMAND: JSON.stringify(mcpCommand) },
    stdio: "pipe",
  });
  web.stdout?.on("data", writeLog);
  web.stderr?.on("data", writeLog);
  web.on("exit", (code) => {
    writeLog(`웹 서버 종료 (${code})\n`);
    serverFailed("웹 서버가 종료됐습니다", `종료 코드 ${code}`);
  });

  await waitHttp(`${apiUrl}/api/health`, 60_000, "백엔드");
  await waitHttp(webUrl, 60_000, "웹 서버");
  return { apiUrl, webUrl, mcpCommand };
}

function stopServers() {
  stoppingServers = true;
  backend?.stdout?.unpipe(log);
  backend?.stderr?.unpipe(log);
  for (const p of [backend, web]) {
    try {
      p?.kill();
    } catch {}
  }
  backend = web = null;
  try {
    fs.rmSync(stateFile(), { force: true });
  } catch {}
  log?.end();
}

// ───────────────────────────── 창 ─────────────────────────────

function createWindow(webUrl) {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    title: "Core.Docs",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 네비게이션 가드: 창은 우리 웹 서버만 보여 준다. 새 창은 열지 않고 http(s)만 바깥 브라우저로 넘긴다. (설계 문서 04 §2 A12)
  const origin = new URL(webUrl).origin;
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== origin) e.preventDefault();
  });
  win.webContents.on("will-frame-navigate", (e) => {
    if (new URL(e.url).origin !== origin) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 저장 안 된 문서가 있으면 렌더러의 beforeunload가 닫기를 막는다(웹판과 같은 보호). 그때 여기서 한 번 묻고,
  // "닫기"면 그 막음을 풀어 준다(preventDefault = 그대로 내린다). 묻는 곳은 여기 하나다 — close 이벤트에서 따로 물으면
  // "닫기"를 눌러도 뒤이어 beforeunload가 또 막아 창이 안 닫힌다.
  win.webContents.on("will-prevent-unload", (e) => {
    if (win.__forceClose) return e.preventDefault();
    if (process.env.CDD_TEST_AUTO_CLOSE === "1") {
      // 자동 점검용(scripts/smoke-app.sh·CDP 검사): 네이티브 대화상자는 누를 수 없으니 "닫기"로 답한 셈 친다
      win.__forceClose = true;
      return e.preventDefault();
    }
    const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["닫기", "취소"], defaultId: 1, cancelId: 1, message: "저장하지 않은 문서가 있습니다.", detail: "저장하지 않은 변경은 사라질 수 있습니다. 내용을 보관하려면 취소한 뒤 저장하세요." });
    if (r === 0) {
      win.__forceClose = true;
      e.preventDefault();
    }
  });
  win.on("closed", () => (win = null));
  win.loadURL(webUrl);
  return win;
}

function sendMenu(id) {
  win?.webContents.send("menu", id);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ label: "코어닷독스 정보", click: () => sendMenu("help:about") }, { type: "separator" }, { role: "services", label: "서비스" }, { type: "separator" }, { role: "hide", label: "Core.Docs 가리기" }, { role: "hideOthers", label: "기타 가리기" }, { role: "unhide", label: "모두 보기" }, { type: "separator" }, { role: "quit", label: "Core.Docs 종료" }] }]
      : []),
    {
      label: "파일",
      submenu: [
        { label: "새 문서", accelerator: "CmdOrCtrl+N", click: () => sendMenu("file:new") },
        { label: "새 Word 문서", click: () => sendMenu("file:new-docx") },
        { label: "열기…", accelerator: "CmdOrCtrl+O", click: () => sendMenu("file:open") },
        { label: "최근 문서", role: "recentDocuments", submenu: [{ label: "목록 지우기", role: "clearRecentDocuments" }] },
        { type: "separator" },
        { label: "저장", accelerator: "CmdOrCtrl+S", click: () => sendMenu("file:save") },
        { label: "다른 이름으로 저장…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenu("file:save-as") },
        { type: "separator" },
        { label: "PDF로 저장…", click: () => sendMenu("file:export-pdf") },
        { label: "인쇄…", accelerator: "CmdOrCtrl+P", click: () => sendMenu("file:print") },
        { label: "편집 용지…", accelerator: "F7", click: () => sendMenu("file:page-setup") },
        { type: "separator" },
        { label: "탭 닫기", accelerator: "CmdOrCtrl+W", click: () => sendMenu("file:close-tab") },
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit", label: "끝내기" }]),
      ],
    },
    {
      label: "편집",
      submenu: [
        { role: "undo", label: "실행 취소" },
        { role: "redo", label: "다시 실행" },
        { type: "separator" },
        { role: "cut", label: "잘라내기" },
        { role: "copy", label: "복사" },
        { role: "paste", label: "붙여넣기" },
        { role: "selectAll", label: "모두 선택" },
        { type: "separator" },
        { label: "AI 편집 되돌리기", click: () => sendMenu("ai:undo") },
      ],
    },
    {
      label: "보기",
      submenu: [
        { label: "AI 패널 보이기/숨기기", accelerator: "CmdOrCtrl+J", click: () => sendMenu("view:toggle-ai") },
        { type: "separator" },
        { role: "resetZoom", label: "실제 크기" },
        { role: "zoomIn", label: "확대" },
        { role: "zoomOut", label: "축소" },
        { type: "separator" },
        { role: "togglefullscreen", label: "전체 화면" },
        { role: "toggleDevTools", label: "개발자 도구" },
      ],
    },
    {
      label: "AI",
      submenu: [
        { label: "Claude Desktop에 연결…", click: () => sendMenu("ai:connect-claude-desktop") },
        { label: "Claude Code에 연결…", click: () => sendMenu("ai:connect-claude-code") },
        { label: "Codex에 연결…", click: () => sendMenu("ai:connect-codex") },
        { type: "separator" },
        { label: "MCP 설정 보기", click: () => showMcpInfo() },
        { label: "core.today API 키 발급 (웹)", click: () => shell.openExternal("https://console.core.today") },
      ],
    },
    { label: "창", role: "window", submenu: [{ role: "minimize", label: "최소화" }, { role: "zoom", label: "확대/축소" }, ...(isMac ? [{ type: "separator" }, { role: "front", label: "모두 앞으로" }] : [{ role: "close", label: "닫기" }])] },
    {
      label: "도움말",
      role: "help",
      submenu: [
        { label: "코어닷독스 도움말", accelerator: "F1", click: () => sendMenu("help:guide") },
        { label: "단축키 안내", click: () => sendMenu("help:shortcuts") },
        { type: "separator" },
        { label: "코어닷독스 정보", click: () => sendMenu("help:about") },
        { label: "GitHub 릴리스 보기", click: () => shell.openExternal("https://github.com/CoreDotToday/coredotdocs/releases") },
        { type: "separator" },
        { label: "로그 폴더 열기", click: () => shell.showItemInFolder(logPath()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showMcpInfo() {
  const cfg = servers ? JSON.stringify({ mcpServers: { coredotdocs: servers.mcpCommand } }, null, 2) : "(서버가 아직 준비되지 않았습니다)";
  dialog.showMessageBox(win, { type: "info", message: "외부 AI 앱(MCP) 연결 설정", detail: `${cfg}\n\n상태 파일: ${stateFile()}\n(API 주소는 실행마다 바뀔 수 있어 상태 파일로 전달합니다)`, buttons: ["닫기"] });
}

// ───────────────────────────── 파일 ─────────────────────────────

function readFileEntry(filePath) {
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error("일반 문서 파일만 열 수 있습니다.");
  if (st.size > MAX_FILE) throw new Error(`파일이 너무 큽니다 (${Math.round(st.size / 1048576)}MB)`);
  const data = fs.readFileSync(filePath);
  app.addRecentDocument(filePath);
  return { path: filePath, name: path.basename(filePath), data };
}

function queueOpenFiles(paths) {
  const docs = paths.filter((p) => /\.(hwpx|hwp|docx)$/i.test(p) && fs.existsSync(p));
  if (!docs.length) return;
  pendingFiles.push(...docs);
  flushOpenFiles();
}

function flushOpenFiles() {
  if (!rendererReady || !win || !pendingFiles.length) return;
  const batch = pendingFiles.splice(0);
  const files = [];
  for (const p of batch) {
    try {
      files.push(readFileEntry(remember(p)));
    } catch (err) {
      writeLog(`열기 실패 ${p}: ${err}\n`);
    }
  }
  if (files.length) win.webContents.send("open-files", files);
  if (win.isMinimized()) win.restore();
  win.focus();
}

onIpc("app:version", (e) => (e.returnValue = app.getVersion()));
// 설치된 글꼴 — 화면의 queryLocalFonts는 한글 탭이 많으면 줄을 서서 끝나지 않으므로 메인 프로세스가 글꼴 파일을 직접 읽는다 (fonts.js)
handleIpc("fonts:list", () => installedFonts());
handleIpc("file:open-dialog", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters: FILE_FILTERS });
  if (r.canceled) return [];
  return r.filePaths.map((p) => readFileEntry(remember(p)));
});
handleIpc("file:read", async (_e, filePath) => {
  // Recent paths come from renderer storage. Older profiles must grant native
  // access once; future reopens use the main process's persisted grant.
  if (typeof filePath !== "string" || !DOC_EXTS.has(path.extname(filePath).slice(1).toLowerCase())) return null;
  if (!isKnown(filePath)) {
    const selected = await dialog.showOpenDialog(win, { title: "문서 파일을 다시 선택해 주세요", defaultPath: filePath, properties: ["openFile"], filters: FILE_FILTERS });
    if (selected.canceled || !selected.filePaths[0]) return null;
    filePath = remember(selected.filePaths[0]);
  }
  try {
    return readFileEntry(filePath);
  } catch {
    return null;
  }
});
// 저장: 매직 바이트(HWPX/DOCX=ZIP `PK`, HWP=OLE `D0 CF 11 E0`) 검사 → 이 실행에서 처음 덮어쓰는 파일은 `<이름>.bak` 보관(복사 실패 시 저장 중단)
// → 같은 폴더의 임시 파일에 쓴 뒤 rename. 어긋나면 파일을 건드리지 않는다. (설계 문서 04 §2 A3)
const backedUp = new Set();
const MAGIC = { hwpx: [0x50, 0x4b], docx: [0x50, 0x4b], hwp: [0xd0, 0xcf, 0x11, 0xe0], pdf: [0x25, 0x50, 0x44, 0x46] };
const DOC_EXTS = new Set(["hwpx", "hwp", "docx"]);
// 렌더러가 넘긴 경로는 믿지 않는다: 이 실행에서 대화상자·파일 연결·끌어다 놓기·최근 문서로 들어온 경로만 쓰기 대상이 된다
const fileGrants = new FileGrants(path.join(userData(), "file-access.json"));
const remember = (p) => fileGrants.grant(p);
const isKnown = (p) => fileGrants.has(p);
// Only isolated preload calls this using webUtils.getPathForFile(native File).
// Do not expose a renderer API that accepts a path string for this channel.
onIpc("file:grant-native", (event, filePath) => {
  try { event.returnValue = typeof filePath === "string" && DOC_EXTS.has(path.extname(filePath).slice(1).toLowerCase()) && fs.statSync(filePath).isFile() ? remember(filePath) : null; }
  catch { event.returnValue = null; }
});
function looksLike(buf, ext) {
  const sig = MAGIC[ext];
  if (!sig) return true;
  return sig.every((b, i) => buf[i] === b);
}
handleIpc("file:save", async (_e, { data, path: target, suggestedName }) => {
  let filePath = target;
  if (!filePath || !isKnown(filePath)) {
    const ext = (suggestedName.match(/\.(\w+)$/) || [])[1];
    const r = await dialog.showSaveDialog(win, { defaultPath: filePath || path.join(app.getPath("documents"), path.basename(suggestedName)), filters: ext ? [FILE_FILTERS.find((f) => f.extensions.length === 1 && f.extensions[0] === ext.toLowerCase()) || FILE_FILTERS[0]] : FILE_FILTERS });
    if (r.canceled || !r.filePath) return null;
    filePath = remember(r.filePath);
  }
  const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!DOC_EXTS.has(ext)) throw new Error(`문서 파일(HWPX·HWP·DOCX)에만 저장합니다: ${path.basename(filePath)}`);
  if (target && !isKnown(filePath)) throw new Error("이 실행에서 열거나 고른 적 없는 경로에는 쓰지 않습니다. '다른 이름으로 저장'을 쓰세요.");
  if (!buf.length || buf.length > MAX_FILE || !looksLike(buf, ext)) throw new Error(`저장할 내용이 너무 크거나 ${ext.toUpperCase()} 파일 형식이 아니어서 쓰지 않았습니다.`);
  if (fs.existsSync(filePath) && !backedUp.has(filePath)) {
    const bak = `${filePath}.bak`;
    try {
      fs.copyFileSync(filePath, bak);
    } catch (err) {
      throw new Error(`원본 보관본(${path.basename(bak)})을 만들지 못해 저장하지 않았습니다: ${err.message}`);
    }
    backedUp.add(filePath);
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath); // 원본을 반쯤 쓴 상태로 남기지 않는다
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
  app.addRecentDocument(filePath);
  return { path: filePath, name: path.basename(filePath) };
});
// ───────────────────────────── 인쇄·PDF ─────────────────────────────
// 화면이 만든 인쇄용 HTML(쪽마다 @page 크기, CSP로 스크립트·바깥 요청 차단)을 임시 파일로 쓰고 숨은 창에 띄운 뒤
// printToPDF(CSS 용지 크기, 여백 0) 또는 시스템 인쇄 대화상자. 끝나면 창과 임시 파일을 지운다. (설계 문서 04 §2 A6)
const MAX_PRINT_HTML = 200 * 1024 * 1024;
async function withPrintWindow(html, work) {
  if (typeof html !== "string" || !html.length || html.length > MAX_PRINT_HTML) throw new Error("인쇄할 내용이 비었거나 너무 큽니다.");
  const dir = fs.mkdtempSync(path.join(app.getPath("temp"), "coredotdocs-print-"));
  const file = path.join(dir, "print.html");
  fs.writeFileSync(file, html);
  const pw = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, backgroundThrottling: false } });
  try {
    pw.webContents.on("will-navigate", (e) => e.preventDefault());
    pw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await pw.loadFile(file);
    return await work(pw);
  } finally {
    if (!pw.isDestroyed()) pw.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
handleIpc("print:pdf", async (_e, { html, currentDocument, suggestedName, path: target }) => {
  let filePath = target;
  if (!filePath) {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), suggestedName || "문서.pdf"), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (r.canceled || !r.filePath) return null;
    filePath = remember(r.filePath);
  }
  if (path.extname(filePath).toLowerCase() !== ".pdf") throw new Error("PDF 파일(.pdf)로만 저장합니다.");
  if (target && !isKnown(filePath)) throw new Error("파일 대화상자에서 선택한 PDF 경로에만 저장합니다.");
  const pdfOptions = { preferCSSPageSize: true, printBackground: true, margins: { marginType: "none" } };
  if (currentDocument === true && (!win || win.isDestroyed())) throw new Error("인쇄할 문서 창이 없습니다.");
  const pdf = currentDocument === true
    ? await win.webContents.printToPDF(pdfOptions)
    : await withPrintWindow(html, (pw) => pw.webContents.printToPDF(pdfOptions));
  if (!pdf.length || pdf.subarray(0, 4).toString() !== "%PDF") throw new Error("PDF를 만들지 못했습니다.");
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, pdf);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { path: filePath, name: path.basename(filePath) };
});
handleIpc("print:html", async (_e, { html, title }) => {
  // macOS의 인쇄 시트는 보이는 창에 붙으므로, 쪽을 보여 주는 '인쇄 미리보기' 창에서 시스템 인쇄 대화상자를 연다
  if (typeof html !== "string" || !html.length || html.length > MAX_PRINT_HTML) throw new Error("인쇄할 내용이 비었거나 너무 큽니다.");
  const dir = fs.mkdtempSync(path.join(app.getPath("temp"), "coredotdocs-print-"));
  const file = path.join(dir, "print.html");
  fs.writeFileSync(file, html);
  const pw = new BrowserWindow({ show: false, width: 900, height: 1100, parent: win || undefined, title: `${title || "문서"} — 인쇄 미리보기`, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
  pw.setMenuBarVisibility(false);
  pw.webContents.on("will-navigate", (e) => e.preventDefault());
  pw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  pw.on("closed", cleanup);
  await pw.loadFile(file);
  pw.show();
  return new Promise((resolve) => {
    pw.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
      if (!pw.isDestroyed()) pw.close();
      resolve({ ok, message: ok ? undefined : reason === "cancelled" ? "인쇄를 취소했습니다." : `인쇄하지 못했습니다: ${reason}` });
    });
  });
});

onIpc("doc:state", (_e, state) => {
  dirty = !!state.dirty;
  if (!win) return;
  win.setTitle(state.title ? `${dirty ? "● " : ""}${state.title} — Core.Docs` : "Core.Docs");
  if (process.platform === "darwin") {
    win.setDocumentEdited(dirty);
    win.setRepresentedFilename(state.path || "");
  }
});
onIpc("open-files:ready", () => {
  rendererReady = true;
  flushOpenFiles();
});
onIpc("shell:show-in-folder", (_e, p) => isKnown(p) && shell.showItemInFolder(p));
onIpc("shell:open-external", (_e, url) => typeof url === "string" && /^https?:\/\//.test(url) && shell.openExternal(url));

// ───────────────────────────── AI 앱 등록 ─────────────────────────────
// 메뉴 AI → "Claude Desktop에 연결…"은 각 AI 앱의 설정 파일에 이 앱의 MCP 서버 항목을 쓴다.

function claudeDesktopConfigPath() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function registerClaudeDesktop(entry) {
  const file = claudeDesktopConfigPath();
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8")) || {};
      fs.copyFileSync(file, `${file}.bak`);
    } catch (err) {
      throw new Error(`기존 설정을 읽지 못했습니다 (${file}): ${err.message}`);
    }
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  cfg.mcpServers = { ...(cfg.mcpServers || {}), coredotdocs: entry };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return `Claude Desktop 설정에 'coredotdocs' 서버를 등록했습니다.\n${file}\nClaude Desktop을 완전히 종료했다가 다시 켜면 도구가 보입니다.`;
}

function runCli(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || String(err)).trim()));
      resolve((stdout || "").trim());
    });
  });
}

async function windowsClaudeCommand() {
  const where = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
  const locations = (await runCli(where, ["claude"], { timeout: 10_000 })).split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  for (const location of locations) {
    if (/\.exe$/i.test(location) && fs.existsSync(location)) return { command: location, prefix: [], env: process.env };
    if (!/\.(cmd|bat)$/i.test(location)) continue;
    // npm/pnpm launchers require cmd.exe, which reparses JSON and paths with
    // spaces. Read their installed package's bin entry and run it as Node instead.
    const shimDir = path.dirname(location);
    for (const packageDir of [path.join(shimDir, "node_modules", "@anthropic-ai", "claude-code"), path.join(shimDir, "..", "@anthropic-ai", "claude-code")]) {
      const manifestPath = path.join(packageDir, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.claude;
      if (typeof bin !== "string") continue;
      const script = path.resolve(packageDir, bin);
      if (fs.existsSync(script)) return { command: process.execPath, prefix: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
    }
  }
  throw new Error("Claude Code 실행 파일을 찾지 못했습니다. 공식 Windows 설치 또는 npm 설치를 확인하세요.");
}

async function registerClaudeCode(entry) {
  const json = JSON.stringify({ type: "stdio", ...entry });
  try {
    let stdout;
    if (process.platform === "win32") {
      const cli = await windowsClaudeCommand();
      stdout = await runCli(cli.command, [...cli.prefix, "mcp", "add-json", "--scope", "user", "coredotdocs", json], { env: cli.env });
    } else {
      stdout = await runCli("/bin/zsh", ["-lc", `claude mcp add-json --scope user coredotdocs '${json.replace(/'/g, "'\\''")}'`]);
    }
    return `Claude Code에 등록했습니다 (사용자 범위).\n${stdout}\n새 Claude Code 세션(또는 /mcp)에서 coredotdocs 도구가 보입니다.`;
  } catch (err) {
    throw new Error(`claude 명령을 실행하지 못했습니다. Claude Code가 설치되어 있어야 합니다.\n${err.message}\n\nAI 메뉴의 'MCP 설정 보기'에서 연결 설정을 확인할 수 있습니다.`);
  }
}

function registerCodex(entry) {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hadConfig = fs.existsSync(file);
  let text = hadConfig ? fs.readFileSync(file, "utf8") : "";
  if (/^\[mcp_servers\.coredotdocs\]/m.test(text)) {
    text = text.replace(/\n?\[mcp_servers\.coredotdocs\][\s\S]*?(?=\n\[(?!mcp_servers\.coredotdocs(?:\.|\]))|$)/g, "");
  }
  const toml = (s) => JSON.stringify(s);
  const block = `\n[mcp_servers.coredotdocs]\ncommand = ${toml(entry.command)}\nargs = [${entry.args.map(toml).join(", ")}]\n\n[mcp_servers.coredotdocs.env]\n${Object.entries(entry.env)
    .map(([k, v]) => `${k} = ${toml(v)}`)
    .join("\n")}\n`;
  if (hadConfig) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, text.replace(/\s*$/, "\n") + block);
  return `Codex 설정에 'coredotdocs' 서버를 등록했습니다.\n${file}\n새 Codex 세션에서 도구가 보입니다.`;
}

// 코딩 에이전트 스킬(skills/coredotdocs/SKILL.md, 백엔드 레지스트리에서 생성)을 에이전트의 스킬 폴더에 둔다.
// 설치된 사본은 버전이 커질 때만 바꾼다 (이음오피스 규칙). 아무것도 지우지 않는다.
const SKILL_SOURCE = path.join(resources, "skills", "coredotdocs", "SKILL.md");
const SKILL_DIRS = { "claude-code": path.join(os.homedir(), ".claude", "skills"), codex: path.join(os.homedir(), ".agents", "skills") };
function skillVersion(text) {
  const m = /^\s*version:\s*(\d+)\.(\d+)\.(\d+)\s*$/m.exec(text || "");
  return m ? m.slice(1, 4).map(Number) : [0, 0, 0];
}
function installSkill(target) {
  const dir = SKILL_DIRS[target];
  if (!dir || !fs.existsSync(SKILL_SOURCE)) return "";
  const dest = path.join(dir, "coredotdocs", "SKILL.md");
  const next = fs.readFileSync(SKILL_SOURCE, "utf8");
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  const [a, b] = [skillVersion(next), skillVersion(current)];
  const newer = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  if (current && !newer) return `스킬은 이미 최신입니다 (${b.join(".")}).`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
  return `스킬 'coredotdocs' ${a.join(".")}을(를) ${dest}에 설치했습니다.`;
}

handleIpc("ai:connect", async (_e, target) => {
  if (!servers) return { ok: false, message: "서버가 아직 준비되지 않았습니다." };
  const entry = { command: servers.mcpCommand.command, args: servers.mcpCommand.args, env: servers.mcpCommand.env };
  try {
    let message = target === "claude-desktop" ? registerClaudeDesktop(entry) : target === "claude-code" ? await registerClaudeCode(entry) : target === "codex" ? registerCodex(entry) : null;
    if (message === null) return { ok: false, message: `알 수 없는 대상: ${target}` };
    const skill = installSkill(target);
    if (skill) message += `\n${skill}`;
    writeLog(`AI 연결 ${target}: ok\n`);
    return { ok: true, message };
  } catch (err) {
    writeLog(`AI 연결 ${target} 실패: ${err}\n`);
    return { ok: false, message: String(err.message || err) };
  }
});

// ───────────────────────────── 수명 ─────────────────────────────

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on("second-instance", (_e, argv) => queueOpenFiles(argv.slice(1)));
app.on("open-file", (e, filePath) => {
  e.preventDefault();
  queueOpenFiles([filePath]);
});

/**
 * 설치된 글꼴 목록(Local Font Access, `queryLocalFonts`)을 앱 자신의 화면에만 허락한다. 허락이 없으면 Chromium은 사용자 동작(클릭) 안에서만
 * 목록을 주므로, 문서를 열 때 서식 막대가 설치 글꼴을 채우지 못한다. 나머지 권한은 모두 거절한다.
 */
function grantLocalFonts(webUrl) {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((wc, permission, origin) => permittedPermission(permission, wc, origin, win, webUrl));
  ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(permittedPermission(permission, wc, details?.requestingUrl ?? wc.getURL(), win, webUrl)));
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    servers = await startServers();
    grantLocalFonts(servers.webUrl);
    installedFonts().catch(() => {}); // 창이 뜨는 동안 미리 읽어 둔다
    createWindow(servers.webUrl);
    queueOpenFiles(process.argv.slice(app.isPackaged ? 1 : 2));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(servers.webUrl);
    });
  } catch (err) {
    dialog.showErrorBox("실행 실패", String(err?.message ?? err));
    stopServers();
    app.quit();
  }
});
// The renderer's beforeunload check is authoritative: an IPC dirty update may
// still be in flight when Quit is clicked. Never bypass it using the main copy.
app.on("window-all-closed", () => app.quit());
// A canceled close never reaches will-quit, so its servers remain available.
app.on("will-quit", stopServers);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => app.quit()); // launchctl/kill 로 끝내도 서버·상태 파일을 정리한다
