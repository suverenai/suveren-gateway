/**
 * Writes one static HTML page with the gateway's pairing screens (the Devices page, "Add a phone", "Add this computer") and their states,
 * rendered from the REAL components (renderToStaticMarkup, as pairing-screens.test.tsx does) with the real CSS inlined. No network, no
 * fonts. Every frame twice: day and dark.
 *
 *   vite-node.mjs (from node_modules/.pnpm/vite-node@3.2.4...) --config vite.config.ts scripts/pairing-mockup.tsx <output.html>
 *   (run in apps/ui; tsx cannot be used: the shared package's JSX needs the vite react plugin)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddComputerScreen, AddPhoneScreen, DevicesScreen } from '../src/components/device/PairingScreens';
import type { PairingDeviceRow, PairingView } from '../src/lib/device-client';
import type { PairingUiState } from '../src/lib/pairing-driver';

const out = process.argv[2];
if (!out) throw new Error('usage: pairing-mockup.tsx <output.html>');
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const css = [read('../src/styles/tokens.css'), read('../src/styles/design-system.css').replace(/@font-face\s*\{[^}]*\}/g, '')].join('\n');

const NOW = Math.floor(Date.now() / 1000);
const noop = () => {};
const mac: PairingDeviceRow = { keyId: 'k1', label: 'Office Mac', kind: 'gateway', thisDevice: true, canGrant: true, addedAt: NOW - 40 * 86400, recent: false };
const phone: PairingDeviceRow = { keyId: 'k2', label: 'My iPhone', kind: 'approve-app', thisDevice: false, canGrant: true, addedAt: NOW - 3600, recent: true };
const st = (view: PairingView, over: Partial<PairingUiState> = {}): PairingUiState => ({ view, busy: false, loading: false, ...over });
const QR = 'SUVEREN-PAIR-1:' + 'eyJ2IjoxLCJhc191cmwiOiJodHRwczovL3N1dmVyZW4uYWkiLCJzaG93bl9ieSI6ImFkbWl0dGVyIn0'.repeat(4);
const addPhone = (state: PairingUiState) => <AddPhoneScreen state={state} nowSeconds={NOW} onStart={noop} onChoose={noop} onCancel={noop} onDone={noop} />;
const addComputer = (state: PairingUiState) => <AddComputerScreen state={state} nowSeconds={NOW} onStart={noop} onConfirm={noop} onCancel={noop} onDone={noop} onRetrySignIn={noop} onBack={noop} />;

const groups: Array<[string, Array<[string, ReactElement]>]> = [
  ['Devices', [
    ['List', <DevicesScreen devices={{ rows: [mac, phone], identityCode: '731422085561094233751234', origin: null, canGrant: true, hasRoom: true }} nowSeconds={NOW} onAddPhone={noop} onRefresh={noop} onBack={noop} />],
    ['This computer cannot add', <DevicesScreen devices={{ rows: [{ ...mac, canGrant: false }], identityCode: '731422085561094233751234', origin: null, canGrant: false, hasRoom: true }} nowSeconds={NOW} onAddPhone={noop} onRefresh={noop} onBack={noop} />],
  ]],
  ['Add a phone', [
    ['Intro', addPhone(st({ flow: 'none' }))],
    ['The code to scan', addPhone(st({ flow: 'admit', step: 'qr', qr: QR, expiresAt: NOW + 600 }))],
    ['Phone connecting', addPhone(st({ flow: 'admit', step: 'connected' }))],
    ['Tap the code', addPhone(st({ flow: 'admit', step: 'choose', label: 'My iPhone', kind: 'approve-app', codes: ['482913', '107356', '660821'], rows: [mac, { ...phone, adding: true }] }))],
    ['Touch', addPhone(st({ flow: 'admit', step: 'checking' }))],
    ['Added', addPhone(st({ flow: 'admit', step: 'done', label: 'My iPhone', rows: [mac, phone] }))],
    ['Wrong code', addPhone(st({ flow: 'admit', step: 'failed', code: 'wrong_code' }))],
  ]],
  ['Add this computer', [
    ['Intro', addComputer(st({ flow: 'none' }))],
    ['The code to scan', addComputer(st({ flow: 'join', step: 'qr', qr: QR, expiresAt: NOW + 600, canGrant: true }))],
    ['No Touch ID', addComputer(st({ flow: 'join', step: 'qr', qr: QR, expiresAt: NOW + 600, canGrant: false }))],
    ['Who it joins', addComputer(st({ flow: 'join', step: 'review', identityCode: '731422085561094233751234', origin: { label: 'My iPhone', kind: 'approve-app', at: NOW - 86400 * 3 }, devices: [{ ...phone, addedAt: NOW - 86400 * 3, recent: true }], admitterLabel: 'My iPhone', suggestedLabel: 'This computer', canGrant: true }))],
    ['Name taken', addComputer(st({ flow: 'join', step: 'review', identityCode: '731422085561094233751234', origin: null, devices: [phone], admitterLabel: 'My iPhone', suggestedLabel: 'This computer', canGrant: true, error: 'label_taken' }))],
    ['Touch', addComputer(st({ flow: 'join', step: 'working', doing: 'check' }))],
    ['Waiting for the phone', addComputer(st({ flow: 'join', step: 'waiting', admitterLabel: 'My iPhone' }))],
    ['The code to tap on the phone', addComputer(st({ flow: 'join', step: 'compare', code: '482913', admitterLabel: 'My iPhone' }))],
    ['Added', addComputer(st({ flow: 'join', step: 'done', signedIn: true }))],
    ['Code ran out', addComputer(st({ flow: 'join', step: 'failed', code: 'qr_expired' }))],
  ]],
];

const frames = groups.map(([g, items]) => `<h2>${g}</h2><div class="row">${items.map(([cap, el]) => { const m = renderToStaticMarkup(el); return `<figure><figcaption><b>${g}</b><br>${cap}</figcaption><div class="pair"><div class="page" data-theme="light"><div class="tag">day</div>${m}</div><div class="page" data-theme="dark"><div class="tag">dark</div>${m}</div></div></figure>`; }).join('')}</div>`).join('\n');

writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Suveren - gateway pairing screens</title>
<style>${css}
body{padding:24px;background:#d8d8d8;font-family:var(--font-sans)}
h1,h2{font-family:var(--font-sans);margin:24px 0 8px}
.row{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
figure{margin:0}
.pair{display:flex;gap:16px}
.tag{font:11px var(--font-sans);color:var(--text-muted);padding:6px 12px 0}
figcaption{font:13px/1.4 var(--font-sans);margin-bottom:6px;color:#333}
.page{width:480px;min-height:420px;overflow:hidden;background:var(--bg-main);color:var(--text-primary);border:1px solid #888;border-radius:12px}
.page .device-screen{padding-top:1.5rem}
</style></head><body><h1>Gateway page: pairing screens (real components, DRAFT texts, day and dark)</h1>${frames}</body></html>`);
console.log(`wrote ${out}`);
