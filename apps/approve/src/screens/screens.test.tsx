import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { P, errorText } from '../texts';
import { NeedsScreen, WelcomeScreen } from './Start';
import { RegisterScreen, type RegisterScreenProps } from './Register';
import { JoinScreen } from './Join';
import { AdmitScreen } from './Admit';
import { DevicesScreen, DeviceList } from './Devices';
import { RequestsScreen } from './Requests';
import { OpenSessionScreen } from './OpenSession';
import { ScanView } from './ScanView';
import { PHONE_FIRST_SETUP } from '../lib/config';
import type { DeviceRow } from '../lib/chain-view';

const html = (el: ReactElement): string => renderToStaticMarkup(el);
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};
const NOW = 1_800_000_000;

const rows: DeviceRow[] = [
  { keyId: 'k1', label: 'Office Mac', kind: 'gateway', thisDevice: false, canGrant: true, addedAt: NOW - 40 * 86400, recent: false },
  { keyId: 'k2', label: 'My iPhone', kind: 'approve-app', thisDevice: true, canGrant: true, addedAt: NOW - 3600, recent: true },
];

const reg = (state: RegisterScreenProps['state'], over: Partial<RegisterScreenProps> = {}) => html(
  <RegisterScreen state={state} code={null} onCode={noop} onName={noop} onCodeSeen={noop} onKept={noop} onFinish={noop} onCancel={noop} onDone={noop} {...over} />,
);

