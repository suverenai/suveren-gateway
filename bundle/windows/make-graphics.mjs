#!/usr/bin/env node
/**
 * Generates the Windows installer's images from the Suveren mark
 * (apps/ui/public/favicon.svg), as signed off by Andreas on 2026-10-05
 * (temp/installer-graphics-mockup.html):
 *
 *   bundle/windows/wix/dialog.bmp   493 x 312  welcome/licence + finish pages
 *   bundle/windows/wix/banner.bmp   493 x 58   top strip of the inner pages
 *   bundle/windows/wix/suveren.ico  16/32/48/256  Start-menu shortcut + Apps list
 *
 * Draws with Chromium (Playwright, a dev dependency of this repo) and writes
 * the files itself — no image tools needed. Re-run after changing the mark:
 *   node bundle/windows/make-graphics.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'bundle', 'windows', 'wix');
const require = createRequire(join(ROOT, 'apps', 'ui', 'package.json'));
const { chromium } = require('@playwright/test');

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <path d="M 104.94 61.85 A 41 41 0 1 1 45.39 27.47" stroke="#111111" stroke-width="14" stroke-linecap="round"/>
  <line x1="74.54" y1="22.74" x2="94.46" y2="34.24" stroke="#111111" stroke-width="14" stroke-linecap="round"/>
</svg>`;

// Runs in the page: draws one image, returns raw RGBA (+ a PNG data URL for icons).
const draw = async ({ kind, w, h, mark }) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(mark);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const font = (px, weight) => `${weight} ${px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  if (kind === 'dialog') {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);          // text area (right) stays white
    g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 164, h);        // left panel
    g.fillStyle = '#e6e6e2'; g.fillRect(163, 0, 1, h);        // divider
    g.drawImage(img, 50, 52, 64, 64);
    g.fillStyle = '#111111'; g.textAlign = 'center';
    g.font = font(15, 600); g.fillText('Suveren', 82, 142);
    g.fillStyle = '#777777'; g.font = font(11, 400); g.fillText('Gateway', 82, 158);
  } else if (kind === 'banner') {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e6e6e2'; g.fillRect(0, h - 1, w, 1);
    g.drawImage(img, w - 14 - 34, 12, 34, 34);
  } else {                                                    // icon: mark on transparent
    const pad = Math.max(1, Math.round(w * 0.06));
    g.clearRect(0, 0, w, h);
    g.drawImage(img, pad, pad, w - 2 * pad, h - 2 * pad);
  }
  const data = Array.from(g.getImageData(0, 0, w, h).data);
  return { data, png: c.toDataURL('image/png') };
};

/** 24-bit bottom-up BMP, as WixUI expects. */
function bmp(w, h, rgba) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      b[dst + x * 3] = rgba[s + 2]; b[dst + x * 3 + 1] = rgba[s + 1]; b[dst + x * 3 + 2] = rgba[s];
    }
  }
  return b;
}

/** ICO with PNG-compressed entries (supported since Windows Vista). */
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map(e => e.png)]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  const dialog = await page.evaluate(draw, { kind: 'dialog', w: 493, h: 312, mark: MARK });
  writeFileSync(join(OUT, 'dialog.bmp'), bmp(493, 312, dialog.data));
  const banner = await page.evaluate(draw, { kind: 'banner', w: 493, h: 58, mark: MARK });
  writeFileSync(join(OUT, 'banner.bmp'), bmp(493, 58, banner.data));
  const icons = [];
  for (const size of [16, 32, 48, 256]) {
    const r = await page.evaluate(draw, { kind: 'icon', w: size, h: size, mark: MARK });
    icons.push({ size, png: Buffer.from(r.png.split(',')[1], 'base64') });
  }
  writeFileSync(join(OUT, 'suveren.ico'), ico(icons));
  // previews for a human check
  writeFileSync(join(OUT, '..', 'out-preview-dialog.png'), Buffer.from(dialog.png.split(',')[1], 'base64'));
  writeFileSync(join(OUT, '..', 'out-preview-banner.png'), Buffer.from(banner.png.split(',')[1], 'base64'));
  console.log('wrote dialog.bmp, banner.bmp, suveren.ico to bundle/windows/wix/');
} finally {
  await browser.close();
}
