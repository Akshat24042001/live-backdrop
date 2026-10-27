// Builds the backdrop's logo files from the event artwork in assets-src/.
// Run: node scripts/make-assets.mjs   (needs the dev dependency "sharp")
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => path.join(root, 'assets-src', f);
const out = (f) => path.join(root, 'public', 'assets', f);

// Navyoday logo: the artwork is on white. Turn white into transparency, keeping soft edges clean.
async function whiteToAlpha(input, output) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const a = Math.min(255, (255 - Math.min(r, g, b)) * 1.6); // distance from white
    if (a <= 4) { data[i + 3] = 0; continue; }
    const k = a / 255;
    // Un-mix the white background so edges do not keep a white halo on coloured backdrops.
    data[i] = Math.max(0, Math.min(255, (r - 255 * (1 - k)) / k));
    data[i + 1] = Math.max(0, Math.min(255, (g - 255 * (1 - k)) / k));
    data[i + 2] = Math.max(0, Math.min(255, (b - 255 * (1 - k)) / k));
    data[i + 3] = a;
  }
  await sharp(data, { raw: info }).trim({ threshold: 1 }).png().toFile(output);
}

// JITO emblem: a white circle on the dark poster. Cut it out as a circle.
async function circle(input, cx, cy, r, output) {
  const size = r * 2;
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r - 0.5}" fill="#fff"/></svg>`);
  await sharp(input).extract({ left: cx - r, top: cy - r, width: size, height: size })
    .resize(size * 2, size * 2, { kernel: 'lanczos3' })
    .composite([{ input: await sharp(mask).resize(size * 2, size * 2).png().toBuffer(), blend: 'dest-in' }])
    .png().toFile(output);
}

// JITO wing badges: three badges on a dark strip (positions measured from the poster).
async function badges(input, rects, output) {
  const gap = 16;
  const parts = [];
  let x = 0;
  for (const r of rects) {
    parts.push({ input: await sharp(input).extract(r).png().toBuffer(), left: x, top: 0 });
    x += r.width + gap;
  }
  const H = Math.max(...rects.map((r) => r.height));
  await sharp({ create: { width: x - gap, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts).png().toBuffer()
    .then((buf) => sharp(buf).resize({ height: H * 2, kernel: 'lanczos3' }).png().toFile(output));
  return rects.length;
}

await whiteToAlpha(src('navyoday-logo.png'), out('navyoday.png'));
await circle(src('behind-the-success-poster.jpg'), 275, 134, 72, out('jito-emblem.png'));
const n = await badges(src('behind-the-success-poster.jpg'), [435, 566, 697].map((left) => ({ left, top: 185, width: 122, height: 51 })), out('jito-wings.png'));
for (const f of ['navyoday.png', 'jito-emblem.png', 'jito-wings.png']) {
  const m = await sharp(out(f)).metadata();
  console.log(`${f}: ${m.width}x${m.height}`);
}
console.log(`wing badges found: ${n}`);
