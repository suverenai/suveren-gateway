import { chromium } from '/Users/andreasschadauer/Development/HAP/temp/c9d13b-refusal-ui/node_modules/@playwright/test/index.mjs';
const out = '/Users/andreasschadauer/Development/HAP/temp/refusal-limit-mockup/built/';
const b = await chromium.launch();
const shots = [
  ['light', 'theme=light', 680], ['dark', 'theme=dark', 680], ['phone-390', 'theme=light', 390],
  ['light-missing-data', 'theme=light&data=0&words=0&usage=0', 680],
];
for (const [name, qs, w] of shots) {
  const p = await b.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
  p.on('pageerror', e => console.log('ERR', name, e.message));
  await p.goto('http://localhost:5877/?' + qs);
  await p.waitForSelector('[data-testid=refusal]');
  await p.waitForTimeout(800);
  await p.screenshot({ path: out + name + '.png', fullPage: true });
}
await b.close();
