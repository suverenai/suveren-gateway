/** Screen 3: one card per mandate this gateway holds back: plain reason, one next step. Shows only what the gateway verified. */
import type { HeldBackMandate } from './interface';
import { S13 } from './texts';

export function heldCardText(m: HeldBackMandate): { reason: string; step: string | null; action: 'check_again' | 'give_again' | null } {
  const owner = m.ownerName ?? S13.heldOwnerYou;
  const o = m.ownerIsYou ? S13.heldOwnerYou : owner;
  switch (m.reason) {
    case 'not_received': return { reason: S13.heldNotReceived, step: null, action: 'check_again' };
    case 'check_required':
      return m.ownerIsYou
        ? { reason: S13.heldOwnNoCheck, step: null, action: 'give_again' }
        : { reason: S13.heldNoCheck(o), step: S13.heldNoCheckStep, action: null };
    case 'owner_unknown': return { reason: S13.heldNotOnList(o), step: S13.heldNotOnListStep(m.adminName ?? S13.heldAdminUnknown), action: null };
    case 'revoked': return { reason: S13.heldEnded(o), step: S13.heldEndedStep, action: null };
    default: return { reason: S13.heldChanged(o), step: S13.heldChangedStep, action: null };
  }
}

export function HeldBackCard({ mandate, onCheckAgain, onGiveAgain }: { mandate: HeldBackMandate; onCheckAgain?: () => void; onGiveAgain?: () => void }) {
  const t = heldCardText(mandate);
  return (
    <div className="card" data-testid="held-card" data-reason={mandate.reason} style={{ marginBottom: '0.75rem' }}>
      <strong>{S13.heldName(mandate.profileName, mandate.ownerIsYou ? S13.heldOwnerYou : mandate.ownerName ?? S13.heldOwnerYou)}</strong>
      <p style={{ margin: '0.5rem 0' }}>{t.reason}</p>
      {t.step && <p style={{ margin: '0.5rem 0', color: 'var(--text-secondary)' }} data-testid="held-step">{t.step}</p>}
      {t.action === 'check_again' && <button type="button" className="btn btn-secondary" onClick={onCheckAgain}>{S13.heldCheckAgain}</button>}
      {t.action === 'give_again' && <button type="button" className="btn btn-primary" onClick={onGiveAgain}>{S13.heldGiveAgain}</button>}
    </div>
  );
}

/** The list: nothing at all when no mandate is held back. */
export function HeldBackList({ mandates, onCheckAgain, onGiveAgain }: { mandates: HeldBackMandate[]; onCheckAgain?: (id: string) => void; onGiveAgain?: (id: string) => void }) {
  if (mandates.length === 0) return null;
  return (
    <section data-testid="held-list" style={{ maxWidth: 560 }}>
      <h3 className="card-title">{S13.heldTitle}</h3>
      {mandates.map(m => <HeldBackCard key={m.mandateId} mandate={m} onCheckAgain={() => onCheckAgain?.(m.mandateId)} onGiveAgain={() => onGiveAgain?.(m.mandateId)} />)}
    </section>
  );
}
