// 설치된 글꼴 목록 — 메인 프로세스가 글꼴 폴더의 파일 머리(OpenType name 표)만 읽어 가족 이름을 모은다.
// 화면의 Local Font Access(queryLocalFonts)는 한글 탭 여럿이 글꼴 바이트를 읽는 동안 수십 초~무한히 줄을 서서(관측) 서식 막대가
// "감지 중"에 머문다. 파일을 직접 읽으면 탭 수와 상관없이 1~2초 안에 끝나고 권한도 묻지 않는다.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const EXTS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const MAX_DEPTH = 6;

function fontDirs() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return ["/System/Library/Fonts", "/Library/Fonts", path.join(home, "Library/Fonts"), "/System/Library/AssetsV2"];
  }
  if (process.platform === "win32") {
    const win = process.env.WINDIR || "C:\\Windows";
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(win, "Fonts"), path.join(local, "Microsoft", "Windows", "Fonts")];
  }
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".local/share/fonts"), path.join(home, ".fonts")];
}

async function walk(dir, depth, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(p, depth + 1, out);
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
}

async function readAt(fh, offset, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

function utf16be(buf) {
  const swapped = Buffer.from(buf);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/** Mac Roman 기록. 7비트면 그대로, 아니면 옛 한글 글꼴이 넣어 둔 EUC-KR로 읽어 보고 깨지면 버린다. */
function macRoman(raw) {
  if (!raw.some((b) => b >= 0x80)) return raw.toString("latin1");
  try {
    return new TextDecoder("euc-kr", { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

/** name 표 하나에서 가족 이름(영문·한국어). 16(typographic family)이 있으면 그것, 없으면 1. */
function familyNames(name) {
  if (name.length < 6) return null;
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > name.length) break;
    const platform = name.readUInt16BE(r);
    const encoding = name.readUInt16BE(r + 2);
    const lang = name.readUInt16BE(r + 4);
    const id = name.readUInt16BE(r + 6);
    if (id !== 1 && id !== 16) continue;
    const len = name.readUInt16BE(r + 8);
    const off = strings + name.readUInt16BE(r + 10);
    if (len % 2 && platform !== 1) continue;
    const raw = name.subarray(off, off + len);
    if (raw.length !== len) continue;
    let text = null;
    let langKey = null;
    let rank = 0; // 같은 이름이 여러 기록에 있으면 Windows(유니코드) > Unicode > Mac 순
    if (platform === 3 && (encoding === 1 || encoding === 10 || encoding === 0)) {
      text = utf16be(raw);
      langKey = lang === 0x0412 ? "ko" : lang === 0x0409 ? "en" : null;
      rank = 3;
    } else if (platform === 0) {
      text = utf16be(raw);
      langKey = "en";
      rank = 2;
    } else if (platform === 1 && encoding === 0 && lang === 0) {
      text = macRoman(raw);
      if (text && /[\uac00-\ud7a3]/.test(text)) langKey = "ko"; // Mac 기록에 EUC-KR을 넣은 옛 한글 글꼴
      else langKey = "en";
      rank = 1;
    }
    if (!text || !langKey) continue;
    text = text.replace(/\0/g, "").trim();
    if (!text) continue;
    const key = `${langKey}${id}`;
    if (!found[key] || found[key].rank < rank) found[key] = { text, rank };
  }
  const en = (found.en16 || found.en1)?.text;
  const ko = (found.ko16 || found.ko1)?.text;
  return en || ko ? { en, ko } : null;
}

async function fontsInFile(file) {
  const fh = await fs.open(file, "r");
  try {
    const head = await readAt(fh, 0, 12);
    if (head.length < 12) return [];
    let offsets = [0];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const n = Math.min(head.readUInt32BE(8), 64);
      const dir = await readAt(fh, 12, n * 4);
      offsets = [];
      for (let i = 0; i + 4 <= dir.length; i += 4) offsets.push(dir.readUInt32BE(i));
    }
    const out = [];
    for (const base of offsets) {
      const hdr = await readAt(fh, base, 12);
      if (hdr.length < 12) continue;
      const tables = Math.min(hdr.readUInt16BE(4), 128);
      const dir = await readAt(fh, base + 12, tables * 16);
      for (let t = 0; t + 16 <= dir.length; t += 16) {
        if (dir.toString("latin1", t, t + 4) !== "name") continue;
        const off = dir.readUInt32BE(t + 8);
        const len = Math.min(dir.readUInt32BE(t + 12), 1 << 20);
        const names = familyNames(await readAt(fh, off, len));
        if (names) out.push(names);
        break;
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** 설치된 글꼴 가족 [{family(영문), localized?(한국어)}] — 숨은 시스템 글꼴(.으로 시작)은 뺀다. */
async function scanInstalledFonts() {
  const files = [];
  for (const dir of fontDirs()) await walk(dir, 0, files);
  const families = new Map();
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.pop(); f; f = queue.pop()) {
      let list = [];
      try {
        list = await fontsInFile(f);
      } catch {
        continue;
      }
      for (const { en, ko } of list) {
        const family = en || ko;
        if (!family || family.startsWith(".") || family === "LastResort") continue;
        const prev = families.get(family);
        if (!prev) families.set(family, ko && ko !== family ? { family, localized: ko } : { family });
        else if (!prev.localized && ko && ko !== family) prev.localized = ko;
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family, "ko"));
}

let cached = null;
function installedFonts() {
  if (!cached) cached = scanInstalledFonts().catch((err) => ((cached = null), Promise.reject(err)));
  return cached;
}

module.exports = { installedFonts, scanInstalledFonts, familyNames };
