/**
 * Screen 3: the mandates the person's AI cannot use, as the approved On-hold mockup v2 shows them (Andreas, 2026-11-24, DEC-109/110/111).
 * A card appears only when the person can or should act on it, and carries the button for that; "waiting for someone" is its own calm
 * section; a give still on its way is never shown on the gateway (the phone shows a calm note after 10 minutes, see `NotReceivedNote`).
 * Shows only what the host verified itself: the gateway's verdict, the phone's own grant check. The AI never adds text here.
 */
import type { HeldBackMandate } from './interface';
import { S13 } from './texts';

export type HeldHost = 'gateway' | 'phone';
export type HeldAction = 'give_again' | 'end';

export interface HeldCardText {
  /** The card's name: the mandate's title for the person's own, "<area>, from <owner>" for a colleague's. */
  name: string;
  /** The first line; the alarm's starts with ✕ and is bold. */
  reason: string;
  step: string | null;
  alarm: boolean;
  actions: HeldAction[];
}

const ownerOf = (m: HeldBackMandate): string => (m.ownerIsYou ? S13.heldOwnerYou : m.ownerName ?? S13.heldSomeone);

export function heldCardName(m: HeldBackMandate): string {
  if (m.ownerIsYou) return m.title?.trim() || m.profileName;
  return S13.heldName(m.profileName, m.ownerName ?? S13.heldSomeone);
}

/** What one card says and offers. `null`: this reason is not shown as an on-hold card (waiting, on its way, ended). */
export function heldCardText(m: HeldBackMandate): HeldCardText | null {
  const name = heldCardName(m);
  const own = m.ownerIsYou;
  const owner = ownerOf(m);
  switch (m.reason) {
    case 'alarm':
      return {
        name, reason: S13.heldAlarm(owner), alarm: true,
        step: own ? (m.workspace === 'personal' ? S13.heldAlarmPersonal : S13.heldAlarmTeam) : S13.heldAlarmColleague(owner),
        actions: own ? ['give_again', 'end'] : [],
      };
    case 'rules_changed':
      return own
        ? { name, reason: S13.heldRulesChanged(m.profileName), step: null, alarm: false, actions: ['give_again'] }
        : { name, reason: S13.heldRulesChangedColleague(m.profileName, owner), step: S13.heldOnlyOwner(owner), alarm: false, actions: [] };
    case 'touch_missing':
      return own
        ? { name, reason: S13.heldTouchMissing, step: null, alarm: false, actions: ['give_again'] }
        : { name, reason: S13.heldTouchMissingColleague(owner), step: S13.heldOnlyOwner(owner), alarm: false, actions: [] };
    case 'unknown':
      return own
        ? { name, reason: S13.heldOnHold, step: null, alarm: false, actions: ['give_again', 'end'] }
        : { name, reason: S13.heldOnHold, step: S13.heldOnlyOwner(owner), alarm: false, actions: [] };
    default:
      return null;
  }
}

export function HeldBackCard({ mandate, host = 'gateway', onGiveAgain, onEnd }: { mandate: HeldBackMandate; host?: HeldHost; onGiveAgain?: () => void; onEnd?: () => void }) {
  const t0 = heldCardText(mandate);
  if (!t0) return null;
  // A button is shown only when the host can do it (a host without a handler shows the words alone, never a dead button).
  const t = { ...t0, actions: t0.actions.filter((a) => (a === 'give_again' ? !!onGiveAgain : !!onEnd)) };
  return (
    <div className="card" data-testid="held-card" data-reason={mandate.reason} style={{ marginBottom: '0.75rem' }}>
      <strong>{t.name}</strong>
      <p style={{ margin: '0.5rem 0', fontWeight: t.alarm ? 700 : undefined }} data-testid="held-reason">{t.reason}</p>
      {t.step && <p style={{ margin: '0.5rem 0', color: 'var(--text-secondary)' }} data-testid="held-step">{t.step}</p>}
      {t.actions.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
          {t.actions.includes('give_again') && (
            <button type="button" className="btn btn-primary" data-testid="held-give-again" onClick={onGiveAgain}>
              {host === 'phone' ? S13.heldGiveAgainPhone : S13.heldGiveAgain}
            </button>
          )}
          {t.actions.includes('end') && <button type="button" className="btn btn-secondary" data-testid="held-end" onClick={onEnd}>{S13.heldEnd}</button>}
        </div>
      )}
    </div>
  );
}

/** "Waiting for someone else": the owner of a colleague's mandate is not yet confirmed by the team's admin. Calm, no button. */
export function HeldWaitingCard({ mandate }: { mandate: HeldBackMandate }) {
  return (
    <div className="card" data-testid="held-waiting-card" style={{ marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
        <strong>{heldCardName(mandate)}</strong>
        <span className="status-badge" style={{ borderStyle: 'dashed', borderColor: 'var(--border-strong)' }} data-testid="held-waiting-pill">{S13.heldWaitPill}</span>
      </div>
      <p style={{ margin: '0.5rem 0' }}>{S13.heldWaitConfirm(mandate.adminName ?? S13.heldAdminUnknown, mandate.ownerName ?? S13.heldSomeone)}</p>
    </div>
  );
}

/**
 * The lists: "Waiting for someone else", then "On hold". Nothing at all when nothing is to be shown. On the gateway a give on its
 * way (`not_received`) is never listed (a running gateway takes it in within seconds); an ended mandate belongs with the ended ones.
 */
export function HeldBackList({ mandates, host = 'gateway', onGiveAgain, onEnd }: {
  mandates: HeldBackMandate[]; host?: HeldHost; onGiveAgain?: (m: HeldBackMandate) => void; onEnd?: (m: HeldBackMandate) => void;
}) {
  const waiting = mandates.filter((m) => m.reason === 'waiting_confirm');
  const held = mandates.filter((m) => heldCardText(m) !== null);
  if (waiting.length === 0 && held.length === 0) return null;
  return (
    <>
      {waiting.length > 0 && (
        <section data-testid="held-waiting-list" style={{ maxWidth: 560 }}>
          <h3 className="card-title">{S13.heldWaitTitle}</h3>
          {waiting.map((m) => <HeldWaitingCard key={m.mandateId} mandate={m} />)}
        </section>
      )}
      {held.length > 0 && (
        <section data-testid="held-list" style={{ maxWidth: 560 }}>
          <h3 className="card-title">{host === 'phone' ? S13.heldTitlePhone : S13.heldTitle}</h3>
          {held.map((m) => <HeldBackCard key={m.mandateId} mandate={m} host={host} onGiveAgain={onGiveAgain ? () => onGiveAgain(m) : undefined} onEnd={onEnd ? () => onEnd(m) : undefined} />)}
        </section>
      )}
    </>
  );
}

/** The phone's calm note for its own give the computer has not taken in after 10 minutes (mockup v2, case 2). Never on the gateway. */
export const NOT_RECEIVED_AFTER_S = 600;
export function NotReceivedNote({ title, device, minutes }: { title: string; device: string; minutes: number }) {
  return (
    <div className="card" data-testid="held-not-received" style={{ marginBottom: '0.75rem' }}>
      <strong>{title}</strong>
      <p style={{ margin: '0.5rem 0' }}>{S13.heldNotReceivedPhone(device)}</p>
      <p style={{ margin: '0.25rem 0', color: 'var(--text-secondary)' }}>{S13.heldGivenAgo(minutes)}</p>
    </div>
  );
}
