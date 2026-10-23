/**
 * TicketWhatWasDone — an opened ticket's "What was sent" and "Result" (UI
 * spec §14, signed off 2026-10-17; mockup
 * temp/ticket-content-mockup/index.html §2–§4). Shown first on a ticket.
 *
 * Fetches this device's own receipt archive entry (`GET
 * /api/evidence/receipt/:id`) — bound content, the args this gateway sent
 * (`sentArgs`, or an approved ticket's archived proposal args), the
 * control plane's check of those args against the execution journal
 * (`sentArgsCheck`) and what the tool answered (`result`). When the ticket
 * carries a signed `contentHash`, recomputes it locally (lib/content-hash.ts)
 * — "sealed in the ticket" is only ever shown on a check that ran and passed.
 * The level choice and rows are lib/ticket-what-was-done.ts (pure, tested).
 *
 * No AI text, no lookups in another system: everything here is the ticket's
 * own signed content or this device's local evidence of it, labelled from
 * the connector manifest. Off-device (no local entry) it says so and shows
 * nothing it does not have.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { spClient, type ExecutionReceipt, type IntegrationManifest, type LocalReceiptEntry } from '../lib/sp-client';
import { computeContentHashBrowser } from '../lib/content-hash';
import { sentView, sentRows, resultBody, type SentView } from '../lib/ticket-what-was-done';
import { splitTool, systemDisplayName, type ToolDisplay } from '../lib/approval-view';
import { ArgValue } from './ProposalArgs';
import { ObFold, ObLock } from './ObjectCard';
import { AttachmentsSealedBox } from './AttachmentsSealedBox';
import { extractAttachmentsSealed } from '../lib/attachment-sealed';

interface Props {
  receipt: ExecutionReceipt;
  manifests?: IntegrationManifest[];
}

/** One tool-display fetch per page load, shared by every opened ticket. */
let toolDisplays: Promise<Record<string, ToolDisplay>> | null = null;
function loadToolDisplays(): Promise<Record<string, ToolDisplay>> {
  if (!toolDisplays) toolDisplays = spClient.getToolDisplay().catch(() => { toolDisplays = null; return {}; });
  return toolDisplays;
}

