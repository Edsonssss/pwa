/* Регенерация всех иконок приложения без внешних зависимостей.
   Запуск: npm run icons   (или: node tools/gen-icons.js)
   Рисует градиент + галочку и пишет PNG вручную (zlib + CRC), включая
   maskable-варианты с артом внутри safe-zone (центральный круг 80%). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = process.env.ICONS_OUT || path.join(__dirname, '..', 'icons');

/* ---------- палитра градиента (совпадает с icon.svg) ---------- */
const STOPS = [
  [0.00, [0x63, 0xb3, 0xff]],
  [0.55, [0x2f, 0x7b, 0xf5]],
  [0.00 + 1.00, [0x1f, 0x5f, 0xf0]],
];
function gradColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * k));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/* ---------- геометрия галочки в системе координат 512 ---------- */
const PTS = [[128, 272], [226, 366], [392, 178]];
const STROKE = 52;

function distToSeg(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/* ---------- построение RGBA-буфера ---------- */
function buildIcon(size, { maskable = false } = {}) {
  const data = Buffer.alloc(size * size * 4);
  const s = size / 512;                       // масштаб из системы 512
  const stroke = Math.max(1.6, STROKE * s) / 2;
  const artScale = maskable ? 0.8 : 1;        // maskable: арт в safe-zone
  const c = 256;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // координата в системе 512 с учётом сжатия арта для maskable
      let ux = (x + 0.5) / s, uy = (y + 0.5) / s;
      if (maskable) { ux = c + (ux - c) / artScale; uy = c + (uy - c) / artScale; }

      const t = (0.35 * (ux / 512) + (uy / 512)) / 1.35;
      let [r, g, b] = gradColor(t);

      const d = Math.min(
        distToSeg(ux, uy, PTS[0], PTS[1]),
        distToSeg(ux, uy, PTS[1], PTS[2])
      );
      if (d <= STROKE / 2) { r = g = b = 0xfa; } // белая галочка (#fafafa)

      const i = (y * size + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 0xff;
    }
  }
  return data;
}

/* ---------- минимальный PNG-энкодер ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- целевые файлы ---------- */
const TARGETS = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-192.png', 192, { maskable: true }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-16.png', 16, {}],
  ['favicon-32.png', 32, {}],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of TARGETS) {
  const png = encodePNG(size, buildIcon(size, opts));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`icons/${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)}KB`);
}
console.log('Готово. icon.svg и mask-icon.svg правятся вручную (вектор).');
