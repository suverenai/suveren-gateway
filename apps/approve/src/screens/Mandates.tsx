/**
 * Mandates on the phone (stage D3; mockup phone-d3-live.html v6 A1–A6, B2, F2; DEC-85/86/88). The card is the gateway's card (`av3-card`,
 * `av3-scroll` / `av3-body` with the "More below" cue, `av3-foot` pinned at the bottom, the `av3-stamp` result, the shared not-known
 * pieces `UnknownTop` / `ResultFoot`); the words are DRAFT (texts.ts). Everything shown comes from the give the phone checked
 * (lib/mandate-give.ts): what is shown is what is signed.
 */
import { useEffect, useRef, useState } from 'react';
import { giveSummaryLine, limitRows, scopeLabel, durationText, EndMandate, S13, type SchemaLike, type EndState as SharedEndState } from '@suveren/approval-card/mandate-screens';
import { MandateChangeDiff } from '@suveren/approval-card/components/MandateChangeCard';
import { UnknownTop, ResultFoot } from '@suveren/approval-card/components/ApprovalResult';
import type { GiveItem, GiveState } from '../lib/mandate-give';
import type { OwnMandate, EndState } from '../lib/mandate-end';
import { P } from '../texts';
import { TouchWait, Notice, whenText } from './Frame';

const schemaOf = (item: GiveItem, which: 'boundsSchema' | 'scopeSchema'): SchemaLike | undefined =>
  (item.profile as unknown as Record<string, SchemaLike | undefined>)[which];

/** The row of a give in the list (mockup A1). */
export function GiveRow({ item, nowSeconds, onOpen }: { item: GiveItem; nowSeconds: number; onOpen: () => void }) {
  return (
    <div className="av3-row" data-testid="give-row" data-key={item.key}>
      <button type="button" className="appr-item-head av3-row-head" onClick={onOpen}>
        <span className="av3-type"><b>{item.op === 'change' ? P.changeRowKind : P.giveRowKind}</b><span className="av3-area">{item.title}</span><span>{whenText(item.preparedAt, nowSeconds)}</span></span>
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
      <div data-testid="change-diff">{item.diff && <MandateChangeDiff diff={item.diff} intentByAi={false} />}</div>
      <p className="form-hint">{S13.changeOnlyOwner}</p>
    </>
  );
}

function GiveBody({ item, nowSeconds }: { item: GiveItem; nowSeconds: number }) {
  if (item.op === 'change' && item.diff) return <ChangeBody item={item} nowSeconds={nowSeconds} />;
  const bounds = schemaOf(item, 'boundsSchema');
  const scopeSchema = schemaOf(item, 'scopeSchema');
  const limits = limitRows(item.bounds, bounds);
  const scope = Object.entries(item.scope);
  const approvers = Array.isArray(item.payload.above_cap_approvers) ? item.payload.above_cap_approvers : [];
  const summary = giveSummaryLine({ limits: item.bounds, scope: item.scope, boundsSchema: bounds, scopeSchema: schemaOf(item, 'scopeSchema'), durationSeconds: item.lastsSeconds });
  return (
    <>
      <div className="av3-type"><b>{P.giveRowKind}</b><span className="av3-area">{item.title}</span></div>
      <h2 className="av3-title" data-testid="give-title">{P.giveTitle(item.title)}</h2>
      {summary && <p className="sum-line" data-testid="mandate-summary">{summary}</p>}
      <p className="from" data-testid="give-from">{P.giveFrom(item.preparedBy, whenText(item.preparedAt, nowSeconds))}</p>
      <p>{P.giveRead}</p>
      {limits.length > 0 && (
        <div className="info-block"><div className="info-head"><span className="info-title">{P.giveLimits}</span></div>
          <dl className="info-kv" data-testid="give-limits">{limits.map((r) => <div key={r.key} style={{ display: 'contents' }}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
          <p className="form-hint" style={{ margin: '.5rem 0 0' }}>{P.giveFromRules(item.profile.name ?? item.title)}</p>
        </div>
      )}
      {scope.length > 0 && (
        <div className="info-block"><div className="info-head"><span className="info-title">{P.giveScope}</span></div>
          <dl className="info-kv" data-testid="give-scope">{scope.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{scopeLabel(k, scopeSchema)}</dt><dd>{String(v)}</dd></div>)}</dl>
        </div>
      )}
      <div className="info-block"><div className="info-head"><span className="info-title">{P.giveHowLong}</span></div>
        <dl className="info-kv"><dt>{P.giveLasts}</dt><dd data-testid="give-lasts">{durationText(item.lastsSeconds)}</dd></dl>
      </div>
      {approvers.length > 0 && (
        <div className="info-block" data-testid="give-approvers"><div className="info-head"><span className="info-title">{P.giveApprovals}</span></div>
          <p style={{ margin: '0 0 .5rem' }}>{P.giveAboveCap(item.payload.above_cap_approvals ?? 1)}</p>
          {approvers.map((did) => (
            <details key={did} className="idc"><summary>{P.giveCheckCode}</summary><div className="code-big" style={{ fontSize: '1rem', overflowWrap: 'anywhere' }}>{did}</div></details>
          ))}
        </div>
      )}
      <div className="info-block"><div className="info-head"><span className="info-title">{P.giveWhy}</span></div>
        <p style={{ margin: 0 }} data-testid="give-intent">{item.intent}</p>
      </div>
      <p className="form-hint">{P.giveAnyDevice}</p>
    </>
  );
}

/**
 * The give, full screen in the panel (mockup A2): the body scrolls with the "More below" cue; the footer is pinned. After the touch the
 * gateway's own result ("Signed"), or the one not-received state with Check again (UI review, DEC-88).
 */
export function GiveCard({ state, nowSeconds, onGive, onLater, onCancelTouch, onCheckAgain, onDone, dismissLabel }: {
  state: Exclude<GiveState, { step: 'idle' }>; nowSeconds: number;
  onGive: () => void; onLater: () => void; onCancelTouch: () => void; onCheckAgain: () => void; onDone: () => void; dismissLabel: string;
}) {
  const item = state.item;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const busy = state.step === 'sending' || state.step === 'signed';
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
      {state.step === 'review' && (
        <footer className="av3-foot">
          <div className="av3-btns-stack">
            <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-give" onClick={onGive}>{item.op === 'change' ? P.changeButton : P.giveButton}</button>
            <button type="button" className="av3-btn" onClick={onLater}>{P.cancel}</button>
          </div>
        </footer>
      )}
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
export function OwnMandates({ items, notes = [], onEnd }: { items: OwnMandate[]; notes?: string[]; onEnd: (m: OwnMandate) => void }) {
  if (items.length === 0 && notes.length === 0) return null;
  return (
    <section data-testid="own-mandates">
      <h2 className="ap-h2">{P.mineTitle}</h2>
      {notes.map((n) => <Notice key={n} kind="info">{n}</Notice>)}
      <div className="dash-rows">
        {items.map((m) => (
          <div key={m.authorizationId} className="av3-row" data-testid="own-mandate">
            <div className="av3-row-head ap-mrow">
              <span className="ap-mrow-text"><span className="av3-row-title ap-clamp" data-testid="own-mandate-title" title={m.title}>{m.title}</span><span className="form-hint" data-testid="own-mandate-until">{P.mineActiveUntil(untilText(m.expiresAt))}</span></span>
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
