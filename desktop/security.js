const fs = require('node:fs');
const path = require('node:path');

function sameOrigin(value, expected) {
  try { return new URL(value).origin === new URL(expected).origin; } catch { return false; }
}

function trustedSender(event, window, webUrl) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame && event.senderFrame === window.webContents.mainFrame && sameOrigin(event.senderFrame.url, webUrl));
}

function permittedPermission(permission, webContents, origin, window, webUrl) {
  return permission === 'local-fonts' && Boolean(window && !window.isDestroyed() &&
    webContents === window.webContents && sameOrigin(origin, webUrl));
}

// Grants come only from native file selection, OS open-file events, or a native
// File object passed through the isolated preload. Renderer strings never grant access.
class FileGrants {
  constructor(file) {
    this.file = file;
    this.paths = new Set();
    try {
      if (fs.statSync(file).size > 1024 * 1024) return;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) for (const entry of saved.slice(-1000)) {
        if (typeof entry === 'string' && path.isAbsolute(entry)) this.paths.add(entry);
      }
    } catch { /* No previous native grants. */ }
  }
  key(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
    try {
      const resolved = fs.existsSync(value) ? fs.realpathSync(value) : path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch { return null; }
  }
  has(value) {
    const key = this.key(value);
    return key !== null && this.paths.has(key);
  }
  grant(value) {
    const key = this.key(value);
    if (!key) throw new Error('파일 경로를 확인하지 못했습니다. 파일 대화상자에서 다시 선택해 주세요.');
    this.paths.delete(key);
    this.paths.add(key);
    while (this.paths.size > 1000) this.paths.delete(this.paths.values().next().value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify([...this.paths]), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return value;
  }
}

module.exports = { trustedSender, permittedPermission, FileGrants };
