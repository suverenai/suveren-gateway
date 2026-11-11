/**
 * The card for an AI-proposed change to a mandate (signed-off mockup,
 * temp/mandate-change-mockup): one card, only what changes. Old crossed out, new
 * bold, tagged. The AI adds no text of its own: the intent shows only as a
 * labelled word diff, the facts below come from the gateway, and nothing is
 * editable inline — "Change it myself" opens the form.
 */
import { useEffect, useState } from 'react';
import type { ChangeRow, ChangeTag, MandateDiff, WordPart } from '@hap/core/mandate-change';
import { spClient } from '../lib/sp-client';
import {
  dateText, gatewayFacts, lastsUntilMeaning, modeMeaning, modeWord, rowLabel, rowMeaning, rowValue, staysLines, tagClass, valueName, waitingWarning,
  type ChangeArgs, type ChangeFacts,
} from '../lib/mandate-change-view';
import { useSourceManifests } from '../lib/source-manifests';
import type { SourceManifestLike } from '../lib/attachment-sources';

function Tag({ tag }: { tag: ChangeTag }) {
  return <span className={`mc-tag ${tagClass(tag)}`} data-testid="change-tag">{tag}</span>;
}

/** What the change allows, in one sentence from the gateway: never the AI's words. */
function Meaning({ text }: { text: string }) {
  return <p className="mc-meaning" data-testid="change-meaning">{text}</p>;
}

function Row({ row, manifests }: { row: ChangeRow; manifests: SourceManifestLike[] | undefined }) {
  if (row.added || row.removed) {
    return (
      <div className="mc-row" data-testid="change-row" data-field={row.field}>
        <span className="mc-name">{rowLabel(row)}</span><span /><Tag tag={row.tag} />
        <div className="mc-list">
          {(row.added ?? []).map((v) => <span key={`a-${v}`} className="mc-add">{valueName(row, v, manifests)}</span>)}
          {(row.removed ?? []).map((v) => <span key={`r-${v}`} className="mc-rem">{valueName(row, v, manifests)}</span>)}
        </div>
        <Meaning text={rowMeaning(row, manifests)} />
      </div>
    );
  }
  return (
    <div className="mc-row" data-testid="change-row" data-field={row.field}>
      <span className="mc-name">{rowLabel(row)}</span>
      <span className="mc-val">
        {row.before !== null && <><span className="mc-old">{rowValue(row, row.before)}</span><span className="mc-arrow">→</span></>}
        <span className="mc-new">{rowValue(row, row.after)}</span>
      </span>
      <Tag tag={row.tag} />
      <Meaning text={rowMeaning(row, manifests)} />
    </div>
  );
}

