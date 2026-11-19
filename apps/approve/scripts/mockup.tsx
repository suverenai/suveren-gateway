/**
 * Writes one static HTML page with every phone screen and its important states, side by side in 390 px frames, rendered from the
 * REAL components (renderToStaticMarkup, as screens.test.tsx does) with the real CSS inlined. No network, no fonts, light theme.
 *
 *   vite-node.mjs (from node_modules/.pnpm/vite-node@3.2.4...) --config vite.config.ts scripts/mockup.tsx <output.html>
 *   (run in apps/approve; tsx cannot be used: the shared package's JSX needs the vite react plugin)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { P, errorText } from '../src/texts';
import { configurePhoneHost } from '../src/lib/app-host';
import type { DeviceRow } from '../src/lib/chain-view';
import { NeedsScreen } from '../src/screens/Start';
import { JoinScreen } from '../src/screens/Join';
import { AdmitScreen } from '../src/screens/Admit';
import { DevicesScreen } from '../src/screens/Devices';
import { RequestsScreen, RequestDetail } from '../src/screens/Requests';
import { OpenSessionScreen } from '../src/screens/OpenSession';
import { FIXTURE_PLAIN_PROPOSAL } from '../../../packages/approval-card/src/fixture/fixture-proposal';

configurePhoneHost();
const out = process.argv[2];
if (!out) throw new Error('usage: mockup.tsx <output.html>');
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// No external fonts: the @font-face blocks go, the system fonts of the token stack stay.
const css = [read('../../ui/src/styles/tokens.css'), read('../../ui/src/styles/design-system.css').replace(/@font-face\s*\{[^}]*\}/g, ''), read('../src/approve.css')].join('\n');

const NOW = Math.floor(Date.now() / 1000);
const noop = () => {};
const rows: DeviceRow[] = [
  { keyId: 'k1', label: 'Office Mac', kind: 'gateway', thisDevice: false, canGrant: true, addedAt: NOW - 40 * 86400, recent: false },
  { keyId: 'k2', label: 'My iPhone', kind: 'approve-app', thisDevice: true, canGrant: true, addedAt: NOW - 3600, recent: true },
];
const join = (state: Parameters<typeof JoinScreen>[0]['state'], scanning = false) => (
  <JoinScreen state={state} nowSeconds={NOW} onScanned={noop} onReviewConfirm={noop} onName={noop} onCancel={noop} onDone={noop} scanning={scanning} />
);
const admit = (state: Parameters<typeof AdmitScreen>[0]['state']) => (
  <AdmitScreen state={state} nowSeconds={NOW} onScanned={noop} onChoose={noop} onCancel={noop} onDone={noop} />
);
const prop = (id: string, tool: string, age: number) => ({ ...FIXTURE_PLAIN_PROPOSAL, id, tool, createdAt: NOW - age });

const groups: Array<[string, Array<[string, ReactElement]>]> = [
  ['This phone cannot pair', [['Needs screen: iPhone tab, old system', <NeedsScreen needs={['install_app', 'newer_system']} />]]],
  ['Add this phone to an account (the start screen, DEC-83)', [
    ['Start: scan', join({ step: 'scan', busy: false })],
    ['Scan: camera open', join({ step: 'scan', busy: false }, true)],
    ['Review before any key is made', join({ step: 'review', facts: { identityCode: '4821 0937 5516 2204 7789 1350', origin: { label: 'Office Mac', kind: 'gateway', at: NOW - 40 * 86400 }, devices: rows.slice(0, 1), admitterLabel: 'Office Mac' } })],
    ['Name', join({ step: 'name', busy: false, admitterLabel: 'Office Mac' })],
    ['Compare the code', join({ step: 'compare', code: '042517', admitterLabel: 'Office Mac' })],
    ['Done', join({ step: 'done' })],
  ]],
  ['Add a computer', [
    ['Scan', admit({ step: 'scan', busy: false })],
    ['Waiting for the computer', admit({ step: 'opening' })],
    ['Choose the code and see the list', admit({ step: 'choose', choice: { codes: ['318402', '042517', '776091'], kind: 'gateway', label: 'Home Mac', rows: [...rows, { keyId: 'k3', label: 'Home Mac', kind: 'gateway', thisDevice: false, canGrant: false, addedAt: NOW, recent: true, adding: true }] } })],
    ['Done: the new list', admit({ step: 'done', label: 'Home Mac', rows: [...rows, { keyId: 'k3', label: 'Home Mac', kind: 'gateway', thisDevice: false, canGrant: false, addedAt: NOW, recent: true }] })],
  ]],
  ['Devices', [['Device list (app updated)', <DevicesScreen rows={rows} identityCode="4821 0937 5516 2204 7789 1350" nowSeconds={NOW} persistent={false} updated version="0.1.0" build="abc1234" onAddComputer={noop} onRefresh={noop} />]]],
  ['Open the app', [['Open with a touch', <OpenSessionScreen busy={false} error={null} ended onOpen={noop} />]]],
  ['Requests', [
    ['Empty', <RequestsScreen proposals={[]} nowMs={Date.now()} onOpen={noop} onRefresh={noop} />],
    ['Two requests', <RequestsScreen proposals={[prop('p1', 'email__send_email', 600), prop('p2', 'crm__create_contact', 7200)]} nowMs={Date.now()} onOpen={noop} onRefresh={noop} />],
    ['Read-only card (no buttons)', <RequestDetail proposal={prop('p1', 'email__send_email', 600)} userId="fixture-owner" contextMissing onBack={noop} />],
  ]],
  ['Scan view', [['Camera frame and progress', join({ step: 'scan', busy: false }, true)]]],
  ['Typical errors', [
    ['Server key not the expected one', <OpenSessionScreen busy={false} error={errorText('as_unverified')} ended={false} onOpen={noop} />],
    ['Pairing went wrong', join({ step: 'failed', error: errorText('bad_message') })],
    ['No screen lock', join({ step: 'failed', error: errorText('no_user_verification') })],
  ]],
];

const frames = groups.map(([g, items]) => `<h2>${g}</h2><div class="row">${items.map(([cap, el]) => `<figure><figcaption><b>${g}</b><br>${cap}</figcaption><div class="phone">${renderToStaticMarkup(el)}</div></figure>`).join('')}</div>`).join('\n');

writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Suveren - phone app D1 screens</title>
<style>${css}
body{padding:24px;background:#d8d8d8;font-family:var(--font-sans)}
h1,h2{font-family:var(--font-sans);margin:24px 0 8px}
.row{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
figure{margin:0;width:390px}
figcaption{font:13px/1.4 var(--font-sans);margin-bottom:6px;color:#333}
.phone{width:390px;min-height:640px;overflow:hidden;background:var(--bg-main);border:1px solid #888;border-radius:24px}
.phone .device-screen{padding-top:2rem}
</style></head><body><h1>Phone app, stage D1: every screen (real components, DRAFT texts, light theme, 390 px)</h1>${frames}</body></html>`);
console.log(`wrote ${out}`);
