// 렌더러(화면)에 노출하는 작은 API 묶음 — window.coredotdocs.
// sandbox·contextIsolation이 켜져 있어 여기서는 electron 모듈만 쓸 수 있고 파일 읽기/쓰기는 메인 프로세스가 한다.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld("coredotdocs", {
  platform: process.platform,
  version: ipcRenderer.sendSync("app:version"),
  listFonts: () => ipcRenderer.invoke("fonts:list"),
  openFileDialog: () => ipcRenderer.invoke("file:open-dialog"),
  readPath: (path) => ipcRenderer.invoke("file:read", path),
  saveFile: (opts) => ipcRenderer.invoke("file:save", opts),
  printToPdf: (opts) => ipcRenderer.invoke("print:pdf", opts),
  printHtml: (opts) => ipcRenderer.invoke("print:html", opts),
  setDocumentState: (state) => ipcRenderer.send("doc:state", state),
  connectAi: (target) => ipcRenderer.invoke("ai:connect", target),
  onMenu: (cb) => on("menu", cb),
  onOpenFiles: (cb) => {
    const off = on("open-files", cb);
    ipcRenderer.send("open-files:ready"); // 앱 아이콘에 떨어뜨리거나 파일 연결로 들어온 경로를 이제 받을 수 있다
    return off;
  },
  showInFolder: (path) => ipcRenderer.send("shell:show-in-folder", path),
  openExternal: (url) => ipcRenderer.send("shell:open-external", url),
  pathForFile: (file) => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.sendSync("file:grant-native", path) || "" : "";
  },
});
