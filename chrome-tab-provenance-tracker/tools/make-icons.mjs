// Renders the extension icon (a small branching DAG) to PNG at 16/32/48/128 px. No dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const png = (w, h, rgba) => {
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};

// shapes in a 0..1 unit square, painted in order
const ink = [17, 17, 17], violet = [167, 139, 250], green = [52, 211, 153], white = [255, 255, 255];
const seg = (ax, ay, bx, by, w, color) => ({ color, d: (x, y) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t) - w / 2;
} });
const dot = (cx, cy, r, color) => ({ color, d: (x, y) => Math.hypot(x - cx, y - cy) - r });
const box = { color: white, d: (x, y) => { const r = .2, qx = Math.abs(x - .5) - .5 + r, qy = Math.abs(y - .5) - .5 + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; } };
const shapes = [
  box,
  seg(.34, .22, .34, .78, .085, ink),
  seg(.34, .40, .68, .56, .085, violet),
  seg(.68, .56, .68, .78, .085, green),
  dot(.34, .22, .1, ink), dot(.34, .78, .1, ink), dot(.68, .78, .1, green), dot(.68, .56, .1, violet),
];

for (const size of [16, 32, 48, 128]) {
  const buf = Buffer.alloc(size * size * 4), ss = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + .5) / ss) / size, v = (y + (sy + .5) / ss) / size;
      let c = null;
      for (const s of shapes) if (s.d(u, v) <= 0) c = s.color;
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (y * size + x) * 4;
    if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = 255 * a / (ss * ss); }
  }
  writeFileSync(new URL(`../extension/icons/${size}.png`, import.meta.url), png(size, size, buf));
}
