// Reads each filed screenshot back and reports what it actually contains: the background it is drawn on (so the
// theme is proven, not asserted), how much of the frame is ink, and whether the bottom of the frame is painted or
// clipped. A JPEG decoder is not in the standard library, so the render is read through Chromium itself.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve('C:/Users/friok/makefun/recorded-build-v7/screenshots');
const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const browser = await chromium.launch();
const page = await browser.newPage();
for (const file of files) {
  const b64 = readFileSync(`${dir}/${file}`).toString('base64');
  // Draw the image in a canvas inside the browser and read its pixels back.
  const stats = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const corners = [
      [2, 2],
      [c.width - 3, 2],
      [2, c.height - 3],
      [c.width - 3, c.height - 3],
      [c.width / 2, c.height - 3],
    ].map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3));
    const all = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let ink = 0;
    for (let i = 0; i < all.length; i += 4) {
      const l = (all[i] * 0.299 + all[i + 1] * 0.587 + all[i + 2] * 0.114);
      sum += l;
      if (l > 140) ink += 1;
    }
    const px = all.length / 4;
    return {
      width: c.width,
      height: c.height,
      meanLuma: Math.round(sum / px),
      inkPixels: ink,
      inkShare: Math.round((ink / px) * 1000) / 10,
      corners,
    };
  }, `data:image/jpeg;base64,${b64}`);
  const bg = stats.corners[0];
  console.log(
    `${file.padEnd(18)} ${stats.width}x${stats.height}  ${String(statSync(`${dir}/${file}`).size).padStart(7)} B  ` +
      `corner rgb ${bg.join(',')}  mean luma ${stats.meanLuma}  ink ${stats.inkShare}%  ` +
      `bottom row ${stats.corners.slice(3).map((c) => c.join(',')).join(' | ')}  · ${bg[0] < 60 ? 'dark ground' : 'LIGHT GROUND'}`,
  );
}
await browser.close();
