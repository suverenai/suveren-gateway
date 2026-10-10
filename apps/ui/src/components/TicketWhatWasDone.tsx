/**
 * TicketWhatWasDone — "What was done", shown FIRST on a ticket card (AU6,
 * work-plan.md "Added 2026-10-09"; approved mockup
 * temp/mockups/gateway-ux-v7.html §3).
 *
 * Fetches this device's own receipt archive entry (`GET /api/evidence/receipt/:id`,
 * already serving `boundContent` — see apps/mcp-server/src/lib/receipt-archive.ts),
 * then — only when there IS bound content and a signed `contentHash` to check
 * it against — recomputes the hash locally (lib/content-hash.ts, a browser
 * mirror of hap-core's content-binding.ts) and compares. Never claims
 * "bound by hash" without that check passing; a mismatch is shown in red,
 * never silently treated as verified.
 *
 * No AI text, no lookups in another system: everything here is either the
 * ticket's own signed content, or this device's local evidence of it.
 */
import { useEffect, useState } from 'react';
import { spClient, type ExecutionReceipt, type LocalReceiptEntry } from '../lib/sp-client';
import { computeContentHashBrowser } from '../lib/content-hash';
import { boundContentView, checkedValueRows, ticketBoundStatus, type TicketBoundStatus } from '../lib/ticket-what-was-done';
import { RenderedPreviewView } from './RenderedPreviewView';
import type { AgentProfile } from '@hap/core';

interface Props {
  receipt: ExecutionReceipt;
  profile: AgentProfile | null;
}

export function TicketWhatWasDone({ receipt, profile }: Props) {
  // undefined = loading; null = fetched, no local copy (off-device).
  const [entry, setEntry] = useState<LocalReceiptEntry | null | undefined>(undefined);
  const [hashVerified, setHashVerified] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    setEntry(undefined);
    setHashVerified(null);

    // Resolve BOTH the archive fetch and the hash check before committing
    // either piece of state — setting `entry` first would make the card
    // briefly render "mismatch" (hashVerified still null) before the async
    // hash check catches up.
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
      if (boundContent !== undefined && receipt.contentHash && receipt.contentBinding) {
        try {
          const recomputed = await computeContentHashBrowser(receipt.contentBinding.kind, boundContent);
          verified = recomputed === receipt.contentHash;
        } catch {
          // Could not even recompute (e.g. the archived shape no longer
          // matches the declared kind) — never claim verified on a check
          // that didn't run.
          verified = false;
        }
      }

      if (live) {
        setHashVerified(verified);
        setEntry(found);
      }
    })();

    return () => { live = false; };
  }, [receipt.id, receipt.contentHash, receipt.contentBinding]);

  if (entry === undefined) {
    // Transitional — not one of the four states the owner's e2e asserts on;
    // the harness waits for `data-bound` to leave "loading" first, same
    // pattern as PreviewBox's data-preview-status.
    return (
      <div className="ticket-done-box ticket-done-loading" data-testid="ticket-what-was-done" data-bound="loading" aria-busy="true">
        Loading…
      </div>
    );
  }

  const offDevice = entry === null;
  const boundContent = entry?.entry.boundContent;
  const status: TicketBoundStatus = ticketBoundStatus({ offDevice, boundContent, hashVerified });

  if (status === 'off-device') {
    return (
      <div className="ticket-done-box ticket-done-off-device" data-testid="ticket-what-was-done" data-bound="off-device">
        <p className="ticket-done-note">Content not on this device — only the signed values are shown.</p>
      </div>
    );
  }

  if (status === 'none') {
    const rows = checkedValueRows(receipt.executionContext, profile);
    return (
      <div className="ticket-done-box" data-testid="ticket-what-was-done" data-bound="none">
        <h4>What was done</h4>
        {rows.length > 0 ? (
          <dl className="ticket-done-fields">
            {rows.map((r) => (
              <div className="ticket-done-field-row" key={r.key}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="ticket-done-note">No checked values recorded for this action.</p>
        )}
      </div>
    );
  }

  const rendered = boundContentView(boundContent, receipt.contentBinding?.fields);

  return (
    <div
      className={`ticket-done-box ${status === 'verified' ? 'ticket-done-verified' : 'ticket-done-mismatch'}`}
      data-testid="ticket-what-was-done"
      data-bound={status}
    >
      <h4>
        What was done <span className="src-tag src-tag-sealed">sealed</span>
      </h4>
      <RenderedPreviewView rendered={rendered} />
      {status === 'verified' ? (
        <p className="ticket-done-note ticket-done-note-ok">
          &#10003; This exact content is bound by hash — any change after the fact would break the ticket.
        </p>
      ) : (
        <p className="ticket-done-note ticket-done-note-bad">
          &#9888; This content does NOT match the ticket's signed hash — it may have been altered since archiving.
        </p>
      )}
    </div>
  );
}
