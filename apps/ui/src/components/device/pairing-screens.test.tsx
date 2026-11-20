import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PT, pairingErrorText } from '../../lib/pairing-texts';
import type { DevicesAnswer, PairingDeviceRow, PairingView } from '../../lib/device-client';
import type { PairingUiState } from '../../lib/pairing-driver';
import { AddComputerScreen, AddPhoneScreen, DeviceList, DevicesScreen } from './PairingScreens';
import { NotSetUpScreen } from './SetupScreens';
import { AuthContext, type AuthContextValue } from '../../contexts/AuthContext';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../TopNav', () => ({ TopNav: () => <nav data-stub="top-nav" /> }));
vi.mock('../UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('../SimulationBanner', () => ({ SimulationBanner: () => null }));

const NOW = 1_800_000_000;
const html = (el: ReactElement): string => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};

const row = (over: Partial<PairingDeviceRow> = {}): PairingDeviceRow => ({ keyId: 'k1', label: 'Office Mac', kind: 'gateway', thisDevice: true, canGrant: true, addedAt: NOW - 100, recent: false, ...over });
const st = (view: PairingView, over: Partial<PairingUiState> = {}): PairingUiState => ({ view, busy: false, loading: false, ...over });

describe('the Devices page', () => {
  const devices: DevicesAnswer = { rows: [row(), row({ keyId: 'k2', label: 'My iPhone', kind: 'approve-app', thisDevice: false, canGrant: true, addedAt: NOW - 86400 * 2, recent: true })], identityCode: '731422085561094233751234', origin: null, canGrant: true, hasRoom: true };
  const render = (d: DevicesAnswer | null, over: { error?: string } = {}) => html(<DevicesScreen devices={d} nowSeconds={NOW} onAddPhone={noop} onRefresh={noop} onBack={noop} {...over} />);

  it('lists the devices in two lines each (UI review, DEC-88): name with its tag ("This computer", "new"), then kind and when added; the identity code in groups of four; Add a phone', () => {
    const h = render(devices);
    const t = text(h);
    expect(t).toContain(PT.devicesTitle);
    expect(t).toContain('Office Mac This computer Computer · added today');
    expect(t).toContain('My iPhone new Phone · added 2 days ago');
    expect(t).not.toContain(PT.devCanConfirm);
    expect(t).not.toContain(PT.devRecent);
    // The gateway page cannot remove a device: no Remove button and no "remove it" warning on the row.
    expect(h).not.toContain('device-remove');
    expect(h).not.toContain('row-warn');
    expect(t).toContain('7314 2208 5561 0942 3375 1234');
    expect(t).toContain(PT.devAddPhone);
    expect(h).not.toMatch(/<button[^>]*disabled[^>]*>Add a phone/);
  });

  it('uses the shared components and classes (the Team page\'s rows, the shared frame), not markup of its own', () => {
    const h = render(devices);
    expect(h).toContain('class="device-screen"');
    expect(h).toContain('class="ob-tile su-members"');
    expect(h).toContain('class="su-m su-dev"');
    expect(h).toContain('class="btn btn-primary btn-full btn-lg"');
  });

  it('a computer without a check key cannot add a phone, and says so; a full account says so', () => {
    const none = render({ ...devices, canGrant: false });
    expect(text(none)).toContain(PT.devCannotAdd);
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Add a phone/);
    const full = render({ ...devices, hasRoom: false });
    expect(text(full)).toContain(PT.devFull);
    expect(full).toMatch(/<button[^>]*disabled[^>]*>Add a phone/);
  });

  it('loading and an error are shown as they are', () => {
    expect(text(render(null))).toContain(PT.devLoading);
    const e = text(render(null, { error: pairingErrorText('not_signed_in') }));
    expect(e).toContain(pairingErrorText('not_signed_in'));
    expect(e).not.toContain(PT.devLoading);
  });

  it('a label is plain text: markup in it is escaped', () => {
    const h = html(<DeviceList nowSeconds={NOW} rows={[row({ label: '<img src=x onerror=alert(1)>' })]} />);
    expect(h).not.toContain('<img');
  });
});

