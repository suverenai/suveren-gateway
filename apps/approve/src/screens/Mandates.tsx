/**
 * Mandates on the phone (stage D3; mockup phone-d3-live.html v6 A1–A6, B2, F2; DEC-85/86/88). The card is the gateway's card (`av3-card`,
 * `av3-scroll` / `av3-body` with the "More below" cue, `av3-foot` pinned at the bottom, the `av3-stamp` result, the shared not-known
 * pieces `UnknownTop` / `ResultFoot`); the words are DRAFT (texts.ts). Everything shown comes from the give the phone checked
 * (lib/mandate-give.ts): what is shown is what is signed.
 */
import { useEffect, useRef, useState } from 'react';
import { giveSummaryLine, EndMandate, S13, HeldBackList, NotReceivedNote, heldReason, type HeldBackMandate, type SchemaLike, type EndState as SharedEndState } from '@suveren/approval-card/mandate-screens';
import { MandateChangeDiff } from '@suveren/approval-card/components/MandateChangeCard';
import { UnknownTop, ResultFoot } from '@suveren/approval-card/components/ApprovalResult';
import { MandateProposalBody, MandateFold, CommitmentBand, ModeBadge, type MandateCardModel } from '@suveren/approval-card/components/MandateProposalCard';
import { RequestContextFolds } from '@suveren/approval-card/components/RequestContextBox';
import { cardFacts } from '@suveren/approval-card/lib/mandate-card-model';
import type { FactSchema } from '@suveren/approval-card/lib/mandate-facts';
import { ageLabel } from '@suveren/approval-card/lib/core-objects';
import { shortProfileId } from '@suveren/approval-card/lib/profile-identity';
import { AreaIcon } from '@suveren/approval-card/components/AreaIcon';
import { areaIcon } from '@suveren/approval-card/lib/area';
import { ChangeNoteFooter, WorkingStamp, DecisionStamp } from '@suveren/approval-card/components/DecisionParts';
import { validateChangeNote } from '@suveren/approval-card/lib/reject-outcome';
import type { DecisionKind, DecisionResult } from '@suveren/approval-card/lib/approval-flow';
import { PHONE_CARD } from '../lib/phone-card-choices';
import type { GiveItem, GiveState } from '../lib/mandate-give';
import type { OwnMandate, EndState, HeldOwn } from '../lib/mandate-end';
import { P } from '../texts';
import { TouchWait, Notice, whenText } from './Frame';

const schemaOf = (item: GiveItem, which: 'boundsSchema' | 'scopeSchema'): SchemaLike | undefined =>
  (item.profile as unknown as Record<string, SchemaLike | undefined>)[which];

/** The row of a give in the list (mockup A1). */
export function GiveRow({ item, nowSeconds, onOpen }: { item: GiveItem; nowSeconds: number; onOpen: () => void }) {
  return (
    <div className="av3-row" data-testid="give-row" data-key={item.key}>
      <button type="button" className="appr-item-head av3-row-head" onClick={onOpen}>
        <span className="av3-type"><b>{item.op === 'change' ? P.changeRowKind : P.giveRowKind}</b><ModeBadge mode={item.payload.commitment_mode} /><span className="av3-area">{item.title}</span><span>{whenText(item.preparedAt, nowSeconds)}</span></span>
        <span className="av3-row-title">{item.renewal ? P.renewTitle(item.title) : item.op === 'change' ? S13.changeTitle(item.title) : P.giveTitle(item.title)}</span>
      </button>
    </div>
  );
}

/** A change on the phone (mockup B1): the gateway's change card body, old values crossed out; the diff was checked against the previous grant. */
function ChangeBody({ item, nowSeconds }: { item: GiveItem; nowSeconds: number }) {
  const summary = giveSummaryLine({ limits: item.bounds, scope: item.scope, boundsSchema: schemaOf(item, 'boundsSchema'), scopeSchema: schemaOf(item, 'scopeSchema'), durationSeconds: item.lastsSeconds });
  return (
    <>
      <div className="av3-type"><b>{P.changeRowKind}</b><span className="av3-area">{item.title}</span></div>
      <h2 className="av3-title" data-testid="give-title">{item.renewal ? P.renewTitle(item.title) : S13.changeTitle(item.title)}</h2>
      {summary && <p className="sum-line" data-testid="mandate-summary">{summary}</p>}
      <p className="from" data-testid="give-from">{P.giveFrom(item.preparedBy, whenText(item.preparedAt, nowSeconds))}</p>
      <p>{S13.changeOnlyListed}</p>
      <div className="mc-block" data-testid="change-diff">{item.diff && <MandateChangeDiff diff={item.diff} intentByAi={false} />}</div>
      <p className="form-hint">{S13.changeOnlyOwner}</p>
    </>
  );
}

