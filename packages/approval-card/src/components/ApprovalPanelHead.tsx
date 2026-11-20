/**
 * The head of the approval panel: "Waiting for you", Previous / "k of N" / Next, Later and the
 * "Open automatically" setting. One implementation for every host (the gateway page's
 * ApprovalPanelHost and the phone app's request panel), so the two can never drift. Moved here
 * unchanged from apps/ui/src/components/ApprovalPanelHost.tsx.
 *
 * `compact`: one row (the gateway below 1100px, and the phone always) with ‹ › icons, a ⋮ menu for
 * the setting and ✕ for Later. Otherwise the wide row with words.
 */
import { useState } from 'react';

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg className="apr-i" viewBox="0 0 16 16" aria-hidden="true"><path d={dir === 'left' ? 'M10 3 5 8l5 5' : 'm6 3 5 5-5 5'} /></svg>
);

export interface ApprovalPanelHeadProps {
  compact: boolean;
  /** k of "k of N"; null when the shown id is not in the list. */
  position: { index: number } | null;
  /** N. The arrows show only when N > 1. */
  total: number;
  /** The ids to move to; null disables that arrow. */
  prevId: string | null;
  nextId: string | null;
  onMove: (id: string) => void;
  onLater: () => void;
  /** The setting; null = it could not be read, and the switch is left out (never guessed). */
  autoOpen: boolean | null;
  /** Turns the setting the other way: the host decides what "off" also does (the gateway sends the panel away). */
  onToggleAuto: () => void;
  /** A decision is being signed: nothing in the head moves the person away (the phone's touch; UI review). Default false. */
  locked?: boolean;
}

export function ApprovalPanelHead({ compact, position, total, prevId: prev, nextId: next, onMove, onLater, autoOpen, onToggleAuto, locked = false }: ApprovalPanelHeadProps) {
  const prevId = locked ? null : prev;
  const nextId = locked ? null : next;
  const [menu, setMenu] = useState(false);
  const many = total > 1;
  const pos = position ? `${position.index} of ${total}` : '';
  const autoLabel = autoOpen ? 'Don’t open automatically' : 'Open automatically';

  if (compact) {
    return (
      <header className="apr-head is-compact">
        <h2 className="apr-title" tabIndex={-1} data-apr-focus>Waiting for you</h2>
        {many ? (
          <nav className="apr-nav" aria-label="Move between approvals">
            <button type="button" className="av3-btn apr-ico" aria-label="Previous approval" disabled={!prevId} onClick={() => prevId && onMove(prevId)} data-testid="approval-prev"><Chevron dir="left" /></button>
            <span className="apr-pos" data-testid="approval-position" aria-live="polite">{pos}</span>
            <button type="button" className="av3-btn av3-btn-primary apr-ico" aria-label="Next approval" disabled={!nextId} onClick={() => nextId && onMove(nextId)} data-testid="approval-next"><Chevron dir="right" /></button>
          </nav>
        ) : <span className="apr-nav-ph" />}
        <div className="apr-acts">
          {autoOpen !== null && (
            <span className="apr-menu-wrap">
              <button type="button" className="apr-btn apr-ico-plain" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={menu} disabled={locked} onClick={() => setMenu((o) => !o)} data-testid="approval-head-menu">&#8942;</button>
              {menu && (
                <div className="apr-pop apr-head-pop" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={`av3-btn apr-auto${autoOpen ? '' : ' av3-btn-primary'}`}
                    onClick={() => { setMenu(false); onToggleAuto(); }}
                    data-testid="approval-auto-toggle"
                  >
                    {autoLabel}
                  </button>
                </div>
              )}
            </span>
          )}
          <button type="button" className="apr-btn apr-ico-plain" aria-label="Later" title="Later" disabled={locked} onClick={() => { setMenu(false); onLater(); }} data-testid="approval-later">
            <svg className="apr-i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="apr-head">
      <h2 className="apr-title" tabIndex={-1} data-apr-focus>Waiting for you</h2>
      {many ? (
        <nav className="apr-nav" aria-label="Move between approvals">
          <button type="button" className="av3-btn" disabled={!prevId} onClick={() => prevId && onMove(prevId)} data-testid="approval-prev">
            <Chevron dir="left" /> Previous
          </button>
          <span className="apr-pos" data-testid="approval-position" aria-live="polite">{pos}</span>
          <button type="button" className="av3-btn av3-btn-primary" disabled={!nextId} onClick={() => nextId && onMove(nextId)} data-testid="approval-next">
            Next <Chevron dir="right" />
          </button>
        </nav>
      ) : <span className="apr-nav-ph" />}
      <div className="apr-acts">
        <button type="button" className="apr-btn" disabled={locked} onClick={onLater} data-testid="approval-later">Later</button>
        {autoOpen !== null && (
          <button
            type="button"
            className={`av3-btn apr-auto${autoOpen ? '' : ' av3-btn-primary'}`}
            disabled={locked}
            onClick={onToggleAuto}
            data-testid="approval-auto-toggle"
          >
            {autoLabel}
          </button>
        )}
      </div>
    </header>
  );
}
