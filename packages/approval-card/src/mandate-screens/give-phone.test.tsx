/** "Give on your phone" footer (DEC-90, mockup phone-d3-live.html v7, Gateway view): the five states. Static markup: a state is its props. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GivePhoneFooter, givePhoneRefusalText, type GivePhoneView } from './GivePhone';
import { S13 } from './texts';

const noop = () => {};
const draw = (view: GivePhoneView, disabled = false) => renderToStaticMarkup(<GivePhoneFooter view={view} onGive={noop} onStop={noop} onClose={noop} disabled={disabled} />);
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('Give on your phone: the footer', () => {
  it('offered: the reason and "Give on your phone" as the primary button', () => {
    const h = draw({ s: 'offered' });
    expect(text(h)).toContain(S13.givePhoneOffer);
    expect(h).toMatch(/av3-btn av3-btn-primary"[^>]*data-testid="give-phone-send"/);
    expect(h).not.toContain('disabled=""');
  });
  it('offered but the give is not ready: the button cannot be pressed', () => {
    expect(draw({ s: 'offered' }, true)).toMatch(/disabled=""[^>]*data-testid="give-phone-send"/);
  });
  it('waiting: only the spinner line, the note and "Stop waiting"; no give button', () => {
    const h = draw({ s: 'waiting' });
    expect(h).toContain('av3-spin');
    expect(text(h)).toContain(S13.givePhoneWaiting);
    expect(h).toContain('data-testid="give-phone-stop"');
    expect(h).not.toContain('give-phone-send');
  });
  // The shared result stamp (ResultStamp, DEC-86/88): over the card, the stamp centred, ONE full-width Close pinned below it,
  // the same as after a give with Touch ID (the hosts no longer add their own "Go to my mandates" / Close).
  it('given: the shared result stamp with one Close', () => {
    const h = draw({ s: 'given' });
    expect(h).toContain('av3-given');
    expect(h).toContain('av3-stamp');
    expect(text(h)).toContain(S13.givePhoneGiven);
    expect(h.match(/<button/g)?.length).toBe(1);
    expect(h).toContain('give-phone-done');
  });
  it('stopped: says nothing was given and offers it again', () => {
    const h = draw({ s: 'stopped' });
    expect(text(h)).toContain(S13.givePhoneStopped);
    expect(h).toContain('give-phone-again');
  });
  it('refused: the reason in an alert and one Close button', () => {
    const h = draw({ s: 'refused', message: S13.givePhoneMismatch });
    expect(h).toContain('role="alert"');
    expect(text(h)).toContain(S13.givePhoneMismatch);
    expect(h.match(/<button/g)).toHaveLength(1);
  });
  it('a grant that does not match what this page prepared gets its own sentence', () => {
    expect(givePhoneRefusalText('grant_invalid', 'other')).toBe(S13.givePhoneMismatch);
    expect(givePhoneRefusalText('changed_since_prepare', 'other')).toBe(S13.givePhoneMismatch);
    expect(givePhoneRefusalText('as_answer_invalid', 'other')).toBe('other');
  });
});