/** The mandate card's model for a give this phone checked: the same facts the gateway's card shows for the same proposal. */
export function giveModel(item: GiveItem, nowSeconds: number): MandateCardModel {
  const area = item.profile.name ?? shortProfileId(item.profile.id);
  const version = `${shortProfileId(item.profile.id)} ${item.profile.version}`;
  const facts = cardFacts({
    limits: item.bounds, scope: item.scope,
    boundsSchema: schemaOf(item, 'boundsSchema') as FactSchema | undefined, scopeSchema: schemaOf(item, 'scopeSchema') as FactSchema | undefined,
    // The granted duration: what the mandate carries, not the time left to its end date.
    durationSeconds: item.payload.expires_at && item.payload.issued_at ? item.payload.expires_at - item.payload.issued_at : item.lastsSeconds,
    nowMs: nowSeconds * 1000,
  });
  return {
    area, areaIcon: <AreaIcon icon={areaIcon(item.profile.id)} />, age: ageLabel(item.preparedAt * 1000, nowSeconds * 1000), mode: item.payload.commitment_mode, name: item.title,
    summary: facts.summary, intent: item.intent, ...(item.proposalId ? {} : { intentLabel: P.giveWhy }),
    valid: facts.valid, limits: facts.limits, scope: facts.scope, ...(item.workspace ? { workspace: item.workspace } : {}),
    technical: { one: `New mandate · ${area} · ${version}`, proposal: `New mandate · ${area}`, version },
  };
}

function GiveBody({ item, nowSeconds }: { item: GiveItem; nowSeconds: number }) {
  if (item.op === 'change' && item.diff) return <ChangeBody item={item} nowSeconds={nowSeconds} />;
  const approvers = Array.isArray(item.payload.above_cap_approvers) ? item.payload.above_cap_approvers : [];
  const model = giveModel(item, nowSeconds);
  return (
    <MandateProposalBody
      model={model}
      titleTestId="give-title"
      slots={{
        afterSummary: <p className="from" style={{ order: 1 }} data-testid="give-from">{P.giveFrom(item.preparedBy, whenText(item.preparedAt, nowSeconds))}</p>,
        // Above the limit, the people who approve first: a fact of the give only this phone's check knows, kept from the earlier screen.
        belowTile: approvers.length > 0 ? (
          <div className="info-block" style={{ order: 7 }} data-testid="give-approvers"><div className="info-head"><span className="info-title">{P.giveApprovals}</span></div>
            <p style={{ margin: '0 0 .5rem' }}>{P.giveAboveCap(item.payload.above_cap_approvals ?? 1)}</p>
            {approvers.map((did) => (
              <details key={did} className="idc"><summary>{P.giveCheckCode}</summary><div className="code-big" style={{ fontSize: '1rem', overflowWrap: 'anywhere' }}>{did}</div></details>
            ))}
          </div>
        ) : null,
        requestAndHistory: PHONE_CARD.showsRequestAndHistory && item.proposalId ? (
          item.requestContext
            ? <RequestContextFolds resp={item.requestContext} />
            : (
              <>
                <MandateFold heading="Request" one={PHONE_CARD.nothingSentText} order={12} testid="au10-request"><p className="au10-req-state">{PHONE_CARD.nothingSentText}</p></MandateFold>
                <MandateFold heading="History" one={PHONE_CARD.nothingSentText} order={13} testid="au10-history"><p className="au10-hist-state">{PHONE_CARD.nothingSentText}</p></MandateFold>
              </>
            )
        ) : null,
        footnote: <p className="form-hint" style={{ order: 16 }}>{P.giveAnyDevice}</p>,
      }}
    />
  );
}

/**
 * The give, full screen in the panel (mockup A2): the body scrolls with the "More below" cue; the footer is pinned. After the touch the
 * gateway's own result ("Signed"), or the one not-received state with Check again (UI review, DEC-88).
 */
