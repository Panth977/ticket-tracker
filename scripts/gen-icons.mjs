#!/usr/bin/env node
/**
 * Every PWA icon, from one source mark (docs/plan/agents.html § S).
 *
 *   node scripts/gen-icons.mjs            write frontend/static/icons/*.png
 *   node scripts/gen-icons.mjs --check    fail if any of them is out of date
 *
 * The input is frontend/static/icons/source.svg: a 512×512 box holding the
 * glyph ONLY (<g id="mark">), plus the tile / mark colours as data-bg and
 * data-fg. This script supplies the tile and the padding each variant needs,
 * so a change to the mark reaches every size at once and nothing can drift:
 *
 *   icon-{192,256,384,512}.png  rounded tile, the Android / desktop "any" icons
 *   icon-maskable-512.png       FULL-BLEED tile, mark inside the 80% safe circle
 *                               (Android may crop this to a circle, squircle…)
 *   apple-touch-icon-180.png    opaque square; iOS applies its own mask and
 *                               composites transparency onto black
 *
 * frontend/vite.config.ts runs this at the start of every production build, so
 * a stale icon cannot ship. sharp is a root devDependency.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'frontend/static/icons');
const SOURCE = join(DIR, 'source.svg');

/** Pull the mark's markup and the colours out of the source file. */
function readSource() {
  // Comments are stripped first: the file's own header explains the contract
  // by quoting the very tags we are looking for.
  const svg = readFileSync(SOURCE, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const bg = /data-bg="([^"]+)"/.exec(svg)?.[1] ?? '#4f46e5';
  const mark = /<g id="mark"([\s\S]*?)<\/g>/.exec(svg);
  if (!mark) throw new Error(`${SOURCE}: no <g id="mark"> … </g>`);
  return { bg, mark: `<g${mark[1]}</g>` };
}

/**
 * One variant as an SVG string.
 * `scale` is the fraction of the tile the 512-box mark occupies; `rx` is the
 * corner radius as a fraction of the size (0 = square, full-bleed).
 */
function variant({ bg, mark }, { size, scale, rx, bgAlpha = 1 }) {
  const inner = size * scale;
  const offset = (size - inner) / 2;
  const k = inner / 512;
  const fill = bgAlpha === 0 ? 'none' : bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${(rx * size).toFixed(2)}" ry="${(rx * size).toFixed(2)}" fill="${fill}"/>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${k.toFixed(6)})">${mark}</g>
</svg>`;
}

/**
 * The full set. `scale` for the maskable icon keeps the glyph inside the 80%
 * safe circle even at the corners: 0.56 × 512 ≈ 287px of content in a 512 tile,
 * whose diagonal (406px) still fits the 410px circle.
 */
export const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.68, rx: 0.22, purpose: 'any' },
  { file: 'icon-256.png', size: 256, scale: 0.68, rx: 0.22, purpose: 'any' },
  { file: 'icon-384.png', size: 384, scale: 0.68, rx: 0.22, purpose: 'any' },
  { file: 'icon-512.png', size: 512, scale: 0.68, rx: 0.22, purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.56, rx: 0, purpose: 'maskable' },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 0.68, rx: 0, purpose: 'apple' },
];

async function render(source, spec) {
  // Render at 4× and downsample: librsvg's DPI scaling is what actually sizes
  // an SVG, and the explicit resize keeps the output exactly `size` px either way.
  return sharp(Buffer.from(variant(source, spec)), { density: 72 * 4 })
    .resize(spec.size, spec.size, { fit: 'cover' })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export async function genIcons({ check = false, quiet = false } = {}) {
  const source = readSource();
  mkdirSync(DIR, { recursive: true });
  const stale = [];
  for (const spec of ICONS) {
    const out = join(DIR, spec.file);
    const next = await render(source, spec);
    const current = existsSync(out) ? readFileSync(out) : null;
    // PNG bytes are deterministic for a fixed sharp/libvips, so a hash compare
    // is enough to tell "someone edited the mark" from "nothing changed".
    if (current && sha(current) === sha(next)) continue;
    stale.push(spec.file);
    if (!check) writeFileSync(out, next);
  }
  if (check && stale.length) {
    throw new Error(`Icons are out of date (run: node scripts/gen-icons.mjs): ${stale.join(', ')}`);
  }
  if (!quiet) {
    console.log(stale.length ? `icons: wrote ${stale.join(', ')}` : `icons: ${ICONS.length} up to date`);
  }
  return stale;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  genIcons({ check: process.argv.includes('--check') }).catch((err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  });
}
