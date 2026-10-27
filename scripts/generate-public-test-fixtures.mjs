// Copyright 2026 CoreDotToday. Apache-2.0.
// Deterministic, original test geometry: no Office icons or external artwork.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const JSZip = require('jszip');
const fixtures = path.join(root, 'third_party/genoffice-docx/packages/docx-engine/tests/fixtures');
const record = (kind, bytes) => {
  const b = Buffer.alloc(bytes); b.writeUInt32LE(kind, 0); b.writeUInt32LE(bytes, 4); return b;
};
const pair = (kind, x, y) => { const b = record(kind, 16); b.writeInt32LE(x, 8); b.writeInt32LE(y, 12); return b; };
function emf(records, bounds = [0, 0, 200, 100]) {
  const h = record(1, 88), eof = record(14, 20);
  bounds.forEach((n, i) => h.writeInt32LE(n, 8 + 4 * i));
  bounds.map(n => Math.round(n * 2540 / 96)).forEach((n, i) => h.writeInt32LE(n, 24 + 4 * i));
  h.writeUInt32LE(0x464d4520, 40); h.writeUInt32LE(0x10000, 44);
  h.writeUInt32LE(108 + records.reduce((n, b) => n + b.length, 0), 48);
  h.writeUInt32LE(records.length + 2, 52); h.writeUInt16LE(2, 56);
  h.writeInt32LE(1920, 72); h.writeInt32LE(1080, 76);
  h.writeInt32LE(508, 80); h.writeInt32LE(286, 84);
  eof.writeUInt32LE(20, 16);
  return Buffer.concat([h, ...records, eof]);
}
function text(value, x = 10, y = 50) {
  const encoded = Buffer.from(value, 'utf16le');
  const dxOffset = (76 + encoded.length + 3) & ~3;
  const b = record(84, dxOffset + value.length * 4);
  b.writeUInt32LE(1, 24); b.writeFloatLE(1, 28); b.writeFloatLE(1, 32);
  b.writeInt32LE(x, 36); b.writeInt32LE(y, 40);
  b.writeUInt32LE(value.length, 44); b.writeUInt32LE(76, 48); b.writeUInt32LE(dxOffset, 72);
  encoded.copy(b, 76);
  for (let i = 0; i < value.length; i++) b.writeInt32LE(10, dxOffset + i * 4);
  return b;
}
function dib(width, height, alpha = false) {
  const h = Buffer.alloc(40); h.writeUInt32LE(40, 0);
  h.writeInt32LE(width, 4); h.writeInt32LE(height, 8);
  h.writeUInt16LE(1, 12); h.writeUInt16LE(32, 14); h.writeUInt32LE(width * height * 4, 20);
  const p = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    p[at] = 180; p[at + 1] = (x + y) % 2 ? 90 : 180; p[at + 2] = 40;
    p[at + 3] = alpha && (x < 2 || x >= width - 2 || y < 2 || y >= height - 2) ? 0 : 255;
  }
  return { h, p };
}

const points = Array.from({ length: 201 }, (_, i) => [Math.round(380 * i / 200), i % 2 ? 0 : 230]);
const poly = record(4, 28 + points.length * 8);
[0, 0, 380, 230].forEach((n, i) => poly.writeInt32LE(n, 8 + i * 4));
poly.writeUInt32LE(points.length, 24);
points.forEach(([x, y], i) => { poly.writeInt32LE(x, 28 + i * 8); poly.writeInt32LE(y, 32 + i * 8); });
await fs.writeFile(path.join(fixtures, 'mapping-grid.emf'), emf([
  pair(9, 380, 230), pair(10, 0, 0), pair(11, 190, 115), pair(12, 300, -616), poly,
], [300, -616, 490, -501]));

