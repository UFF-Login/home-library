// Generates the PWA icons as real PNGs with no image library.
//
// A PNG is a signature, an IHDR, an IDAT (zlib-deflated scanlines) and an IEND,
// each wrapped in a length/type/CRC chunk. Node ships zlib, so a flat-colour
// icon with a simple amber book glyph is a few dozen lines here instead of a
// dependency or a binary checked into git.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [0x12, 0x10, 0x0e];
const INK = [0xe0, 0xa3, 0x4a];
const PAGE = [0xf4, 0xef, 0xe7];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y, size);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An open book: two amber covers either side of a pale page spread. */
function bookPixel(x, y, size) {
  const u = x / size;
  const v = y / size;
  const inBounds = u > 0.2 && u < 0.8 && v > 0.26 && v < 0.74;
  if (!inBounds) return BG;

  const spine = Math.abs(u - 0.5) < 0.015;
  if (spine) return INK;

  const nearEdge = u < 0.235 || u > 0.765;
  if (nearEdge) return INK;

  // A shallow curve so the top and bottom edges read as pages, not a box.
  const curve = Math.abs(v - 0.5) * 1.1 + Math.abs(u - 0.5) * 0.35;
  if (curve > 0.235) return BG;
  return PAGE;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png(size, bookPixel));
  console.log('wrote', file);
}