function Rows({ args, display, executionContext, sealed }: {
  args: Record<string, unknown>;
  display: ToolDisplay | undefined;
  executionContext: Record<string, unknown> | undefined;
  sealed: boolean;
}) {
  const rows = sentRows(args, display, executionContext);
  if (rows.length === 0) return null;
  return (
    <dl className="ob-kv ticket-sent-fields">
      {rows.map((row) => (
        <Fragment key={row.key}>
          <dt title={row.hint}>{row.label}</dt>
          <dd className={sealed ? 'is-sealed' : undefined}>
            <ArgValue row={row} />
            {row.inTicket && <span className="ob-quiet-inline" title="This value is also in the signed ticket"> · also in the ticket</span>}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Content({ content, display, executionContext, sealed }: {
  content: Record<string, unknown> | string;
  display: ToolDisplay | undefined;
  executionContext: Record<string, unknown> | undefined;
  sealed: boolean;
}) {
  if (typeof content === 'string') return <p className={`ob-text${sealed ? ' is-sealed' : ''}`}>{content}</p>;
  return <Rows args={content} display={display} executionContext={executionContext} sealed={sealed} />;
}

function ArgsCheckLine({ check }: { check: 'match' | 'mismatch' | 'unchecked' }) {
  if (check === 'match') return <p className="ob-check">&#10003; Matches what this gateway executed</p>;
  if (check === 'mismatch') return <p className="ob-check ob-check-x">&#10005; <b>Does not match what this gateway executed</b></p>;
  return <p className="ob-quiet">Could not be checked against this gateway's execution record.</p>;
}

/**
 * UI spec §18.3 — the two levels of §14.1 keep their meaning, in the new
 * look: SEALED values sit in the grey lock tile ("Sealed in the ticket");
 * RECORDED values have no tile and no lock, only a quiet label that they are
 * not sealed in the ticket.
 */
function SentBox({ view, display, executionContext }: {
  view: SentView;
  display: ToolDisplay | undefined;
  executionContext: Record<string, unknown> | undefined;
}) {
  if (view.level === 'off-device') {
    return (
      <div className="ob-sent" data-testid="ticket-what-was-done" data-bound="off-device">
        <h4 className="ob-sent-h">What was sent</h4>
        <p className="ob-quiet">Only on the gateway that ran it — this device has no local copy. The signed ticket still proves the limits it ran under.</p>
      </div>
    );
  }
  if (view.level === 'not-kept') {
    return (
      <div className="ob-sent" data-testid="ticket-what-was-done" data-bound="not-kept" data-reason={view.reason}>
        <h4 className="ob-sent-h">What was sent</h4>
        <p className="ob-quiet">
          {view.reason === 'too_large'
            ? 'Not kept — what was sent was too large to keep on this device.'
            : 'Not kept — this ticket is older than the release that started keeping it.'}
          {' '}The signed ticket still proves the limits it ran under.
        </p>
      </div>
    );
  }
  if (view.level === 'sealed') {
    return (
      <section className="ob-tile ob-sealed is-sealed" data-testid="ticket-what-was-done" data-bound="sealed" data-check={view.check}>
        <h4 className="ob-tile-h"><ObLock />Sealed in the ticket</h4>
        <Content content={view.bound} display={display} executionContext={executionContext} sealed />
        {view.check === 'ok'
          ? <p className="ob-check">&#10003; Matches the fingerprint in the signed ticket</p>
          : <p className="ob-check ob-check-x">&#10005; <b>Does not match the fingerprint in the signed ticket — this local copy was changed</b></p>}
        {view.extras && sentRows(view.extras, display, executionContext).length > 0 && (
          <>
            <p className="ob-lbl ob-gap">Also sent — recorded by this gateway, not sealed in the ticket</p>
            <Rows args={view.extras} display={display} executionContext={executionContext} sealed={false} />
            {view.argsCheck === 'mismatch' && <ArgsCheckLine check="mismatch" />}
          </>
        )}
      </section>
    );
  }
  return (
    <div className="ob-sent" data-testid="ticket-what-was-done" data-bound="recorded" data-check={view.check}>
      <h4 className="ob-sent-h">What was sent</h4>
      <p className="ob-lbl ob-after-h">Recorded by this gateway — not sealed in the ticket</p>
      <Content content={view.content} display={display} executionContext={executionContext} sealed={false} />
      <ArgsCheckLine check={view.check} />
    </div>
  );
}

/** Rows shown before "Show all" — the answer's first lines are what matter. */
const RESULT_ROWS_SHOWN = 5;

/** "Result" fold (§18.3): what the system answered; its values are read by the gateway, so blue. */
function ResultFold({ result, systemName, sent }: {
  result: NonNullable<LocalReceiptEntry['result']>;
  systemName: string;
  sent: Record<string, unknown> | null;
}) {
  const body = resultBody(result, sent);
  const [all, setAll] = useState(false);
  const summary = !result.ok
    ? 'the action failed'
    : body.kind === 'rows'
      ? `what ${systemName} answered · ${body.rows.length} value${body.rows.length === 1 ? '' : 's'}`
      : `what ${systemName} answered`;
  return (
    <ObFold title="Result" summary={summary} testId="ticket-result" attrs={{ 'data-ok': result.ok ? 'true' : 'false' }}>
      <p className="ob-lbl">Read by the gateway from {systemName}</p>
      {!result.ok && <p className="ob-check"><b>The action failed.</b></p>}
      {body.kind === 'rows' ? (
        <dl className="ob-kv ticket-sent-fields">
          {(all ? body.rows : body.rows.slice(0, RESULT_ROWS_SHOWN)).map((r) => (
            <Fragment key={r.key}>
              <dt>{r.label}</dt>
              <dd className="is-system">{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="ob-text is-system">{body.text}</p>
      )}
      {body.kind === 'rows' && body.rows.length > RESULT_ROWS_SHOWN && (
        <button type="button" className="ob-link" onClick={() => setAll(a => !a)}>
          {all ? 'Show less' : `Show all ${body.rows.length}`}
        </button>
      )}
      {result.truncated && <p className="ob-quiet">Shortened to fit what this device keeps.</p>}
    </ObFold>
  );
}

/** What was sent, as an object — to leave out the answer's echoes of it. */
function sentObject(entry: LocalReceiptEntry): Record<string, unknown> | null {
  const cands = [entry.entry.sentArgs, entry.entry.proposal?.toolArgs, entry.entry.boundContent];
  for (const c of cands) if (c && typeof c === 'object' && !Array.isArray(c)) return c as Record<string, unknown>;
  return null;
}

export function TicketWhatWasDone({ receipt, manifests }: Props) {
  // undefined = loading; null = fetched, no local copy (off-device).
  const [entry, setEntry] = useState<LocalReceiptEntry | null | undefined>(undefined);
  const [hashVerified, setHashVerified] = useState<boolean | null>(null);
  const [display, setDisplay] = useState<ToolDisplay | undefined>(undefined);

  // Whether the ticket carries a signed fingerprint to check against — read
  // once per receipt, not async.
  const hasHashToCheck = Boolean(receipt.contentHash && receipt.contentBinding);

  useEffect(() => {
    let live = true;
    loadToolDisplays().then((all) => { if (live) setDisplay(all[receipt.action]); });
    return () => { live = false; };
  }, [receipt.action]);

  useEffect(() => {
    let live = true;
    setEntry(undefined);
    setHashVerified(null);

    // Resolve BOTH the archive fetch and the hash check before committing
    // either piece of state — otherwise the card would briefly render a
    // failed check (hashVerified still null) before the async check lands.
    (async () => {
      let found: LocalReceiptEntry | null;
      try {
        found = await spClient.getArchivedReceipt(receipt.id);
      } catch {
        if (live) setEntry(null);
        return;
      }

      let verified: boolean | null = null;
      const boundContent = found?.entry.boundContent;
      if (boundContent !== undefined && hasHashToCheck) {
        try {
          const recomputed = await computeContentHashBrowser(receipt.contentBinding!.kind, boundContent);
          verified = recomputed === receipt.contentHash;
        } catch {
          // Could not even recompute — never claim a match on a check that didn't run.
          verified = false;
        }
      }

      if (live) {
        setHashVerified(verified);
        setEntry(found);
      }
    })();

    return () => { live = false; };
  }, [receipt.id, receipt.contentHash, receipt.contentBinding, hasHashToCheck]);

  // UI spec §15.2 — one attachment's live preview for THIS ticket's own
  // local receipt archive entry (never stored on the ticket itself).
  const fetchAttachmentPreview = useCallback(
    (sha256: string) => spClient.getReceiptAttachmentPreview(receipt.id, sha256),
    [receipt.id],
  );

  if (entry === undefined) {
    return (
      <div className="ob-sent ob-quiet" data-testid="ticket-what-was-done" data-bound="loading" aria-busy="true">
        Loading…
      </div>
    );
  }

  const proposalArgs = entry?.entry.proposal?.toolArgs;
  const view = sentView({
    offDevice: entry === null,
    boundContent: entry?.entry.boundContent,
    sentArgs: entry?.entry.sentArgs,
    sentArgsOmitted: entry?.entry.sentArgsOmitted,
    proposalArgs: proposalArgs && typeof proposalArgs === 'object' && !Array.isArray(proposalArgs)
      ? proposalArgs as Record<string, unknown>
      : undefined,
    hasHashToCheck,
    hashVerified,
    sentArgsCheck: entry?.sentArgsCheck,
  });
  const systemName = systemDisplayName(splitTool(receipt.action).integrationId, manifests);
  // UI spec §15.2 — attachments/inserted values stay sealed on the ticket
  // view too, same box as the approval card.
  const attachmentsSealed = extractAttachmentsSealed((entry ? sentObject(entry) : null) ?? undefined);

  return (
    <>
      <SentBox view={view} display={display} executionContext={receipt.executionContext} />
      <AttachmentsSealedBox
        attachments={attachmentsSealed.attachments}
        inserts={attachmentsSealed.inserts}
        manifests={manifests}
        fetchPreview={fetchAttachmentPreview}
      />
      {entry?.result && <ResultFold result={entry.result} systemName={systemName} sent={sentObject(entry)} />}
    </>
  );
}