describe('Add a phone', () => {
  const props = { nowSeconds: NOW, onStart: noop, onChoose: noop, onCancel: noop, onDone: noop };
  const render = (s: PairingUiState) => html(<AddPhoneScreen state={s} {...props} />);

  it('intro, then the QR (an SVG of the shared component, with its time), connecting', () => {
    const intro = text(render(st({ flow: 'none' })));
    expect(intro).toContain(PT.addPhoneTitle); expect(intro).toContain(PT.addPhoneIntro); expect(intro).toContain(PT.addPhoneShow);
    const qr = render(st({ flow: 'admit', step: 'qr', qr: 'SUVEREN-PAIR-1:abc', expiresAt: NOW + 600 }));
    expect(qr).toContain('data-testid="pairing-qr"');
    expect(qr).toContain('class="device-qr"');
    expect(qr).toContain('role="img"');
    expect(qr).toContain(`aria-label="${PT.addPhoneQrLabel}"`);
    expect(text(qr)).toContain(PT.addPhoneScan); expect(text(qr)).toContain(PT.addPhoneQrTime);
    // the secret text is drawn, never printed as text
    expect(text(qr)).not.toContain('SUVEREN-PAIR-1');
    expect(text(render(st({ flow: 'admit', step: 'connected' })))).toContain(PT.addPhoneConnected);
  });

  it('three codes to tap, the new device marked, the list after; a wrong tap is the phone\'s and the control plane\'s to refuse', () => {
    const h = render(st({ flow: 'admit', step: 'choose', label: 'My iPhone', kind: 'approve-app', codes: ['111111', '222222', '333333'], rows: [row(), row({ keyId: 'k3', label: 'My iPhone', kind: 'approve-app', thisDevice: false, adding: true })] }));
    const t = text(h);
    expect(t).toContain('Add "My iPhone"?'); expect(t).toContain(PT.addPhoneChooseBody); expect(t).toContain(PT.addPhoneListTitle);
    expect((h.match(/data-testid="code-choice"/g) ?? []).length).toBe(3);
    for (const c of ['111111', '222222', '333333']) expect(t).toContain(c);
    expect(t).toContain(PT.addPhoneNew);
  });

  it('checking, done with the list, failed with words and a way to start again', () => {
    expect(text(render(st({ flow: 'admit', step: 'checking' })))).toContain(PT.addPhoneChecking);
    const done = text(render(st({ flow: 'admit', step: 'done', label: 'My iPhone', rows: [row(), row({ keyId: 'k2', label: 'My iPhone', kind: 'approve-app', thisDevice: false })] })));
    expect(done).toContain('"My iPhone" was added'); expect(done).toContain(PT.addPhoneDone); expect(done).toContain(PT.addPhoneDoneList);
    const failed = text(render(st({ flow: 'admit', step: 'failed', code: 'wrong_code' })));
    expect(failed).toContain(pairingErrorText('wrong_code')); expect(failed).toContain(PT.startAgain);
  });

  it('an error of a call shows beside the step; the buttons are off while it works', () => {
    const h = render(st({ flow: 'none' }, { error: pairingErrorText('cannot_grant'), busy: true }));
    expect(text(h)).toContain(pairingErrorText('cannot_grant'));
    expect(h).toMatch(/<button[^>]*disabled[^>]*>Show the code/);
  });
});

