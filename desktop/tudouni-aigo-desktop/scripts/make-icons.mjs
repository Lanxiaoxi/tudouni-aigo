/**
 * Generate the application icons.
 *
 * `tauri-build` requires `icons/icon.ico` to exist before it can emit the
 * Windows resource file, so the build cannot run at all without these. They are
 * generated rather than committed as opaque binaries so the mark stays
 * reproducible from the design tokens.
 *
 * The mark: the accent green field with a dark terminal prompt glyph, which is
 * what this application is — a terminal-grade tool with a window around it. The
 * colours come from `src/styles/tokens.css` (`--accent`, `--fg-on-accent`).
 *
 * No dependencies: PNG is written by hand with Node's zlib, and the ICO simply
 * wraps PNG data (which the format has allowed since Vista).
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

// Design tokens: dark theme accent, and the foreground that sits on it.
const ACCENT = [0x22, 0xc5, 0x5e];
const ON_ACCENT = [0x0f, 0x17, 0x2a];
const TRANSPARENT = [0, 0, 0, 0];

/** CRC32, as PNG requires. */
const CRC_TABLE = (() => {
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
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = compression, filter, interlace: all zero

  // Each scanline is prefixed with its filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the mark at `size`.
 *
 * The shapes are described in a 0..1 square so every size is the same drawing:
 *   - a rounded square in accent green;
 *   - a chevron and an underscore in the on-accent colour — the prompt glyph.
 */
function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const stroke = Math.max(1, size * 0.085);

  const set = (x, y, colour, alpha = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = Math.round(alpha * 255);
    // Simple source-over against whatever is already there.
    const existing = rgba[i + 3] / 255;
    const outA = a / 255 + existing * (1 - a / 255);
    if (outA === 0) return;
    for (let c = 0; c < 3; c += 1) {
      rgba[i + c] = Math.round(
        (colour[c] * (a / 255) + rgba[i + c] * existing * (1 - a / 255)) / outA,
      );
    }
    rgba[i + 3] = Math.round(outA * 255);
  };

  // Anti-aliased coverage: supersample each pixel 3x3.
  const SS = 3;
  const insideRounded = (px, py) => {
    const x = px / size;
    const y = py / size;
    const r = radius / size;
    if (x < 0 || y < 0 || x > 1 || y > 1) return false;
    // Corner circles.
    const cx = x < r ? r : x > 1 - r ? 1 - r : x;
    const cy = y < r ? r : y > 1 - r ? 1 - r : y;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  // The prompt glyph: a ">" made of two strokes, and a "_".
  const nearSegment = (px, py, ax, ay, bx, by) => {
    const x = px / size;
    const y = py / size;
    const vx = bx - ax;
    const vy = by - ay;
    const wx = x - ax;
    const wy = y - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    const dx = x - (ax + t * vx);
    const dy = y - (ay + t * vy);
    const half = stroke / size / 2;
    return dx * dx + dy * dy <= half * half;
  };

  const inGlyph = (px, py) =>
    nearSegment(px, py, 0.28, 0.3, 0.5, 0.5) ||
    nearSegment(px, py, 0.5, 0.5, 0.28, 0.7) ||
    nearSegment(px, py, 0.58, 0.72, 0.78, 0.72);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideRounded(px, py)) continue;
          bg += 1;
          if (inGlyph(px, py)) fg += 1;
        }
      }
      const total = SS * SS;
      if (bg === 0) continue;
      // Background first, glyph over it.
      set(x, y, ACCENT, bg / total);
      if (fg > 0) set(x, y, ON_ACCENT, fg / total);
    }
  }

  return rgba;
}

function png(size) {
  return encodePng(size, size, draw(size));
}

/** ICO with embedded PNGs. Width/height 0 means 256 in this format. */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const base = i * 16;
    directory[base] = image.size >= 256 ? 0 : image.size;
    directory[base + 1] = image.size >= 256 ? 0 : image.size;
    directory[base + 2] = 0; // palette
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

/* ---- the files Tauri expects ---- */

const files = [
  ['icon.ico', ico([16, 32, 48, 64, 128, 256])],
  ['icon.png', png(512)],
  ['32x32.png', png(32)],
  ['128x128.png', png(128)],
  ['128x128@2x.png', png(256)],
  // Windows Store / NSIS extras. Cheap to produce, and their absence is a
  // bundling failure on some targets.
  ['Square30x30Logo.png', png(30)],
  ['Square44x44Logo.png', png(44)],
  ['Square71x71Logo.png', png(71)],
  ['Square89x89Logo.png', png(89)],
  ['Square107x107Logo.png', png(107)],
  ['Square142x142Logo.png', png(142)],
  ['Square150x150Logo.png', png(150)],
  ['Square284x284Logo.png', png(284)],
  ['Square310x310Logo.png', png(310)],
  ['StoreLogo.png', png(50)],
];

for (const [name, data] of files) {
  writeFileSync(resolve(outDir, name), data);
}

console.log(`wrote ${files.length} icons to src-tauri/icons`);
console.log(`  icon.ico  ${files[0][1].length} bytes`);
console.log(`  icon.png  ${files[1][1].length} bytes`);
