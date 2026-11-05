// Draws devkit's icon (</> on a dark rounded square) as PNGs, with no dependency.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [17, 24, 39];
const FG = [34, 211, 238];
const SIZES = [16, 32, 48, 128];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Distance from point p to segment ab, in unit coordinates.
const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const SEGMENTS = [
  [
    [0.36, 0.3],
    [0.2, 0.5],
  ],
  [
    [0.2, 0.5],
    [0.36, 0.7],
  ],
  [
    [0.64, 0.3],
    [0.8, 0.5],
  ],
  [
    [0.8, 0.5],
    [0.64, 0.7],
  ],
  [
    [0.56, 0.26],
    [0.44, 0.74],
  ],
];

function shade(x, y, size) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if (Math.hypot(x - cx, y - cy) > r) return null;
  const stroke = size <= 16 ? 0.07 : 0.055;
  return SEGMENTS.some((s) => segDist(x, y, ...s) < stroke) ? FG : BG;
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, size);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0;
      raw[o + 1] = a ? g / a : 0;
      raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) writeFileSync(new URL(`../public/icon/${size}.png`, import.meta.url), png(size));
console.log(`icons: ${SIZES.join(", ")}`);