describe('Add this computer', () => {
  const props = { nowSeconds: NOW, onStart: noop, onConfirm: noop, onCancel: noop, onDone: noop, onRetrySignIn: noop };
  const render = (s: PairingUiState, over: { onBack?: () => void } = {}) => html(<AddComputerScreen state={s} {...props} {...over} />);

  it('intro, then the QR; a computer without Touch ID is told what it will not do', () => {
    expect(text(render(st({ flow: 'none' })))).toContain(PT.addComputerIntro);
    const qr = render(st({ flow: 'join', step: 'qr', qr: 'SUVEREN-PAIR-1:abc', expiresAt: NOW + 600, canGrant: false }));
    expect(qr).toContain('class="device-qr"');
    expect(text(qr)).toContain(PT.addComputerScan);
    expect(text(qr)).toContain(PT.addComputerNoTouch);
    expect(text(render(st({ flow: 'join', step: 'qr', qr: 'x', expiresAt: 1, canGrant: true })))).not.toContain(PT.addComputerNoTouch);
  });

  it('the review says whose identity this computer joins, when and where it was made, every device, and asks the name', () => {
    const h = render(st({
      flow: 'join', step: 'review', identityCode: '731422085561094233751234', origin: { label: 'My iPhone', kind: 'approve-app', at: NOW - 100 },
      devices: [row({ label: 'My iPhone', kind: 'approve-app', thisDevice: false })], admitterLabel: 'My iPhone', suggestedLabel: 'This computer', canGrant: true,
    }));
    const t = text(h);
    expect(t).toContain(PT.reviewTitle);
    expect(t).toContain('7314 2208 5561 0942 3375 1234');
    expect(t).toContain('This account already has an identity, created today on My iPhone. This computer is being added to it.');
    expect(t).toContain(PT.reviewDevices); expect(t).toContain(PT.reviewButton); expect(t).toContain(PT.reviewNotMine);
    expect(h).toContain('value="This computer"');
  });

  it('a refused name shows on the review, and the screen keeps the review', () => {
    const t = text(render(st({
      flow: 'join', step: 'review', identityCode: '1', origin: null, devices: [], admitterLabel: 'x', suggestedLabel: 'This computer', canGrant: true, error: 'label_taken',
    })));
    expect(t).toContain(pairingErrorText('label_taken'));
  });

  it('working (the touch, the sending), waiting, the code, failed, done', () => {
    expect(text(render(st({ flow: 'join', step: 'working', doing: 'check' })))).toContain(PT.workCheck);
    expect(text(render(st({ flow: 'join', step: 'working', doing: 'send' })))).toContain(PT.workSend);
    expect(text(render(st({ flow: 'join', step: 'waiting', admitterLabel: 'My iPhone' })))).toContain(PT.waitingFor('My iPhone'));
    const cmp = render(st({ flow: 'join', step: 'compare', code: '482913', admitterLabel: 'My iPhone' }));
    expect(cmp).toContain('data-testid="compare-code"');
    expect(text(cmp)).toContain('482913'); expect(text(cmp)).toContain(PT.compareBody('My iPhone'));
    expect(text(render(st({ flow: 'join', step: 'failed', code: 'qr_expired' })))).toContain(pairingErrorText('qr_expired'));
    const ok = text(render(st({ flow: 'join', step: 'done', signedIn: true })));
    expect(ok).toContain(PT.addedComputerTitle); expect(ok).toContain(PT.addedComputerBody);
    const noSignin = render(st({ flow: 'join', step: 'done', signedIn: false }));
    expect(text(noSignin)).toContain(PT.addedComputerNoSignin); expect(text(noSignin)).toContain(PT.tryAgain);
  });
});

describe('where "Add this computer" is offered', () => {
  const auth = (): AuthContextValue => ({
    user: null, access: 'password', deviceKeysSwitch: true, passwordSet: true, pageSessionOpen: true, sessionEnd: null,
    refreshAccess: async () => ({ access: 'password', switchOn: true, passwordSet: true }), openPageSession: () => {}, adoptSessionUser: async () => true, clearSessionEnd: () => {},
    mode: 'personal', group: null, domain: '', groupId: null, activeTeam: null, activeMembership: null, pendingRequest: null,
    isLoading: false, error: '', login: async () => {}, logout: async () => {}, clearError: () => {}, handleSessionLocked: () => {},
    activeGroup: null, activeDomain: '', groups: [], setActiveContext: () => {}, refreshGroups: async () => {},
  });

  it('on the screen of a computer that is not set up, between Sign In and the recovery code', () => {
    const h = renderToStaticMarkup(<MemoryRouter><AuthContext.Provider value={auth()}><NotSetUpScreen /></AuthContext.Provider></MemoryRouter>);
    const t = text(h);
    expect(t).toContain(PT.addComputerLink);
    expect(h.indexOf('Sign In')).toBeLessThan(h.indexOf(PT.addComputerLink));
  });
});

describe('day and dark mode', () => {
  const css = readFileSync(fileURLToPath(new URL('../../styles/design-system.css', import.meta.url)), 'utf8');
  it('the QR and the code buttons are in the design system, on tokens; the QR keeps dark on light in both themes', () => {
    expect(css).toMatch(/\.device-qr \{[^}]*color-scheme: light; background: Canvas/);
    expect(css).toMatch(/\.device-qr rect \{ fill: CanvasText; \}/);
    expect(css).toMatch(/\.device-choices \{[^}]*grid-template-columns: repeat\(3, 1fr\)/);
    // the frame's gap between stacked buttons must not push buttons two and three of the row down
    expect(css).toMatch(/\.device-screen \.device-choices \.btn \+ \.btn \{ margin-top: 0; \}/);
    const block = css.slice(css.indexOf('.device-qr {'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});
