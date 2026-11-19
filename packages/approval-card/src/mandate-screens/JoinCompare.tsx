/**
 * Screen 2, option B: the admin and the new member compare codes once, both ways. The codes come from this gateway
 * (computed from the two DIDs). The AS/hap-core side of DEC-73 is NOT built: see `JoinCompareApi` in interface.ts.
 */
import { S13, groupCode } from './texts';

export type JoinState = { phase: 'compare' } | { phase: 'busy' } | { phase: 'done' } | { phase: 'differ' } | { phase: 'waiting' } | { phase: 'error'; text: string };

export interface JoinFacts { memberName: string; adminName: string; teamName: string; yourCode: string; theirCode: string }

function Code({ label, code, testid }: { label: string; code: string; testid: string }) {
  return (
    <div style={{ margin: '0.75rem 0' }}>
      <div style={{ color: 'var(--text-secondary)' }}>{label}</div>
      <div data-testid={testid} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '1.25rem', letterSpacing: '0.05em', overflowWrap: 'anywhere' }}>{groupCode(code)}</div>
    </div>
  );
}

/** `role` is who is looking: the admin confirms, the new member only compares. */
export function JoinCompare({ role, facts, state, onMatch, onDiffer }: { role: 'admin' | 'member'; facts: JoinFacts; state: JoinState; onMatch: () => void; onDiffer: () => void }) {
  const admin = role === 'admin';
  const title = admin ? S13.joinAdminTitle(facts.memberName, facts.teamName) : S13.joinMemberTitle(facts.adminName);
  if (state.phase === 'done') return <p role="status" data-testid="join-result" className="msg-success">{admin ? S13.joinAdminDone(facts.memberName) : S13.joinMemberDone(facts.teamName, facts.adminName)}</p>;
  if (state.phase === 'differ') return <p role="alert" data-testid="join-result" className="msg-error">{admin ? S13.joinDifferResult(facts.memberName) : S13.joinMemberDifferResult}</p>;
  if (state.phase === 'waiting') return <p role="status" data-testid="join-result">{S13.joinWaiting(facts.adminName)}</p>;
  const busy = state.phase === 'busy';
  return (
    <div className="card" data-testid="join-compare" style={{ maxWidth: 520 }}>
      <h3 className="card-title">{title}</h3>
      <p>{admin ? S13.joinAdminIntro(facts.memberName) : S13.joinMemberIntro(facts.teamName, facts.adminName)}</p>
      {admin
        ? <><Code label={S13.joinYourCode} code={facts.yourCode} testid="join-code-own" /><Code label={S13.joinTheirCode(facts.memberName)} code={facts.theirCode} testid="join-code-other" /></>
        : <><Code label={S13.joinTheirCode(facts.adminName)} code={facts.theirCode} testid="join-code-other" /><Code label={S13.joinYourCode} code={facts.yourCode} testid="join-code-own" /></>}
      <p>{admin ? S13.joinCompareHint : S13.joinMemberHint}</p>
      {state.phase === 'error' && <p role="alert" className="msg-error">{state.text}</p>}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={onMatch} disabled={busy}>{admin ? S13.joinMatch(facts.memberName) : S13.joinMemberMatch}</button>
        <button type="button" className="btn btn-secondary" onClick={onDiffer} disabled={busy}>{admin ? S13.joinDiffer : S13.joinMemberDiffer}</button>
      </div>
    </div>
  );
}

/** Screen 2c: how a colleague appears afterwards. Names come from the admin's signed list (not built). */
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