describe('the phone screens (both widths use the same markup and the same tokens)', () => {
  it('a phone that lacks something says which ability, and nothing else', () => {
    const t = text(html(<NeedsScreen needs={['install_app', 'newer_system']} />));
    expect(t).toContain(P.needsTitle);
    expect(t).toContain(P.needsInstall);
    expect(t).toContain(P.needsSystem);
    expect(t).not.toContain(P.needsPasskey);
  });

  it('the start screen offers both ways in and says the phone only reads for now', () => {
    const t = text(html(<WelcomeScreen onNew={noop} onJoin={noop} />));
    expect(t).toContain(P.welcomeNew);
    expect(t).toContain(P.welcomeJoin);
    expect(t).toContain(P.welcomeReadOnly);
  });

  it('DEC-83: phone-first setup is off; the start is "add this phone", with no way back to another choice', () => {
    expect(PHONE_FIRST_SETUP).toBe(false);
    const joinProps = { nowSeconds: NOW, onScanned: noop, onReviewConfirm: noop, onName: noop, onCancel: noop, onDone: noop };
    const m = html(<JoinScreen {...joinProps} state={{ step: 'scan', busy: false }} />);
    expect(text(m)).toContain(P.joinIntro);
    expect(text(m)).not.toContain(P.welcomeNew);
    expect(text(m)).not.toContain(P.back);
    expect(text(html(<JoinScreen {...joinProps} canGoBack state={{ step: 'scan', busy: false }} />))).toContain(P.back);
  });

  describe('register (kept and unit-tested, unreachable from the app while DEC-83 holds)', () => {
    it('code step: scan or type', () => {
      const t = text(reg({ step: 'code', busy: false }));
      expect(t).toContain(P.scanStart);
      expect(t).toContain(P.setupCodeLabel);
    });

    it('the recovery code is on the sheet, as text and as a QR of rects, and print is offered', () => {
      const code = 'SV1-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12-3';
      const m = reg({ step: 'sheet' }, { code });
      expect(m).toContain(code);
      expect(m).toContain('data-testid="recovery-qr"');
      expect((m.match(/<rect /g) ?? []).length).toBeGreaterThan(50);
      expect(text(m)).toContain(P.codePrint);
      expect(text(m)).toContain(P.codeOnce);
      // The whole sheet is inside the part that prints.
      expect(m.indexOf('recovery-code-print')).toBeLessThan(m.indexOf(code));
      // An inline style attribute would be blocked by the CSP: the QR carries none.
      expect(m.slice(m.indexOf('<svg'), m.indexOf('</svg>'))).not.toContain('style=');
    });

    it('no other step shows the recovery code, even when it is passed', () => {
      const code = 'SV1-ABCD-EFGH-JKMN-PQRS-TVWX-YZ12-3';
      for (const state of [
        { step: 'code', busy: false }, { step: 'name', busy: false }, { step: 'kept', checked: false },
        { step: 'working', doing: 'check' }, { step: 'failed', error: 'x', canRetry: true }, { step: 'done' },
      ] as RegisterScreenProps['state'][]) expect(reg(state, { code })).not.toContain(code);
    });

    it('kept: the button is off until the box is ticked', () => {
      expect(reg({ step: 'kept', checked: false })).toMatch(/<button[^>]*disabled[^>]*>Continue/);
      expect(reg({ step: 'kept', checked: true })).not.toMatch(/<button[^>]*disabled[^>]*>Continue/);
    });

    it('working says what is asked of the person; failed says what happened and offers the right next step', () => {
      expect(text(reg({ step: 'working', doing: 'passkey' }))).toContain(P.doPasskey);
      expect(text(reg({ step: 'working', doing: 'check' }))).toContain(P.doCheck);
      const retry = reg({ step: 'failed', error: errorText('cancelled'), canRetry: true });
      expect(text(retry)).toContain(P.tryAgain);
      const restart = reg({ step: 'failed', error: errorText('ENROLMENT_CODE_USED'), canRetry: false });
      expect(text(restart)).toContain(P.startAgain);
      expect(restart).toContain('role="alert"');
    });
  });

  describe('join and admit', () => {
    const joinProps = { nowSeconds: NOW, onScanned: noop, onReviewConfirm: noop, onName: noop, onCancel: noop, onDone: noop };

    it('review shows the identity code, where the identity was made, and the devices, before any key exists', () => {
      const t = text(html(<JoinScreen {...joinProps} state={{
        step: 'review',
        facts: { identityCode: '1234 5678 9012 3456 7890 1234', origin: { label: 'Office Mac', kind: 'gateway', at: NOW - 3 * 86400 }, devices: rows, admitterLabel: 'Office Mac' },
      }} />));
      expect(t).toContain('1234 5678 9012 3456 7890 1234');
      expect(t).toContain(P.reviewMade('Office Mac', P.whenDaysAgo(3)));
      expect(t).toContain('Office Mac');
      expect(t).toContain(P.reviewButton);
      expect(t).toContain(P.reviewNotMine);
    });

    it('compare shows the six digits and who to compare them with', () => {
      const m = html(<JoinScreen {...joinProps} state={{ step: 'compare', code: '042517', admitterLabel: 'Office Mac' }} />);
      expect(m).toContain('042517');
      expect(text(m)).toContain(P.compareBody('Office Mac'));
    });

    it('the failed and done screens', () => {
      expect(text(html(<JoinScreen {...joinProps} state={{ step: 'failed', error: errorText('bad_message') }} />))).toContain(errorText('bad_message'));
      expect(text(html(<JoinScreen {...joinProps} state={{ step: 'done' }} />))).toContain(P.joinDoneTitle);
    });

    it('admit: three codes to tap, the new device marked, the list after', () => {
      const choice = { codes: ['111111', '222222', '333333'], kind: 'gateway' as const, label: 'New Mac', rows: [...rows, { keyId: 'k3', label: 'New Mac', kind: 'gateway' as const, thisDevice: false, canGrant: false, addedAt: NOW, recent: true, adding: true }] };
      const m = html(<AdmitScreen state={{ step: 'choose', choice }} nowSeconds={NOW} onScanned={noop} onChoose={noop} onCancel={noop} onDone={noop} />);
      expect((m.match(/data-testid="code-choice"/g) ?? []).length).toBe(3);
      expect(text(m)).toContain(P.admitChooseTitle('New Mac'));
      expect(text(m)).toContain(P.admitChooseBody);
      expect(m).toContain('data-new="true"');
      expect(text(m)).toContain(P.admitNew);
    });

    it('admit done lists the devices and tells the person not to trust the new computer before it is in the list', () => {
      const t = text(html(<AdmitScreen state={{ step: 'done', label: 'New Mac', rows }} nowSeconds={NOW} onScanned={noop} onChoose={noop} onCancel={noop} onDone={noop} />));
      expect(t).toContain(P.admitDoneTitle('New Mac'));
      expect(t).toContain(P.admitAfter);
    });
  });

  describe('the device list', () => {
    it('marks this phone, says what each device can do and how long ago it was added; labels are plain text', () => {
      const evil: DeviceRow = { ...rows[0], keyId: 'k9', label: '<img src=x onerror=alert(1)>' };
      const m = html(<DeviceList rows={[...rows, evil]} nowSeconds={NOW} />);
      expect(text(m)).toContain(P.devThisPhone);
      expect(text(m)).toContain(P.devKindComputer);
      expect(text(m)).toContain(P.devKindPhone);
      expect(text(m)).toContain(P.devRecent);
      expect(m).not.toContain('<img');
      expect(m).toContain('&lt;img');
    });

    it('the screen shows the identity code, storage, the app version and build, and "updated" once', () => {
      const m = html(<DevicesScreen rows={rows} identityCode="1234 5678 9012 3456 7890 1234" nowSeconds={NOW} persistent={false} updated version="0.1.0" build="abc123" onAddComputer={noop} onRefresh={noop} />);
      const t = text(m);
      expect(t).toContain('1234 5678 9012 3456 7890 1234');
      expect(t).toContain(P.storageNotPersistent);
      expect(t).toContain(P.appVersion('0.1.0', 'abc123'));
      expect(t).toContain(P.appUpdated);
      expect(t).toContain(P.secondIcon);
      expect(t).toContain(P.devAddComputer);
      expect(text(html(<DevicesScreen rows={rows} identityCode={null} nowSeconds={NOW} persistent updated={false} version="0.1.0" build="abc" onAddComputer={noop} onRefresh={noop} />))).toContain(P.storagePersistent);
    });
  });

  describe('requests (read-only)', () => {
    const prop = (id: string, tool: string) => ({ id, tool, createdAt: NOW - 600, expiresAt: NOW + 3600, status: 'pending' }) as never;

    it('says what is loading, what is empty, and that approving is on the computer', () => {
      expect(text(html(<RequestsScreen proposals={null} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />))).toContain(P.listLoading);
      const empty = text(html(<RequestsScreen proposals={[]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />));
      expect(empty).toContain(P.listEmpty);
      expect(empty).toContain(P.welcomeReadOnly);
    });

    it('a row is the gateway page\'s row markup, with the action name and its age', () => {
      const m = html(<RequestsScreen proposals={[prop('p1', 'email__send_message')]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />);
      expect(m).toContain('data-testid="approval-row"');
      expect(m).toContain('av3-row');
      expect(text(m)).toContain('Send message');
      expect(text(m)).toContain('10 min');
    });

    it('a failed read is said, not hidden behind an empty list', () => {
      const t = text(html(<RequestsScreen proposals={[]} error={P.listFailed} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />));
      expect(t).toContain(P.listFailed);
      expect(t).not.toContain(P.listEmpty);
    });
  });

  it('the open-the-app screen: the touch, and the clear-this-phone way out only where opening can never work', () => {
    const t1 = text(html(<OpenSessionScreen busy={false} error={null} ended={false} onOpen={noop} />));
    expect(t1).toContain(P.openBody);
    expect(t1).not.toContain(P.forgetButton);
    const t2 = text(html(<OpenSessionScreen busy={false} error={errorText('device_removed')} ended onOpen={noop} onForget={noop} />));
    expect(t2).toContain(P.openEnded);
    expect(t2).toContain(errorText('device_removed'));
    expect(t2).toContain(P.forgetButton);
  });

  it('the scan view always carries a frame, the instruction and the progress line, because the preview can stay black', () => {
    const m = html(<ScanView onText={noop} onCancel={noop} />);
    expect(m).toContain('ap-scan-frame');
    expect(text(m)).toContain(P.scanFrame);
    expect(text(m)).toContain(P.scanBlackNote);
    expect(m).toContain('data-testid="scan-progress"');
  });
});
