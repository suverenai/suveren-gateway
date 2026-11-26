import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { P, errorText, blockedText } from '../texts';
import { configurePhoneHost } from '../lib/app-host';
import { NeedsScreen, WelcomeScreen } from './Start';
import { RegisterScreen, type RegisterScreenProps } from './Register';
import { JoinScreen } from './Join';
import { AdmitScreen } from './Admit';
import { DevicesScreen, DeviceList, RemoveScreen } from './Devices';
import { RequestsScreen, RequestDetail } from './Requests';
import { RequestPanel } from './RequestPanel';
import { RotateScreen } from './Rotate';
import type { CardCheck, ReadyCard } from '../lib/card-checks';
import { OpenSessionScreen } from './OpenSession';
import { ScanView } from './ScanView';
import { PHONE_FIRST_SETUP } from '../lib/config';
import type { DeviceRow } from '../lib/chain-view';

configurePhoneHost();
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

    it('compare (DEC-96): says first that the next step is on the computer, and shows the number large', () => {
      const m = html(<JoinScreen {...joinProps} state={{ step: 'compare', code: '042517', admitterLabel: 'Office Mac' }} />);
      expect(m).toContain('042517');
      expect(text(m)).toContain(P.showTitle);
      expect(text(m)).toContain(P.tapThis('Office Mac'));
      // the instruction comes before the number, and the number is the big variant
      expect(m.indexOf('compare-next')).toBeLessThan(m.indexOf('compare-code'));
      expect(m).toContain('2.75rem');
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
      // DEC-96: the computer is ready — said above the choices, and the first choice takes the focus
      expect(m).toContain('data-testid="other-ready"');
      expect(text(m)).toContain(P.otherReady);
      expect(m.indexOf('other-ready')).toBeLessThan(m.indexOf('code-choices'));
      expect(text(m)).toContain(P.admitChooseBody);
      expect(text(m)).toContain(P.admitNew);
    });

    it('admit done lists the devices and tells the person not to trust the new computer before it is in the list', () => {
      const t = text(html(<AdmitScreen state={{ step: 'done', label: 'New Mac', rows }} nowSeconds={NOW} onScanned={noop} onChoose={noop} onCancel={noop} onDone={noop} />));
      expect(t).toContain(P.admitDoneTitle('New Mac'));
      expect(t).toContain(P.admitAfter);
    });
  });

  describe('the device list', () => {
    it('marks this phone, says each device\'s kind and when it was added, in two lines; labels are plain text', () => {
      const evil: DeviceRow = { ...rows[0], keyId: 'k9', label: '<img src=x onerror=alert(1)>' };
      const m = html(<DeviceList rows={[...rows, evil]} nowSeconds={NOW} />);
      expect(text(m)).toContain(P.devThisPhone);
      expect(text(m)).toContain(P.devKindComputer);
      expect(text(m)).toContain(P.devKindPhone);
      expect(text(m)).not.toContain(P.devRecent);
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

  describe('requests', () => {
    const prop = (id: string, tool: string) => ({ id, tool, profileId: 'email@0.4', authorizationId: 'a1', createdAt: NOW - 600, expiresAt: NOW + 3600, status: 'pending' }) as never;

    it('says what is loading, what is empty, and that the person decides here', () => {
      // DEC-98: loading is the list's own rows greyed out, named for screen readers; no empty text while it loads.
      const loading = html(<RequestsScreen proposals={null} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />);
      expect(loading).toContain('data-testid="request-skeleton"');
      expect(loading).toContain(`aria-label="${P.listLoading}"`);
      expect(text(loading)).not.toContain(P.listEmpty);
      const empty = text(html(<RequestsScreen proposals={[]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />));
      expect(empty).toContain(P.listEmpty);
      expect(empty).toContain(P.welcomeReadOnly);
    });

    it('"Nothing is waiting for you." sits right under the heading, before "Your mandates"; never when a mandate waits to be given', () => {
      const below = <section data-testid="own-mandates"><h2>{P.mineTitle}</h2></section>;
      const h = html(<RequestsScreen proposals={[]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} below={below} />);
      expect(h.indexOf('data-testid="list-empty"')).toBeGreaterThan(h.indexOf(P.listTitle));
      expect(h.indexOf('data-testid="list-empty"')).toBeLessThan(h.indexOf('data-testid="own-mandates"'));
      const giving = html(<RequestsScreen proposals={[]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} waiting={<div data-testid="give-list" />} waitingCount={1} below={below} />);
      expect(giving).not.toContain('data-testid="list-empty"');
      expect(giving.indexOf('data-testid="give-list"')).toBeLessThan(giving.indexOf('data-testid="own-mandates"'));
    });

    it('a row is the gateway page\'s row markup, with the action name and its age', () => {
      const m = html(<RequestsScreen proposals={[prop('p1', 'email__send_message')]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />);
      expect(m).toContain('data-testid="approval-row"');
      expect(m).toContain('dash-rows');
      expect(m).toContain('av3-row');
      expect(text(m)).toContain('Send message');
      expect(text(m)).toContain('Email'); // the gateway row's own area line, from the proposal's profile
    });

    describe('the open request (stage D2)', () => {
      const proposal = { id: 'p1', tool: 'email__send_message', profileId: 'email@0.4', authorizationId: 'a1', createdAt: NOW - 600, expiresAt: NOW + 3600, status: 'pending', toolArgs: { to: 'anna@example.com' }, executionContext: {}, pendingDomains: ['owner'], committedBy: {}, rejectedBy: null, executionResult: null, path: 'x' } as never;
      const readyCard: ReadyCard = { facts: { mandateId: 'm1', actionType: 'send' }, contentHash: 'sha256:' + '0'.repeat(64), args: {}, executionContext: {}, display: {}, route: { kind: 'domain', domain: 'owner' } };
      const open = (check: CardCheck | null) => html(<RequestDetail proposal={proposal} userId="u1" check={check} decide={async () => ({})} onBack={noop} />);

      it('with every check passed: the gateway page\'s own approve, ask-for-changes and reject buttons', () => {
        const m = open({ ok: true, ready: readyCard });
        expect(m).toContain('data-testid="btn-approve"');
        expect(m).toContain('data-testid="btn-reject"');
        expect(m).toContain('data-testid="btn-change-needed"');
        expect(m).not.toContain('changes-elsewhere');
        expect(m).not.toContain('data-testid="card-blocked"');
      });

      it('the server\'s plain toolArgs are never drawn: the card is given only what this phone checked (H1)', () => {
        const lying = { ...(proposal as object), toolArgs: { to: 'anna@example.com', amount: '10 EUR to Anna' }, executionContext: { amount: 10 } } as never;
        const m = html(<RequestDetail proposal={lying} userId="u1" check={{ ok: true, ready: { ...readyCard, executionContext: { amount: 9999 } } }} decide={async () => ({})} onBack={noop} />);
        expect(m).not.toContain('10 EUR to Anna');
        expect(m).not.toContain('anna@example.com');
        const b = html(<RequestDetail proposal={lying} userId="u1" check={{ ok: false, reason: 'content_mismatch' }} decide={async () => ({})} onBack={noop} />);
        expect(b).not.toContain('10 EUR to Anna');
      });

      it('while the checks run: no buttons, and it says it is checking', () => {
        const m = open(null);
        expect(m).not.toContain('data-testid="btn-approve"');
        expect(m).not.toContain('data-testid="btn-reject"');
        expect(text(m)).toContain(P.cardChecking);
      });

      it('a check that failed: no buttons at all, the reason in words, nothing about a code', () => {
        const m = open({ ok: false, reason: 'content_mismatch' });
        expect(m).not.toContain('data-testid="btn-approve"');
        expect(m).not.toContain('data-testid="btn-reject"');
        expect(m).toContain('data-testid="card-blocked"');
        expect(text(m)).toContain(blockedText('content_mismatch'));
        expect(text(m)).toContain(P.cardBlockedTitle);
        expect(text(m)).not.toContain('content_mismatch');
      });
    });

    describe('the panel that opens by itself (DEC-86: the gateway\'s mechanism)', () => {
      const proposal = { id: 'p1', tool: 'email__send_message', profileId: 'email@0.4', authorizationId: 'a1', createdAt: NOW - 600, expiresAt: NOW + 3600, status: 'pending', toolArgs: {}, executionContext: {}, pendingDomains: ['owner'], committedBy: {}, rejectedBy: null, executionResult: null, path: 'x' } as never;
      const readyCard: ReadyCard = { facts: { mandateId: 'm1', actionType: 'send' }, contentHash: 'sha256:' + '0'.repeat(64), args: {}, executionContext: {}, display: {}, route: { kind: 'domain', domain: 'owner' } };
      const panel = (over: Partial<Parameters<typeof RequestPanel>[0]> = {}) => html(
        <RequestPanel position={{ index: 1 }} total={2} prevId={null} nextId="p2" onMove={noop} onLater={noop} autoOpen onToggleAuto={noop}
          shown={{ proposal, card: { userId: 'u1', check: { ok: true, ready: readyCard }, decide: async () => ({}) } }} {...over} />,
      );

      it('is the gateway\'s panel: full screen, the compact head with "1 of 2", ‹ ›, the setting and Later', () => {
        const m = panel();
        expect(m).toContain('apr-panel is-open ap-panel');
        expect(m).toContain('apr-head is-compact');
        expect(text(m)).toContain('Waiting for you');
        expect(m).toContain('data-testid="approval-position"');
        expect(text(m)).toContain('1 of 2');
        expect(m).toContain('data-testid="approval-prev"');
        expect(m).toContain('data-testid="approval-next"');
        expect(m).toContain('data-testid="approval-head-menu"');
        expect(m).toContain('data-testid="approval-later"');
      });

      it('an AI-proposed mandate or change is never approved here: no Approve, only Reject, and the line that it is given with the touch', () => {
        for (const tool of ['setup__create_mandate', 'setup__change_mandate']) {
          const m = panel({ shown: { proposal: { ...(proposal as object), tool } as never, card: { userId: 'u1', check: { ok: true, ready: readyCard }, decide: async () => ({}) } } });
          expect(m).not.toContain('data-testid="btn-approve"');
          expect(m).toContain('data-testid="btn-reject"');
          expect(m).toContain('data-testid="give-not-here-yet"');
          expect(text(m)).toContain(P.mandateGivenNotApproved);
        }
        expect(panel()).toContain('data-testid="btn-approve"');
      });

      it('the card sits in the gateway\'s stage, with its buttons in the fixed footer', () => {
        const m = panel();
        expect(m).toContain('apr-body');
        expect(m).toContain('apr-stage');
        expect(m).toContain('av3-scroll');
        expect(m).toMatch(/<footer class="av3-foot">[\s\S]*data-testid="btn-approve"/);
      });

      it('one waiting approval: no arrows; a setting that could not be read: no switch (never guessed)', () => {
        const m = panel({ total: 1, nextId: null, autoOpen: null });
        expect(m).not.toContain('data-testid="approval-prev"');
        expect(m).not.toContain('data-testid="approval-head-menu"');
        expect(m).toContain('data-testid="approval-later"');
      });

      it('while a decision is being signed the head moves nothing: no arrows, Later and the setting disabled (nav lock)', () => {
        const m = panel({ prevId: 'p0', nextId: 'p2', locked: true });
        expect(m).toMatch(/data-testid="approval-prev"[^>]*disabled|disabled[^>]*data-testid="approval-prev"/);
        expect(m).toMatch(/disabled[^>]*data-testid="approval-next"/);
        expect(m).toMatch(/disabled[^>]*data-testid="approval-later"/);
        expect(m).toMatch(/disabled[^>]*data-testid="approval-head-menu"/);
        const free = panel({ prevId: 'p0', nextId: 'p2' });
        expect(free).not.toMatch(/disabled[^>]*data-testid="approval-later"/);
      });

      it('while the approval is read: the panel says so, and no card', () => {
        const m = panel({ shown: null });
        expect(m).toContain('data-testid="panel-card-skeleton"');
        expect(m).toContain(`aria-label="${P.listLoading}"`);
        expect(m).not.toContain('apr-stage');
      });
    });

    it('a failed read is said, not hidden behind an empty list', () => {
      const t = text(html(<RequestsScreen proposals={[]} error={P.listFailed} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} />));
      expect(t).toContain(P.listFailed);
      expect(t).not.toContain(P.listEmpty);
    });
  });

  describe('removing a device (stage D3, mockup C1–C5)', () => {
    const office = rows[0];
    const me = rows[1];
    const rs = (state: Parameters<typeof RemoveScreen>[0]['state']) => html(<RemoveScreen state={state} nowSeconds={NOW} onConfirm={noop} onCancel={noop} onCancelTouch={noop} onAdd={noop} onDone={noop} />);

    it('UI review (DEC-88): a device added in the last 14 days carries "new" and its own warning on its row, with Remove as its own button', () => {
      const fresh: DeviceRow = { keyId: 'k3', label: 'Home Mac', kind: 'gateway', thisDevice: false, canGrant: false, addedAt: NOW - 3600, recent: true };
      const m = html(<DeviceList rows={[...rows, fresh]} nowSeconds={NOW} onRemove={noop} />);
      const homeRow = m.slice(m.indexOf('Home Mac') - 300);
      expect(text(homeRow)).toContain(`Home Mac ${P.admitNew} Computer · added today`);
      expect(homeRow).toMatch(/data-testid="row-warn">Added today\. If this was not you, remove it\.</);
      expect(homeRow).toMatch(/class="btn btn-secondary btn-sm su-rm"[^>]*aria-label="Remove Home Mac"/);
      // This phone (also recent) gets no warning about itself.
      expect(m.match(/data-testid="row-warn"/g)).toHaveLength(1);
    });

    it('UI review (DEC-88): the remove screen shows the device being removed at the top, the effect in a warning box, and the safe option above the destructive one', () => {
      const m = rs({ step: 'confirm', target: office, after: [me], self: false });
      expect(m.indexOf('data-testid="removing"')).toBeLessThan(m.indexOf('data-testid="remove-warning"'));
      expect(text(m.slice(m.indexOf('data-testid="removing"'), m.indexOf('data-testid="remove-warning"')))).toContain('Office Mac');
      expect(m.indexOf('data-testid="remove-cancel"')).toBeLessThan(m.indexOf('data-testid="remove-confirm"'));
      expect(m).toMatch(/class="btn btn-outline-strong btn-lg"[^>]*data-testid="remove-confirm">Remove Office Mac with your touch</);
      expect(text(rs({ step: 'confirm', target: me, after: [office], self: true }))).toContain('Remove this phone with your touch');
    });

    it('every row has Remove, this phone included (DEC-85)', () => {
      const m = html(<DeviceList rows={rows} nowSeconds={NOW} onRemove={noop} />);
      expect(m.match(/data-testid="device-remove"/g)).toHaveLength(2);
      expect(html(<DeviceList rows={rows} nowSeconds={NOW} />)).not.toContain('device-remove');
    });

    it('a computer: what it does, its logins, the list after the change, then the touch button', () => {
      const t = text(rs({ step: 'confirm', target: office, after: [me], self: false }));
      expect(t).toContain(P.removeTitle('Office Mac'));
      expect(t).toContain(P.removeComputerEffect('Office Mac'));
      expect(t).toContain(P.removeLogins('Office Mac'));
      expect(t).toContain(P.removeListAfter);
      expect(t).toContain(P.removeButtonNamed('Office Mac', false));
      expect(t).toContain('My iPhone');
    });

    it('this phone: its own words, no logins line', () => {
      const t = text(rs({ step: 'confirm', target: me, after: [office], self: true }));
      expect(t).toContain(P.removeSelfTitle);
      expect(t).toContain(P.removeSelfEffect);
      expect(t).not.toContain(P.removeLogins('My iPhone'));
    });

    it('refused before the touch: the reason, no touch button, a way to add a device', () => {
      const m = rs({ step: 'refused', target: me, self: true, error: errorText('last_granting_self') });
      expect(m).toContain('data-testid="remove-refused"');
      expect(text(m)).toContain(errorText('last_granting_self'));
      expect(text(m)).not.toMatch(/with your touch/);
      expect(text(m)).toContain(P.devAddComputer);
    });

    it('while the touch is asked: "Waiting for your touch…" with the gateway\'s spinner in place of the buttons, and Cancel', () => {
      const m = rs({ step: 'checking', target: office, self: false });
      expect(m).toContain('data-testid="touch-wait"');
      expect(m).toContain('av3-spin');
      expect(text(m)).toContain(P.touchWait);
      expect(text(m)).not.toMatch(/with your touch/);
      expect(m).toContain('data-testid="touch-cancel"');
      expect(m.match(/<button/g)).toHaveLength(1);
    });

    it('a failed touch: said in the same place, with Try again and Cancel', () => {
      const m = rs({ step: 'checking', target: office, self: false, error: errorText('check_failed') });
      expect(m).toContain('data-testid="touch-failed"');
      expect(text(m)).toContain(errorText('check_failed'));
      expect(m).toContain('data-testid="touch-retry"');
      expect(m).toContain('data-testid="touch-cancel"');
      expect(m).not.toContain('av3-spin');
    });

    it('done: the new list', () => {
      const t = text(rs({ step: 'done', label: 'Office Mac', rows: [me], self: false }));
      expect(t).toContain(P.removeDone('Office Mac'));
      expect(t).toContain(P.removeListNow);
    });

    it('the devices screen shows the notices from the other devices', () => {
      const m = html(<DevicesScreen rows={rows} identityCode={null} nowSeconds={NOW} persistent={null} updated={false} version="0" build="x" onAddComputer={noop} onRefresh={noop} notices={[P.noticeAdded('Home Mac', 'today', 'Office Mac')]} />);
      expect(m).toContain('data-testid="chain-notice"');
      expect(text(m)).toContain('Home Mac was added to your account today on Office Mac. If this was not you, remove it.');
    });

    it('removed on another device (C5): the start screen says so', () => {
      const m = html(<JoinScreen state={{ step: 'scan', busy: false }} nowSeconds={NOW} onScanned={noop} onReviewConfirm={noop} onName={noop} onCancel={noop} onDone={noop} notice={errorText('device_removed')} />);
      expect(m).toContain('data-testid="join-notice"');
      expect(text(m)).toContain(errorText('device_removed'));
    });
  });

  describe('replacing the recovery code (DEC-85, mockup D1–D5)', () => {
    const rot = (state: Parameters<typeof RotateScreen>[0]['state']) => html(<RotateScreen state={state} onOld={noop} onNew={noop} onCancel={noop} onCancelTouch={noop} onRetryTouch={noop} onDone={noop} />);

    it('DEC-96: the join\'s done screen offers nothing about the recovery code, only Continue', () => {
      const m = html(<JoinScreen state={{ step: 'done' }} nowSeconds={NOW} onScanned={noop} onReviewConfirm={noop} onName={noop} onCancel={noop} onDone={noop} />);
      expect(m).not.toContain('rotate-offer');
      expect(text(m)).not.toContain(P.rotateStart);
      expect(text(m)).toContain(P.continue);
    });

    it('DEC-96: the devices screen keeps replacing reachable as a plain section with the one-sentence why', () => {
      const m = html(<DevicesScreen rows={rows} identityCode={null} nowSeconds={NOW} persistent={null} updated={false} version="0" build="x" onAddComputer={noop} onRefresh={noop} onRotate={noop} />);
      expect(m).toContain('rotate-section');
      expect(text(m)).toContain(P.rotateWhy);
      expect(P.rotateWhy).toBe('Replace it if anyone could have seen your screen when you set up.');
      expect(text(m)).toContain(P.rotateStart);
    });

    it('the old code: scan or type, never shown back', () => {
      const m = rot({ step: 'old', busy: false });
      expect(text(m)).toContain(P.rotateOldScan);
      expect(m).toContain('type="password"');
    });

    it('the new code once: "Write it on paper" only (no print), never give it to the AI, typed again, the touch button', () => {
      const t = text(rot({ step: 'new', code: 'SV1-AAAA-BBBB' }));
      expect(t).toContain('SV1-AAAA-BBBB');
      expect(t).toContain(P.rotateNewPaper);
      expect(P.rotateNewPaper.toLowerCase()).not.toContain('print');
      expect(t).not.toContain(P.codePrint);
      expect(t).toContain(P.codeNever);
      expect(t).toContain(P.rotateButton);
    });

    it('the touch: "Waiting for your touch…" with the spinner and Cancel, no code; a failure offers Try again', () => {
      const m = rot({ step: 'checking' });
      expect(m).toContain('data-testid="touch-wait"');
      expect(m.match(/<button/g)).toHaveLength(1);
      const f = rot({ step: 'checking', error: errorText('cancelled') });
      expect(f).toContain('data-testid="touch-retry"');
    });

    it('waiting for the email: where it went, the six digits to compare', () => {
      const t = text(rot({ step: 'waiting', confirmCode: '123456', email: 'a•••@example.com', expiresAt: NOW + 600 }));
      expect(t).toContain(P.rotateEmail('a•••@example.com'));
      expect(t).toContain(P.rotateCompare);
      expect(t).toContain('123456');
      expect(t).toContain(P.rotateWaiting);
    });

    it('done: the old code no longer works; throw the paper away', () => {
      const t = text(rot({ step: 'done' }));
      expect(t).toContain(P.rotateDone);
      expect(t).toContain(P.rotateThrowAway);
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

describe('notifications on the phone screens (stage D4)', () => {
  it('the requests screen offers them with "Not now", and counts requests that came without a notice', () => {
    const m = html(<RequestsScreen proposals={[]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} pushOffer={{ onOn: noop, onNotNow: noop }} missed={2} />);
    const t = text(m);
    expect(m).toContain('data-testid="push-offer"');
    expect(t).toContain(P.pushOfferTitle);
    expect(t).toContain(P.pushTurnOn);
    expect(t).toContain(P.pushNotNow);
    expect(t).toContain(P.pushMissed(2));
    const none = html(<RequestsScreen proposals={[]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} missed={0} />);
    expect(none).not.toContain('push-offer');
    expect(none).not.toContain('push-missed');
  });

  it('the devices screen says the state in one sentence and offers the one button that changes it', () => {
    const at = (state: 'on' | 'off' | 'denied' | 'unsupported') => text(html(
      <DevicesScreen rows={rows} identityCode={null} nowSeconds={NOW} persistent updated={false} version="0.1.0" build="abc" onAddComputer={noop} onRefresh={noop}
        push={{ state, onOn: noop, onOff: noop }} />,
    ));
    expect(at('on')).toContain(P.pushStateOn);
    expect(at('on')).toContain(P.pushTurnOff);
    expect(at('on')).not.toContain(P.pushTurnOn);
    expect(at('off')).toContain(P.pushTurnOn);
    expect(at('denied')).toContain(P.pushStateDenied);
    expect(at('denied')).not.toContain(P.pushTurnOn);
    expect(at('unsupported')).toContain(P.pushStateUnsupported);
  });
});