export function GiveCard({ state, nowSeconds, onGive, onLater, onReject, onAskChanges, onDecided, onCancelTouch, onCheckAgain, onDone, dismissLabel }: {
  state: Exclude<GiveState, { step: 'idle' }>; nowSeconds: number;
  /** Reject the AI's proposal this give carries out (signed by this phone); resolves once the Authority Server answered. Absent: no Reject (a give the person prepared themselves). */
  onReject?: () => Promise<DecisionResult>;
  /** Send the AI's proposal back with the person's words (sealed for the computer that reads them to the AI). Absent: no "Ask for changes". */
  onAskChanges?: (note: string) => Promise<DecisionResult>;
  /** The Authority Server answered a Reject or a change: the stamp is on screen; the host moves on after it has been seen. */
  onDecided?: (kind: DecisionKind) => void;
  onGive: () => void; onLater: () => void; onCancelTouch: () => void; onCheckAgain: () => void; onDone: () => void; dismissLabel: string;
}) {
  const item = state.item;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  // Reject and "Ask for changes" run as on the gateway's card: working line, then the stamp only once the Authority Server answered.
  const [phase, setPhase] = useState<{ t: 'idle' } | { t: 'change' } | { t: 'working'; kind: DecisionKind } | { t: 'done'; kind: DecisionKind; result: DecisionResult }>({ t: 'idle' });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const decided = phase.t === 'working' || phase.t === 'done';
  const run = async (kind: 'reject' | 'change', changeNote?: string) => {
    if (decided) return;
    setError('');
    setPhase({ t: 'working', kind });
    try {
      const result = await (kind === 'reject' ? onReject!() : onAskChanges!(changeNote!));
      setPhase({ t: 'done', kind, result });
      onDecided?.(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setPhase(kind === 'change' ? { t: 'change' } : { t: 'idle' });
    }
  };
  const sendChange = () => {
    const v = validateChangeNote(note);
    if (!v.valid) { setError(v.error); return; }
    void run('change', v.trimmed);
  };
  const busy = state.step === 'sending' || state.step === 'signed' || decided;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || busy) { setMoreBelow(false); return undefined; }
    const update = () => setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 8);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [busy]);
  if (!item) return null;
  return (
    <div className={`card av3-card${busy ? ' av3-busy' : ''}`} data-testid="give-card" data-step={state.step}>
      <div className="av3-scroll" ref={scrollRef}>
        <article className="av3-body" aria-hidden={busy || undefined}>
          {state.step === 'not_received' && <UnknownTop word={P.giveNotReceivedWord} line={`${P.giveNotReceived(item.preparedBy)} ${P.giveNotReceivedHint(item.preparedBy)}`} />}
          {state.step === 'failed' && <Notice kind="error">{state.error}</Notice>}
          <GiveBody item={item} nowSeconds={nowSeconds} />
        </article>
        {moreBelow && <div className="more-cue" aria-hidden="true" data-testid="more-cue">More below ↓</div>}
      </div>
      {state.step === 'review' && phase.t !== 'change' && !decided && (
        <div className="av3-dock">
          {/* The commitment, right above the give button, as on the gateway's card (a change has its own card and no band). */}
          {!(item.op === 'change' && item.diff) && <CommitmentBand mode={item.payload.commitment_mode} />}
          <footer className="av3-foot">
            {error && <p className="msg-error av3-error" role="alert">{error}</p>}
            <div className="av3-btns av3-btns-give">
              <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-give" onClick={onGive}>{item.op === 'change' ? P.changeButton : P.giveButton}</button>
              {PHONE_CARD.offersAskForChanges && onAskChanges && <button type="button" className="av3-btn" data-testid="btn-change-needed" onClick={() => { setError(''); setPhase({ t: 'change' }); }}>{P.giveAskChanges}</button>}
              {PHONE_CARD.offersReject && onReject && <button type="button" className="av3-btn" data-testid="btn-reject" onClick={() => void run('reject')}>{P.giveReject}</button>}
            </div>
          </footer>
        </div>
      )}
      {state.step === 'review' && phase.t === 'change' && (
        <ChangeNoteFooter id={item.key} note={note} onNote={setNote} error={error} onSend={sendChange} onBack={() => { setPhase({ t: 'idle' }); setError(''); }} />
      )}
      {phase.t === 'working' && <WorkingStamp kind={phase.kind} isMandate />}
      {phase.t === 'done' && <DecisionStamp kind={phase.kind} isMandate result={phase.result} />}
      {state.step === 'checking' && (
        <footer className="av3-foot">
          <TouchWait text={P.openBusy} error={state.error} onRetry={onGive} onCancel={onCancelTouch} retryLabel={item.op === 'change' ? P.changeButton : P.giveButton} cancelLabel={P.cancel} />
        </footer>
      )}
      {state.step === 'sending' && (
        <div className="av3-stamp av3-stamp-wait" role="status" data-testid="decision-working"><span className="av3-spin" aria-hidden="true" />{P.giveSigning}</div>
      )}
      {state.step === 'signed' && (
        <div className="av3-stamp" role="status" data-testid="decision-stamp">
          <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <div className="av3-stamp-w">{P.giveSigned}</div>
          <div className="av3-stamp-t">{P.giveReceivedBy(state.receivedBy)}</div>
        </div>
      )}
      {state.step === 'not_received' && (
        <ResultFoot check={{ busy: state.checking, checkedOnce: state.checkedOnce, onCheck: onCheckAgain }} dismiss={{ label: dismissLabel, onDismiss: onDone }} />
      )}
      {state.step === 'failed' && (
        <footer className="av3-foot"><div className="av3-btns-stack"><button type="button" className="av3-btn av3-btn-primary" onClick={onDone}>{dismissLabel}</button></div></footer>
      )}
    </div>
  );
}

