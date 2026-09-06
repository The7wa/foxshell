// 生成 256x256 狐狸图标 PNG（纯 Node，无依赖）
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 256;
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA，初始透明

function put(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  if (a >= 255) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; return; }
  // alpha 混合
  const na = px[i + 3] / 255, oa = a / 255, outA = oa + na * (1 - oa);
  if (outA === 0) return;
  px[i] = Math.round((r * oa + px[i] * na * (1 - oa)) / outA);
  px[i + 1] = Math.round((g * oa + px[i + 1] * na * (1 - oa)) / outA);
  px[i + 2] = Math.round((b * oa + px[i + 2] * na * (1 - oa)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function sign(p1, p2, p3) {
  return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
}
function inTri(p, a, b, c) {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const ORANGE = [240, 138, 36], DARK_ORANGE = [224, 112, 32], EAR_IN = [122, 61, 16],
  WHITE = [255, 244, 230], INK = [43, 32, 24];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const p = [x, y];
    // 耳朵（外橙、内深）
    const earL = inTri(p, [36, 16], [108, 68], [48, 124]);
    const earR = inTri(p, [220, 16], [148, 68], [208, 124]);
    const earLin = inTri(p, [52, 40], [94, 70], [58, 102]);
    const earRin = inTri(p, [204, 40], [162, 70], [198, 102]);
    if (earL || earR) put(x, y, ...DARK_ORANGE);
    if (earLin || earRin) put(x, y, ...EAR_IN);
    // 脸（圆）
    if (inCircle(x, y, 128, 132, 92)) put(x, y, ...ORANGE);
    // 白色下巴（椭圆）
    const mx = (x - 128) / 78, my = (y - 178) / 62;
    if (mx * mx + my * my <= 1) put(x, y, ...WHITE);
    // 眼睛
    if (inCircle(x, y, 92, 118, 14)) put(x, y, ...INK);
    if (inCircle(x, y, 164, 118, 14)) put(x, y, ...INK);
    if (inCircle(x, y, 97, 113, 5)) put(x, y, 255, 255, 255);
    if (inCircle(x, y, 169, 113, 5)) put(x, y, 255, 255, 255);
    // 鼻子（三角）
    if (inTri(p, [128, 158], [152, 178], [128, 198]) || inTri(p, [128, 158], [104, 178], [128, 198])) {
      put(x, y, ...INK);
    }
  }
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, 'renderer', 'icon.png');
fs.writeFileSync(out, png);
console.log('written', out, png.length, 'bytes');
