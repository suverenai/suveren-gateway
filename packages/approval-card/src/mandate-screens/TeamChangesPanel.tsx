/**
 * Changes to a team's member list after the join (DEC-73 step 5). Pure: no network, no timers; the host owns what is typed, what is
 * busy and what was answered, so the gateway page and the phone app run the same screen. Texts: ./texts (all DRAFT).
 *
 *   admin:  someone left / was removed -> [Remove X with Touch ID]; someone took a new identity -> type the new code, [Confirm ... with Touch ID]
 *           (button off until the person's new anchor verified); the signer device is gone -> [Sign the list again with Touch ID];
 *           hand over (choose, then both confirm)
 *   member: the admin changed -> compare again (the host shows the join screen); the admin took a new identity -> a note only (take-over deferred, DEC-82); a hand-over to this person -> [Take over]
 */
import { S13 } from './texts';
import type { AdminChangesView, MemberChangesView, ReplaceOfferView, RemoveOfferView } from './interface';

export interface TeamChangesActions {
  remove(did: string): void;
  replaceType(userId: string, v: string): void;
  replaceCheck(userId: string): void;
  replace(userId: string): void;
  resign(): void;
  handoverChoose(did: string): void;
  handoverOffer(): void;
  handoverBuild(): void;
  handoverSign(): void;
  handoverWithdraw(): void;
}

export interface TeamChangesPanelProps {
  changes: AdminChangesView | MemberChangesView;
  /** What the host is doing right now (a touch is open): every button waits. */
  busy: boolean;
  /** Typed new-identity codes by user id, and the handover choice. */
  typed: Record<string, string>;
  chosen: string;
  /** The sentence of the last answer, if any, and whether it was a success. */
  result: { text: string; ok: boolean } | null;
  /** Per person: the wrong-code sentence, when the last check did not match. */
  wrong: Record<string, string>;
  actions: TeamChangesActions;
}

const removeIntro = (o: RemoveOfferView): string => (o.reason === 'left' ? S13.changesLeftIntro(o.name) : o.reason === 'removed' ? S13.changesRemovedIntro(o.name) : S13.changesGoneIntro(o.name));

