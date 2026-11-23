import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPasskeyCard, PASSKEY_TEXT, passkeyRefusalText, type PasskeyCardView } from './DashboardPasskeyCard';

const noop = () => {};
const request = { code: '482913', email: 'owner@dev.local', credentialAt: 1_800_000_000, expiresAt: 1_800_000_600 };
const html = (view: PasskeyCardView, canApprove = true) =>
  renderToStaticMarkup(<DashboardPasskeyCard request={request} view={view} canApprove={canApprove} onApprove={noop} onCancel={noop} onClose={noop} />);

describe('dashboard passkey card: the approval look on every device', () => {
  it('offered: the code to compare (grouped), the account, and the pinned "… with your touch" button', () => {
    const h = html({ s: 'offered' });
    expect(h).toContain(PASSKEY_TEXT.title);
    expect(h).toContain('482 913');
    expect(h).toContain('owner@dev.local');
    expect(h).toContain(PASSKEY_TEXT.button);
    expect(h).toContain('av3-foot');
  });
  it('touch and sending: one line with the spinner, no approve button; Cancel only while the touch is asked', () => {
    const t = html({ s: 'touch' });
    expect(t).toContain(PASSKEY_TEXT.waiting);
    expect(t).toContain('av3-spin');
    expect(t).toContain(PASSKEY_TEXT.cancel);
    expect(t).not.toContain(PASSKEY_TEXT.button);
    const s = html({ s: 'sending' });
    expect(s).toContain(PASSKEY_TEXT.sending);
    expect(s).not.toContain(PASSKEY_TEXT.cancel);
    expect(s).not.toContain(PASSKEY_TEXT.button);
  });
  it('added: the result stamp and Close, nothing else', () => {
    const h = html({ s: 'added' });
    expect(h).toContain('av3-stamp');
    expect(h).toContain(PASSKEY_TEXT.added);
    expect(h).toContain(PASSKEY_TEXT.close);
    expect(h).not.toContain(PASSKEY_TEXT.button);
    // The shared result stamp (ResultStamp): over the card, centred above the pinned Close, in a card with its own height.
    expect(h).toContain('av3-given');
    expect(h).toContain('av3-given-alone');
    expect(h).not.toContain('position:static');
  });
  it('a refusal is shown above the footer and the button comes back', () => {
    const h = html({ s: 'offered', error: PASSKEY_TEXT.gone });
    expect(h).toContain(PASSKEY_TEXT.gone);
    expect(h).toContain(PASSKEY_TEXT.button);
  });
  it('a device that cannot approve says so and offers no button', () => {
    const h = html({ s: 'offered' }, false);
    expect(h).toContain(PASSKEY_TEXT.noCheck);
    expect(h).not.toContain(PASSKEY_TEXT.button);
  });
  it('refusal codes in words', () => {
    expect(passkeyRefusalText('passkey_request_gone')).toBe(PASSKEY_TEXT.gone);
    expect(passkeyRefusalText('PASSKEY_REQUEST_EXPIRED')).toBe(PASSKEY_TEXT.gone);
    expect(passkeyRefusalText('check_failed')).toBe(PASSKEY_TEXT.touchFailed);
    expect(passkeyRefusalText('as_unreachable')).toBe(PASSKEY_TEXT.failed);
  });
});
