/**
 * Generates PWA icons and stages the onnxruntime-web WASM runtime into public/.
 *
 * Both outputs are derived, not authored, so they stay out of git (see
 * .gitignore) and are rebuilt by `npm run assets` before every build.
 *
 * The PNG writer here is hand-rolled on top of node:zlib purely to avoid
 * pulling an image library into devDependencies for two icons.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ PNG --- */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** @param {number} size @param {Uint8Array} rgba */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ art --- */

const BG = [0x0b, 0x10, 0x20];
const ACCENT = [0x2d, 0xe1, 0xc2];
const WARM = [0xff, 0x8c, 0x42];

/**
 * Radar motif: concentric rings with a bright centre and one off-centre blip.
 *
 * `artScale` shrinks the drawing for the maskable variant so nothing important
 * lands outside the 80% safe zone that launchers may crop to.
 */
function renderIcon(size, artScale) {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const unit = (size / 2) * artScale;

  // Anti-aliased coverage of a ring of radius `r` and half-thickness `t`.
  const ring = (d, r, t) => Math.max(0, Math.min(1, (t - Math.abs(d - r)) / (size / 256) + 0.5));
  const disc = (d, r) => Math.max(0, Math.min(1, (r - d) / (size / 256) + 0.5));

  const blipX = c + unit * 0.42;
  const blipY = c - unit * 0.34;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let [r, g, b] = BG;

      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);

      const blend = (color, alpha) => {
        if (alpha <= 0) return;
        const a = Math.min(1, alpha);
        r = r + (color[0] - r) * a;
        g = g + (color[1] - g) * a;
        b = b + (color[2] - b) * a;
      };

      // Faint glow toward the centre so the mark reads on dark launchers.
      blend(ACCENT, 0.10 * Math.max(0, 1 - d / (unit * 0.95)));

      blend(ACCENT, 0.30 * ring(d, unit * 0.86, size / 190));
      blend(ACCENT, 0.45 * ring(d, unit * 0.60, size / 150));
      blend(ACCENT, 0.65 * ring(d, unit * 0.34, size / 120));
      blend(ACCENT, 1.00 * disc(d, unit * 0.11));

      const db = Math.hypot(x + 0.5 - blipX, y + 0.5 - blipY);
      blend(WARM, 0.35 * disc(db, unit * 0.20));
      blend(WARM, 1.00 * disc(db, unit * 0.085));

      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = 255;
    }
  }
  return encodePng(size, px);
}

const iconsDir = join(root, 'public', 'icons');
mkdirSync(iconsDir, { recursive: true });

for (const [name, size, scale] of [
  ['icon-192.png', 192, 0.82],
  ['icon-512.png', 512, 0.82],
  ['maskable-512.png', 512, 0.60],
]) {
  writeFileSync(join(iconsDir, name), renderIcon(size, scale));
  console.log(`icons: public/icons/${name}`);
}

writeFileSync(
  join(root, 'public', 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0b1020"/>
  <g fill="none" stroke="#2de1c2" stroke-width="2.5">
    <circle cx="32" cy="32" r="22" opacity=".3"/>
    <circle cx="32" cy="32" r="15" opacity=".45"/>
    <circle cx="32" cy="32" r="8" opacity=".65"/>
  </g>
  <circle cx="32" cy="32" r="3.2" fill="#2de1c2"/>
  <circle cx="43" cy="23" r="3.6" fill="#ff8c42"/>
</svg>
`,
);
console.log('icons: public/favicon.svg');

/* ------------------------------------------------------------- ort wasm --- */

const ortSrc = join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
const ortDest = join(root, 'public', 'ort');
mkdirSync(ortDest, { recursive: true });

for (const file of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  const from = join(ortSrc, file);
  if (!existsSync(from)) {
    console.error(`ort: missing ${from} — did @huggingface/transformers install correctly?`);
    process.exit(1);
  }
  copyFileSync(from, join(ortDest, file));
  console.log(`ort: public/ort/${file}`);
}