function ReplaceRow({ o, p }: { o: ReplaceOfferView; p: TeamChangesPanelProps }) {
  const canSign = o.compared && o.anchor === 'ok';
  return (
    <div className="card" data-testid="changes-replace">
      <p>{S13.changesNewIdentityIntro(o.name)}</p>
      {!o.newDid ? <p data-testid="changes-replace-notyet">{S13.changesNewIdentityNotYet(o.name)}</p> : (
        <>
          {!o.compared && (
            <form onSubmit={e => { e.preventDefault(); if (!p.busy && (p.typed[o.userId] ?? '').trim()) p.actions.replaceCheck(o.userId); }}>
              <label className="form-label" htmlFor={`changes-typed-${o.userId}`}>{S13.changesNewIdentityType(o.name)}</label>
              <input id={`changes-typed-${o.userId}`} data-testid="changes-typed" className="form-input" inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
                value={p.typed[o.userId] ?? ''} onChange={e => p.actions.replaceType(o.userId, e.target.value)} disabled={p.busy} style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }} />
              {p.wrong[o.userId] && <p role="alert" data-testid="changes-wrong" className="msg-error">{p.wrong[o.userId]}</p>}
              <button type="submit" data-testid="changes-check" className="btn btn-primary btn-full" disabled={p.busy || !(p.typed[o.userId] ?? '').trim()}>{S13.joinCheck}</button>
            </form>
          )}
          {o.compared && (
            <>
              <p role="status" className="msg-success">{S13.joinAdminMatched(o.name)}</p>
              <p data-testid="changes-anchor" role="status" className={o.anchor === 'invalid' ? 'msg-error' : undefined}>
                {o.anchor === 'ok' ? S13.joinAnchorThere(o.name) : o.anchor === 'invalid' ? S13.joinAnchorInvalid(o.name) : S13.changesNewIdentityAnchorWaiting(o.name)}
              </p>
              <button type="button" data-testid="changes-replace-sign" className="btn btn-primary btn-full" disabled={p.busy || !canSign} onClick={() => p.actions.replace(o.userId)}>
                {p.busy ? S13.giveBusy : S13.changesNewIdentityButton(o.name)}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function TeamChangesPanel(p: TeamChangesPanelProps) {
  const c = p.changes;
  const a = p.actions;
  const result = p.result && <p role={p.result.ok ? 'status' : 'alert'} data-testid="changes-result" className={p.result.ok ? 'msg-success' : 'msg-error'}>{p.result.text}</p>;
  if (c.role === 'member') {
    const h = c.handover;
    if (!c.adminGone && !h) return result ?? null;
    return (
      <section data-testid="team-changes" style={{ maxWidth: 520 }}>
        <h3 className="card-title">{S13.changesTitle}</h3>
        {h && (
          <div className="card" data-testid="changes-handover-incoming">
            <p>{S13.changesHandoverIncoming}</p>
            {h.stage === 'named'
              ? <button type="button" data-testid="changes-handover-build" className="btn btn-primary btn-full" disabled={p.busy} onClick={a.handoverBuild}>{p.busy ? S13.giveBusy : S13.changesHandoverBuild}</button>
              : <p role="status">{S13.changesHandoverWaitingOld}</p>}
          </div>
        )}
        {c.adminGone && <p role="status" data-testid="changes-admin-gone">{S13.changesAdminGone}</p>}
        {result}
      </section>
    );
  }
  const nothing = c.remove.length === 0 && c.replace.length === 0 && !c.resign && !c.handover;
  const h = c.handover;
  return (
    <section data-testid="team-changes" style={{ maxWidth: 520 }}>
      <h3 className="card-title">{S13.changesTitle}</h3>
      {c.remove.map(o => (
        <div key={o.did} className="card" data-testid="changes-remove">
          <p>{removeIntro(o)}</p>
          <button type="button" data-testid="changes-remove-button" className="btn btn-primary btn-full" disabled={p.busy} onClick={() => a.remove(o.did)}>{p.busy ? S13.giveBusy : S13.changesRemoveButton(o.name)}</button>
        </div>
      ))}
      {c.replace.map(o => <ReplaceRow key={o.userId} o={o} p={p} />)}
      {c.resign && (
        <div className="card" data-testid="changes-resign">
          <p>{S13.changesResignIntro}</p>
          <button type="button" data-testid="changes-resign-button" className="btn btn-primary btn-full" disabled={p.busy} onClick={a.resign}>{p.busy ? S13.giveBusy : S13.changesResignButton}</button>
        </div>
      )}
      <div className="card" data-testid="changes-handover">
        <h4 className="card-title">{S13.changesHandoverTitle}</h4>
        {!h && (
          <>
            <p>{S13.changesHandoverIntro}</p>
            <label className="form-label" htmlFor="changes-handover-choose">{S13.changesHandoverChoose}</label>
            <select id="changes-handover-choose" data-testid="changes-handover-choose" className="form-input" value={p.chosen} disabled={p.busy || c.candidates.length === 0} onChange={e => a.handoverChoose(e.target.value)}>
              <option value="" />
              {c.candidates.map(m => <option key={m.did} value={m.did}>{m.name}</option>)}
            </select>
            <button type="button" data-testid="changes-handover-offer" className="btn btn-primary btn-full" disabled={p.busy || !p.chosen} onClick={a.handoverOffer}>
              {S13.changesHandoverStart(c.candidates.find(m => m.did === p.chosen)?.name ?? '')}
            </button>
          </>
        )}
        {h && h.stage === 'named' && <p role="status">{S13.changesHandoverWaitingNew}</p>}
        {h && h.stage === 'signed' && (
          <>
            <p>{S13.changesHandoverSignedOld(h.newAdminName ?? '')}</p>
            <button type="button" data-testid="changes-handover-sign" className="btn btn-primary btn-full" disabled={p.busy} onClick={a.handoverSign}>{p.busy ? S13.giveBusy : S13.changesHandoverSignOld}</button>
          </>
        )}
        {h && <button type="button" data-testid="changes-handover-withdraw" className="btn" disabled={p.busy} onClick={a.handoverWithdraw}>{S13.changesHandoverWithdraw}</button>}
      </div>
      {nothing && <p style={{ color: 'var(--text-secondary)' }} data-testid="changes-none">{S13.changesNone}</p>}
      {result}
    </section>
  );
}