function wmfRecord(kind, params, bitmap = Buffer.alloc(0)) {
  const b = Buffer.alloc(6 + params.length * 2 + bitmap.length);
  b.writeUInt32LE(b.length / 2, 0); b.writeUInt16LE(kind, 4);
  params.forEach((n, i) => b.writeUInt16LE(n & 0xffff, 6 + i * 2));
  bitmap.copy(b, 6 + params.length * 2); return b;
}
const bitmap = dib(32, 64);
const wmfRecords = [wmfRecord(0x020b, [0, 0]), wmfRecord(0x020c, [50, 90]),
  ...[0x008800c6, 0x00660046].map(rop => wmfRecord(0x0b41,
    [rop & 0xffff, rop >>> 16, 32, 32, 0, 0, 32, 32, 0, 29], Buffer.concat([bitmap.h, bitmap.p]))),
  wmfRecord(0, [])];
const placeable = Buffer.alloc(22); placeable.writeUInt32LE(0x9ac6cdd7, 0);
placeable.writeInt16LE(90, 10); placeable.writeInt16LE(50, 12); placeable.writeUInt16LE(96, 14);
let checksum = 0; for (let i = 0; i < 20; i += 2) checksum ^= placeable.readUInt16LE(i);
placeable.writeUInt16LE(checksum, 20);
const wh = Buffer.alloc(18); wh.writeUInt16LE(1, 0); wh.writeUInt16LE(9, 2); wh.writeUInt16LE(0x300, 4);
wh.writeUInt32LE(9 + wmfRecords.reduce((n, b) => n + b.length / 2, 0), 6);
wh.writeUInt32LE(Math.max(...wmfRecords.map(b => b.length / 2)), 12);
await fs.writeFile(path.join(fixtures, 'mask-xor.wmf'), Buffer.concat([placeable, wh, ...wmfRecords]));

const alpha = dib(32, 32, true), blend = record(114, 108 + 40 + alpha.p.length);
[32, 32].forEach((n, i) => blend.writeInt32LE(n, 32 + i * 4));
blend[42] = 255; blend[43] = 1; // AC_SRC_OVER, constant alpha 255, AC_SRC_ALPHA
blend.writeFloatLE(1, 52); blend.writeFloatLE(1, 64);
blend.writeUInt32LE(108, 84); blend.writeUInt32LE(40, 88);
blend.writeUInt32LE(148, 92); blend.writeUInt32LE(alpha.p.length, 96);
blend.writeInt32LE(32, 100); blend.writeInt32LE(32, 104);
alpha.h.copy(blend, 108); alpha.p.copy(blend, 148);
await fs.writeFile(path.join(fixtures, 'alpha-square.emf'), emf([blend, text('coredotdocs')]));
const align = record(22, 12); align.writeUInt32LE(6, 8); // TA_CENTER
await fs.writeFile(path.join(fixtures, 'centered-caption.emf'), emf([align, text('simple.txt', 100, 50)]));

function crc32(b) {
  let crc = 0xffffffff;
  for (const n of b) { crc ^= n; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type), b = Buffer.alloc(data.length + 12);
  b.writeUInt32BE(data.length, 0); label.copy(b, 4); data.copy(b, 8);
  b.writeUInt32BE(crc32(Buffer.concat([label, data])), data.length + 8); return b;
}
// A new geometric test pattern at the original raster dimensions. The DOCX's
// layout XML and all other ZIP members remain byte-for-byte identical.
const docxPath = path.join(fixtures, 'truths/render-hf-inline-picture/probe.docx');
const zip = await JSZip.loadAsync(await fs.readFile(docxPath));
const entry = zip.file('word/media/image1.png');
const old = await entry.async('nodebuffer'), width = old.readUInt32BE(16), height = old.readUInt32BE(20);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
const pixels = Buffer.alloc(height * (1 + 3 * width));
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const at = y * (1 + width * 3) + 1 + x * 3, light = ((x >> 3) + (y >> 3)) % 2;
  pixels[at] = light ? 80 : 20; pixels[at + 1] = light ? 160 : 70; pixels[at + 2] = 210;
}
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
zip.file(entry.name, png, { date: entry.date, createFolders: false });
await fs.writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Generated original EMF/WMF fixtures and ${width}x${height} DOCX test pattern.`);
