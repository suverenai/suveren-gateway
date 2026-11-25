/**
 * The phone's card for a computer's change to a connector login (stage D3, mockup E1–E3 as approved): the gateway's card markup,
 * the crossed-out old value of a `text` field and no value of a secret one, the two buttons pinned at the bottom, the touch wait with
 * Cancel, "Confirming…" without Cancel, the gateway's result stamp, and ONE pinned button after "Not allowed" or "Run out".
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { P } from '../texts';
import { configurePhoneHost } from '../lib/app-host';
import type { ChangeCardState, ChangeItem } from '../lib/change-requests';
import { ChangeCard } from './ChangeCard';
import { RequestsScreen } from './Requests';

configurePhoneHost();
const html = (el: ReactElement): string => renderToStaticMarkup(el);
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};
const NOW = 1_800_000_000;

const item = (kind: 'replace' | 'remove' = 'replace'): ChangeItem => ({
  requestId: 'AAAAAAAAAAAAAAAAAAAAAA', createdAt: NOW - 60, expiresAt: NOW + 252, gatewayLabel: 'Home Mac',
  view: {
    typ: 'suveren-change-request', v: 1, connector: 'Gmail', issued_at: NOW - 60,
    request: { request_id: 'AAAAAAAAAAAAAAAAAAAAAA', kind, name: 'gmail', change_hash: 'c'.repeat(64), gateway_key_id: 'k'.repeat(43), expires_at: NOW + 252 },
    fields: kind === 'remove' ? [] : [
      { key: 'clientId', label: 'Client ID', secret: false, old: 'old.apps', new: 'new.apps' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
  },
});
const card = (state: ChangeCardState, o: { kind?: 'replace' | 'remove'; nextTitle?: string | null } = {}) => html(
  <ChangeCard item={item(o.kind)} state={state} nowSeconds={NOW} onConfirm={noop} onDeny={noop} onCancelTouch={noop} dismissLabel="Next" onDismiss={noop} nextTitle={o.nextTitle ?? null} />,
);

describe('the change card (mockup E2/E3)', () => {
  it('names the computer, the change and its effect, the time left; old value crossed out, the secret without a value', () => {
    const h = card({ step: 'idle' });
    const t = text(h);
    expect(t).toContain(P.changeConfirmTitle);
    expect(t).toContain(P.changeAskedBy('Home Mac'));
    expect(t).toContain(`${P.changeReplaceTitle('Gmail')}.`);
    expect(t).toContain(P.changeRunsOut('4:12'));
    expect(h).toContain('<span class="mc-old">old.apps</span>');
    expect(h).toContain('<span class="mc-new">new.apps</span>');
    expect(t).toContain(`Client secret ${P.changeFieldSecret}`);
    // the gateway's card: the middle scrolls, the two buttons are pinned in the footer
    expect(h).toContain('class="av3-scroll"');
    expect(h).toMatch(/<footer class="av3-foot">[\s\S]*data-testid="change-confirm"[\s\S]*data-testid="change-deny"/);
    expect(t).toContain(P.changeConfirmButton);
    expect(t).toContain(P.changeDeny);
  });

  it('a removal says the AI can no longer use the connector and names no field', () => {
    const t = text(card({ step: 'idle' }, { kind: 'remove' }));
    expect(t).toContain(P.changeRemoveTitle('Gmail'));
    expect(t).toContain(P.changeRemoveEffect('Gmail'));
    expect(t).not.toContain('Client ID');
  });

  it('the touch: only "Waiting for your touch…" and Cancel; a failed touch says so with Try again', () => {
    const h = card({ step: 'touch' });
    expect(text(h)).toContain(P.touchWait);
    expect(h).toContain('data-testid="touch-cancel"');
    expect(h).not.toContain('data-testid="change-confirm"');
    const f = card({ step: 'touch', error: 'Your touch did not work this time.' });
    expect(f).toContain('data-testid="touch-retry"');
  });

  it("after the touch 'Confirming…' with no Cancel; then the gateway's stamp with 'Next: …'", () => {
    const s = card({ step: 'sending', decision: 'allow' });
    expect(text(s)).toContain(P.changeConfirming);
    expect(s).not.toContain('touch-cancel');
    const c = card({ step: 'confirmed' }, { nextTitle: P.changeRemoveTitle('Mollie') });
    expect(c).toContain('class="av3-check"');
    expect(text(c)).toContain(P.changeConfirmed);
    expect(text(c)).toContain(P.changeRecorded);
    expect(text(c)).toContain(P.changeNext(P.changeRemoveTitle('Mollie')));
    expect(c).not.toContain('data-testid="change-dismiss"');
  });

  it('"Not allowed" and "Run out" are alerts with ONE full-width pinned button', () => {
    for (const st of [{ step: 'denied' }, { step: 'expired' }] as ChangeCardState[]) {
      const h = card(st);
      expect(h.match(/<button/g)?.length, st.step).toBe(1);
      expect(h).toMatch(/<footer class="av3-foot" data-testid="change-over">[\s\S]*role="alert"[\s\S]*data-testid="change-dismiss"/);
    }
    expect(text(card({ step: 'denied' }))).toContain(P.changeNotAllowed('Home Mac', 'Gmail'));
    expect(text(card({ step: 'expired' }))).toContain(P.changeExpired);
  });
});

describe('the list (mockup E1)', () => {
  it('a change request is a row typed "Change", above the requests', () => {
    const h = html(<RequestsScreen proposals={[]} changes={[item('remove')]} nowMs={NOW * 1000} onOpen={noop} onRefresh={noop} onOpenChange={noop} />);
    const t = text(h);
    expect(t).toContain(P.changeRowType);
    expect(t).toContain(P.changeRemoveTitle('Gmail'));
    expect(h).not.toContain('data-testid="list-empty"');
  });
});