export function WordDiff({ parts }: { parts: WordPart[] }) {
  return (
    <p className="mc-intent">
      {parts.map((p, i) => (p.kind === 'same' ? <span key={i}>{p.text}</span> : p.kind === 'add' ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
    </p>
  );
}

/** The differences, used by the card and the form's review step. */
export function MandateChangeDiff({ diff, intentByAi }: { diff: MandateDiff; intentByAi: boolean }) {
  const manifests = useSourceManifests();
  const hasRows = diff.rows.length > 0 || !!diff.mode || !!diff.lastsUntil;
  const intentLabel = (head: string) => (intentByAi ? `${head} · words proposed by the AI` : head);
  return (
    <>
      {hasRows && (
        <>
          <p className="mc-lab">What would change</p>
          {diff.rows.map((r) => <Row key={`${r.section}-${r.field}`} row={r} manifests={manifests} />)}
          {diff.mode && (
            <div className="mc-row" data-testid="change-row" data-field="mode">
              <span className="mc-name">How it runs</span>
              <span className="mc-val"><span className="mc-old">{modeWord(diff.mode.before)}</span><span className="mc-arrow">→</span><span className="mc-new">{modeWord(diff.mode.after)}</span></span>
              <Tag tag={diff.mode.tag} />
              <Meaning text={modeMeaning(diff.mode.tag)} />
            </div>
          )}
          {diff.lastsUntil && (
            <div className="mc-row" data-testid="change-row" data-field="lasts-until">
              <span className="mc-name">Lasts until</span>
              <span className="mc-val"><span className="mc-old">{dateText(diff.lastsUntil.before)}</span><span className="mc-arrow">→</span><span className="mc-new">{dateText(diff.lastsUntil.after)}</span></span>
              <Tag tag={diff.lastsUntil.tag} />
              <Meaning text={lastsUntilMeaning(diff.lastsUntil.tag)} />
            </div>
          )}
        </>
      )}
      {diff.intent && (
        <div className="mc-block" data-testid="change-intent">
          <p className="mc-lab">{intentLabel(hasRows ? 'Why it\'s for' : 'What would change')}</p>
          <WordDiff parts={diff.intent} />
          {!hasRows && <p className="mc-note">The limits stay as they are.</p>}
        </div>
      )}
    </>
  );
}

export function MandateChangeBody({ proposalId, args, areaTitle, onChangeMyself, editBusy, editError }: {
  proposalId: string;
  args: ChangeArgs;
  /** The area's name, shown when the mandate has no title of its own. */
  areaTitle: string;
  onChangeMyself: () => void;
  editBusy: boolean;
  editError: string | null;
}) {
  const diff = args.change;
  const manifests = useSourceManifests();
  const [facts, setFacts] = useState<ChangeFacts | null>(null);
  const [factsReady, setFactsReady] = useState(false);
  useEffect(() => {
    let live = true;
    spClient.getProposalPreview(proposalId)
      .then((r) => {
        if (!live) return;
        if (r.status === 'ok' && 'body' in r && r.body.structured) setFacts(r.body.structured as unknown as ChangeFacts);
      })
      .catch(() => {})
      .finally(() => { if (live) setFactsReady(true); });
    return () => { live = false; };
  }, [proposalId]);

  if (!diff) return <p className="msg-error" data-testid="change-unreadable">This change cannot be read. Reject it and ask the AI again.</p>;
  const factLines = gatewayFacts(facts, diff, manifests);
  // Before the local read answers, say nothing: it must not flash the unknown-waiting sentence.
  const warning = factsReady ? waitingWarning(facts ? facts.waiting : null) : null;
  const stays = staysLines(diff, manifests);
  return (
    <div className="mc-card" data-testid="mandate-change-card" style={{ order: 6 }}>
      <div className="mc-head" data-testid="change-kicker">Waiting for you · Change to a mandate</div>
      <div className="mc-in">
        <h2 data-testid="change-title">{args.mandate_title ?? areaTitle}</h2>
        <p className="mc-sub">Your AI proposes this through your Setup mandate.</p>
        <MandateChangeDiff diff={diff} intentByAi />
        {(factLines.length > 0 || diff.versionMove) && (
          <div className="mc-block" data-testid="change-facts">
            <p className="mc-lab">From your gateway</p>
            {diff.versionMove && (
              <p className="mc-fact" data-testid="change-version">This mandate is on an older version of the area. It moves to the newest one.</p>
            )}
            {factLines.map((l) => <p key={l} className="mc-fact" data-testid="change-fact">{l}</p>)}
          </div>
        )}
        {warning && <div className="mc-warn" data-testid="change-warning">{warning}</div>}
        {stays.length > 0 && (
          <details className="mc-details" data-testid="change-stays">
            <summary>Stays the same ({stays.length})</summary>
            <ul>{stays.map((l) => <li key={l}>{l}</li>)}</ul>
          </details>
        )}
        <div className="mc-edit">
          <button type="button" className="av3-link" data-testid="change-it-myself" onClick={onChangeMyself} disabled={editBusy}>
            {editBusy ? 'Opening…' : 'Change it myself'}
          </button>
          {editError && <p className="msg-error">{editError}</p>}
        </div>
      </div>
    </div>
  );
}
