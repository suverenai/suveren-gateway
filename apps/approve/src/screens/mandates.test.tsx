/**
 * The phone's mandate screens (Mandates.tsx; mockup v6 A1–A6, B2, F2): what each state draws, as static markup.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, MandatePayload } from '@hap/core';
import type { MandateGrant } from '@hap/core/device-keys';
import { P } from '../texts';
import { GiveCard, GiveRow, OwnMandates, EndScreen } from './Mandates';
import type { GiveItem } from '../lib/mandate-give';
import type { OwnMandate } from '../lib/mandate-end';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8')) as AgentProfile;
const NOW = 1_800_000_000;
const item: GiveItem = {
  key: 'give:mandate-1:1', mandateId: 'mandate-1', version: 1, op: 'grant', preparedBy: 'Office Mac', preparedAt: NOW - 120, title: 'Quotes',
  profile: SALES, bounds: { profile: SALES.id, value_max: 1000 }, scope: { currency: 'EUR' }, intent: 'Why: quotes wait two days.',
  payload: { above_cap_approvers: ['did:key:z6MkApprover'], above_cap_approvals: 1 } as unknown as MandatePayload, members: {},
  expiresAt: NOW + 14 * 86400, lastsSeconds: 14 * 86400,
};
const noop = () => {};
const card = (state: Parameters<typeof GiveCard>[0]['state']) => renderToStaticMarkup(
  <GiveCard state={state} nowSeconds={NOW} onGive={noop} onLater={noop} onCancelTouch={noop} onCheckAgain={noop} onDone={noop} dismissLabel="Next" />,
);

describe('a mandate to give on the phone', () => {
  it('the row names it as a mandate to give (A1)', () => {
    const html = renderToStaticMarkup(<GiveRow item={item} nowSeconds={NOW} onOpen={noop} />);
    expect(html).toContain(P.giveRowKind);
    expect(html).toContain(P.giveTitle('Quotes'));
  });

  it('the review shows what is signed: title, summary line, who prepared it, limits, scope, how long, approvers folded, the intent; the touch button pinned (A2)', () => {
    const html = card({ step: 'review', item });
    expect(html).toContain('data-testid="give-title"');
    expect(html).toContain('data-testid="mandate-summary"');
    expect(html).toContain('Prepared on Office Mac');
    expect(html).toContain('data-testid="give-limits"');
    expect(html).not.toContain('>profile<'); // the profile id is not a limit
    expect(html).toContain('data-testid="give-scope"');
    expect(html).toContain('14 days');
    expect(html).toContain(P.giveCheckCode); // the identity code folded (DEC-88)
    expect(html).toContain('Why: quotes wait two days.');
    expect(html).toMatch(/<footer class="av3-foot">[\s\S]*data-testid="btn-give"[\s\S]*<\/footer>/);
    expect(html).toContain(P.giveButton);
  });

  it('while the touch is asked: only the waiting line and Cancel, no give button (DEC-88)', () => {
    const html = card({ step: 'checking', item });
    expect(html).toContain('data-testid="touch-wait"');
    expect(html).toContain('data-testid="touch-cancel"');
    expect(html).not.toContain('data-testid="btn-give"');
  });

  it('a failed touch: the error with Try again and Cancel', () => {
    const html = card({ step: 'checking', item, error: 'Your touch did not work this time.' });
    expect(html).toContain('data-testid="touch-failed"');
    expect(html).toContain('data-testid="touch-retry"');
  });

  it('signing, then the gateway\'s own result: "Signed" and who received it (A5)', () => {
    expect(card({ step: 'sending', item })).toContain('data-testid="decision-working"');
    const html = card({ step: 'signed', item, receivedBy: 'Office Mac' });
    expect(html).toContain('data-testid="decision-stamp"');
    expect(html).toContain(P.giveSigned);
    expect(html).toContain(P.giveReceivedBy('Office Mac'));
    expect(html).not.toContain('data-testid="btn-give"');
  });

  it('not received: ONE state, problem first, "Check again" primary and Next (UI review, DEC-88)', () => {
    const html = card({ step: 'not_received', item, grant: {} as MandateGrant, checking: false, checkedOnce: false });
    expect(html).toContain('data-testid="decision-unknown"');
    expect(html).toContain(P.giveNotReceived('Office Mac'));
    expect(html).not.toContain('data-testid="decision-stamp"');
    expect(html).toMatch(/data-testid="result-check"[^>]*>Check again/);
    expect(html).toContain('data-testid="result-dismiss"');
  });
});

describe('ending a mandate on the phone', () => {
  const m: OwnMandate = { authorizationId: 'authz_x', mandateId: 'mandate-1', version: 1, title: 'Quotes', expiresAt: NOW + 86400, fields: {}, givenOn: null, givenAt: null };

  it('the list offers End on each of the person\'s mandates (44 px)', () => {
    const html = renderToStaticMarkup(<OwnMandates items={[m]} nowSeconds={NOW} onEnd={noop} />);
    expect(html).toContain('data-testid="btn-end"');
    expect(html).toContain('min-height:44px');
  });

  it('the end screen is the gateway\'s screen 4: warning, "Keep it" above the button that names what ends; no touch (B2)', () => {
    const html = renderToStaticMarkup(<EndScreen state={{ step: 'confirm', item: m }} onEnd={noop} onKeep={noop} onDone={noop} />);
    expect(html).toContain('data-testid="end-warning"');
    expect(html.indexOf('data-testid="end-keep"')).toBeLessThan(html.indexOf('data-testid="end-confirm"'));
    expect(html).toContain('Quotes');
  });

  it('done: said, with the way back', () => {
    const html = renderToStaticMarkup(<EndScreen state={{ step: 'done', item: m }} onEnd={noop} onKeep={noop} onDone={noop} />);
    expect(html).toContain('data-testid="end-done"');
  });
});