/** "Active until 4 Dec 2026, 14:20": the end in the person's local time (mockup B2 row), never a relative word like "today". */
export function untilText(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * "Your mandates" with End (mockup B2 list). The title is the gateway's (its Mandates page shows the mandate's own title, else the area),
 * not "The mandate for …". Notes about mandates ended on another device sit here, under this heading, never under "Waiting for you".
 */
export function OwnMandates({ items, notes = [], held = [], nowSeconds, onEnd }: { items: OwnMandate[]; notes?: string[]; held?: HeldOwn[]; nowSeconds?: number; onEnd: (m: OwnMandate) => void }) {
  // On-hold mockup v2: this person's mandates the phone's own check holds back (case 3–5; the phone cannot give again on its own, so
  // the card carries the words, no button), and a give from this phone no computer took in after 10 minutes (case 2, a calm note).
  const heldCards: HeldBackMandate[] = held.map((h) => ({ mandateId: h.authorizationId, profileName: h.profileName, title: h.title, ownerName: null, ownerIsYou: true, reason: heldReason(h.code), adminName: null }));
  const pending = items.filter((m) => m.notReceivedBy && m.givenHereAt);
  const heldShown = heldCards.length > 0 || pending.length > 0;
  if (items.length === 0 && notes.length === 0 && !heldShown) return null;
  return (
    <section data-testid="own-mandates">
      {heldShown && (
        <div data-testid="phone-held">
          {pending.map((m) => <NotReceivedNote key={`nr-${m.authorizationId}`} title={m.title} device={m.notReceivedBy!} minutes={Math.max(10, Math.floor(((nowSeconds ?? Math.floor(Date.now() / 1000)) - m.givenHereAt!) / 60))} />)}
          <HeldBackList mandates={heldCards} host="phone" />
        </div>
      )}
      <h2 className="ap-h2">{P.mineTitle}</h2>
      {notes.map((n) => <Notice key={n} kind="info">{n}</Notice>)}
      <div className="dash-rows">
        {items.map((m) => (
          <div key={m.authorizationId} className="av3-row" data-testid="own-mandate">
            <div className="av3-row-head ap-mrow">
              <span className="ap-mrow-text"><span className="av3-type"><ModeBadge mode={m.mode} /></span><span className="av3-row-title ap-clamp" data-testid="own-mandate-title" title={m.title}>{m.title}</span><span className="form-hint" data-testid="own-mandate-until">{P.mineActiveUntil(untilText(m.expiresAt))}</span></span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ minHeight: 44 }} data-testid="btn-end" onClick={() => onEnd(m)}>{P.mineEnd}</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** End a mandate: the gateway's own screen 4 (shared `EndMandate`, S13 texts; mockup B2), fed by the phone's end driver. No touch. */
export function EndScreen({ state, onEnd, onKeep, onDone }: { state: Exclude<EndState, { step: 'idle' }>; onEnd: () => void; onKeep: () => void; onDone: () => void }) {
  const m = state.item;
  const shared: SharedEndState = state.step === 'confirm' ? { phase: 'confirm' } : state.step === 'sending' ? { phase: 'busy' } : state.step === 'done' ? { phase: 'done' } : { phase: 'error', code: 'other' };
  const until = untilText(m.expiresAt);
  return (
    <div className="device-screen" data-testid="end-screen">
      <EndMandate facts={{ profileName: m.title, limits: [], activeUntil: until }} state={shared} onEnd={onEnd} onKeep={onKeep} />
      {state.step === 'done' && <button type="button" className="btn btn-primary btn-full" onClick={onDone}>{P.listBack}</button>}
    </div>
  );
}
