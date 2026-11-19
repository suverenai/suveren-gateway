/**
 * Screen 2, option B (DEC-73, design 20.21.5): the admin and the new member each show their OWN identity code and type the
 * other's. The gateway compares (three tries); only after a match does the next step open. Pure: no network, no timers. The
 * host owns the typed text and the state, so the gateway page and the phone app run the same screen. Texts: ./texts.
 *
 *   member: read your code to the admin -> type the admin's code -> [Trust <admin> with Touch ID] -> waiting -> done
 *   admin:  read your code to the member -> type the member's code -> (button off until the member's anchor is there)
 *           -> [Add <member> with Touch ID] -> done
 */
import { S13 } from './texts';
import { CodeBlock } from '../components/DeviceFrame';

export type JoinState =
  | { phase: 'compare' }
  | { phase: 'checking' }
  | { phase: 'wrong'; triesLeft: number }
  /** Three wrong codes: this side is closed. */
  | { phase: 'locked' }
  /** The typed code matched. The next step (the touch) is open. */
  | { phase: 'matched' }
  /** The touch is being asked for. */
  | { phase: 'touch' }
  /** Member only: the anchor is signed, the admin has not added the member yet. */
  | { phase: 'waiting' }
  | { phase: 'done' }
  | { phase: 'error'; text: string; /** the side is still matched: only the touch failed */ matched?: boolean };

export interface JoinFacts {
  memberName: string;
  adminName: string;
  teamName: string;
  /** This person's own code (digits; shown in groups of four). */
  yourCode: string;
  /** Admin only: the member's anchor as the gateway verified it. `none` keeps the Add button off. */
  anchor?: 'none' | 'ok' | 'invalid';
}

export interface JoinCompareProps {
  /** Who is looking: the admin adds, the new member trusts. */
  role: 'admin' | 'member';
  facts: JoinFacts;
  state: JoinState;
  /** What was typed so far (the host keeps it). */
  typed: string;
  onType: (v: string) => void;
  /** Send the typed code to the gateway for comparison. */
  onCheck: () => void;
  /** The touch: member signs the anchor, admin signs the list. */
  onSign: () => void;
}

export function JoinCompare({ role, facts, state, typed, onType, onCheck, onSign }: JoinCompareProps) {
  const admin = role === 'admin';
  const other = admin ? facts.memberName : facts.adminName;
  if (state.phase === 'done') return <p role="status" data-testid="join-result" className="msg-success">{admin ? S13.joinAdminDone(facts.memberName) : S13.joinMemberDone(facts.teamName, facts.adminName)}</p>;
  if (state.phase === 'waiting') return <p role="status" data-testid="join-result">{S13.joinWaiting(facts.adminName)}</p>;
  if (state.phase === 'locked') {
    return (
      <div role="alert" data-testid="join-result" className="msg-error">
        <p style={{ margin: 0 }}>{S13.joinTriesUsed}</p>
        <p style={{ margin: '0.5rem 0 0' }}>{admin ? S13.joinDifferResult(facts.memberName) : S13.joinMemberDifferResult}</p>
      </div>
    );
  }
  const matched = state.phase === 'matched' || state.phase === 'touch' || (state.phase === 'error' && state.matched === true);
  const busy = state.phase === 'checking' || state.phase === 'touch';
  const anchor = facts.anchor ?? 'none';
  const canAdd = !admin || anchor === 'ok';
  return (
    <div className="card" data-testid="join-compare" style={{ maxWidth: 520 }}>
      <h3 className="card-title">{admin ? S13.joinAdminTitle(facts.memberName, facts.teamName) : S13.joinMemberTitle(facts.adminName)}</h3>
      <p>{admin ? S13.joinAdminIntro(facts.memberName) : S13.joinMemberIntro(facts.teamName, facts.adminName)}</p>
      {admin && <p style={{ color: 'var(--text-secondary)' }}>{S13.joinNameNotChecked(facts.memberName)}</p>}
      <CodeBlock label={S13.joinYourCode} code={facts.yourCode} testid="join-code-own" />
      <p>{admin ? S13.joinAdminRead(facts.memberName) : S13.joinMemberRead(facts.teamName, facts.adminName)}</p>
      {!matched ? (
        <form onSubmit={e => { e.preventDefault(); if (!busy && typed.trim()) onCheck(); }}>
          <div className="form-group">
            <label className="form-label" htmlFor="join-typed">{admin ? S13.joinAdminType(facts.memberName) : S13.joinMemberType(facts.adminName)}</label>
            <input id="join-typed" data-testid="join-typed" className="form-input" inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
              value={typed} onChange={e => onType(e.target.value)} disabled={busy} style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }} />
          </div>
          {state.phase === 'wrong' && (
            <p role="alert" data-testid="join-wrong" className="msg-error">
              {admin ? S13.joinWrongAdmin(facts.memberName) : S13.joinWrongMember} {S13.joinTriesLeft(state.triesLeft)}
            </p>
          )}
          <button type="submit" data-testid="join-check" className="btn btn-primary btn-full" disabled={busy || !typed.trim()}>
            {state.phase === 'checking' ? S13.joinChecking : S13.joinCheck}
          </button>
        </form>
      ) : (
        <div data-testid="join-matched">
          <p role="status" className="msg-success">{admin ? S13.joinAdminMatched(other) : S13.joinMemberMatched(other)}</p>
          {admin && (
            <p data-testid="join-anchor" role="status" className={anchor === 'invalid' ? 'msg-error' : undefined}>
              {anchor === 'ok' ? S13.joinAnchorThere(other) : anchor === 'invalid' ? S13.joinAnchorInvalid(other) : S13.joinAnchorWaiting(other)}
            </p>
          )}
          {state.phase === 'error' && <p role="alert" data-testid="join-error" className="msg-error">{state.text}</p>}
          <button type="button" data-testid="join-sign" className="btn btn-primary btn-full" onClick={onSign} disabled={busy || !canAdd}>
            {state.phase === 'touch' ? S13.giveBusy : admin ? S13.joinAddButton(other) : S13.joinMemberTrust(other)}
          </button>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{admin ? S13.joinAdminTouchNote(other) : S13.joinMemberTouchNote}</p>
        </div>
      )}
      {!matched && state.phase === 'error' && <p role="alert" data-testid="join-error" className="msg-error">{state.text}</p>}
    </div>
  );
}

/** The neutral code the gateway answered, as the sentence the person reads. `member` is the other person's name on the admin's side. */
export function joinErrorText(code: string, member?: string): string {
  switch (code) {
    case 'check_failed': return S13.joinErrTouch;
    case 'as_unreachable': case 'as_tls_mismatch': return S13.joinErrOffline;
    case 'LIST_HEAD_MOVED': return S13.joinErrMoved;
    case 'no_member_list': case 'trust_invalid': case 'as_answer_invalid': return S13.joinErrTrust;
    case 'member_has_no_chain': return S13.joinErrNoChain(member ?? S13.heldAdminUnknown);
    case 'no_check_key': case 'check_key_unreadable': case 'key_mismatch': return S13.joinErrNoCheck;
    case 'locked': case 'not_signed_in': return S13.joinErrLocked;
    default: return S13.joinErrOther;
  }
}

/** Screen 2c: how a member appears afterwards. Names come from the admin's signed list. */
export function ColleagueList({ colleagues, adminName }: { colleagues: Array<{ name: string; confirmedBy: string | 'you' }>; adminName: string }) {
  return (
    <section data-testid="colleagues" style={{ maxWidth: 520 }}>
      <h3 className="card-title">{S13.colleaguesTitle}</h3>
      {colleagues.map(c => (
        <div key={c.name} style={{ padding: '0.4rem 0' }}>
          <div>{c.name}</div>
          <small>{c.confirmedBy === 'you' ? S13.confirmedByYou : S13.confirmedBy(c.confirmedBy)}</small>
        </div>
      ))}
      <p style={{ color: 'var(--text-secondary)' }}>{S13.colleaguesWhy(adminName)}</p>
    </section>
  );
}
