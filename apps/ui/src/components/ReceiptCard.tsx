/**
 * One receipt, as a person reads it.
 *
 * The card answers three questions in order: what happened, under whose
 * authority, and where the proof is. Everything that is an identifier — the
 * namespaced tool name, the qualified profile id, the hashes — sits under
 * "Raw", because none of it answers any of those questions.
 *
 * Facts are shown as labeled rows, never composed into a sentence: a sentence
 * blurs which words are stored data and which are the UI's phrasing, and this
 * page is read when someone needs to know exactly what the record says.
 *
 * The mandate rows (allowed / intent) come from LOCAL storage — the Authority
 * Server holds only their hashes — so they are absent for receipts that ran on
 * another device. That absence is stated, never quietly rendered as blank.
 */

import { useState } from 'react';
import {
  actionLabel,
  scopeSummary,
  wasReviewed,
  profileVersionLabel,
  allowedSummary,
  usageSummary,
} from '../lib/receipt-summary';
import { profileIdentity, isTestSetupAction } from '../lib/profile-identity';
import { useProfile } from '../lib/profile-cache';
import { useAreaCatalog } from '../lib/area-catalog';
import { ObTypeLine, ObFold, useFoldAccordion } from './ObjectCard';
import { TicketHeadline } from './TicketHeadline';
import { areaName, systemName, shortTicketId, ticketTime } from '../lib/core-objects';
import { TicketWhatWasDone } from './TicketWhatWasDone';
import { TicketWhatYouSaw } from './TicketWhatYouSaw';
import type {
  ExecutionReceipt,
  IntegrationManifest,
  LocalAuthorization,
  SignatureStatus,
} from '../lib/sp-client';

interface Props {
  receipt: ExecutionReceipt;
  manifests: IntegrationManifest[];
  /** Local values for this grant (context, intent, bounds); absent off-device. */
  localAuth?: LocalAuthorization;
  /**
   * True when the local store could not be read at all (MCP down, vault
   * locked). Distinct from "this grant has no local copy" — reporting the
   * former as the latter would state something false about the record.
   */
  localUnavailable?: boolean;
  /**
   * Result of verifying this receipt's signature locally. Absent means there
   * is no local copy to verify — which is a different statement from "the
   * check failed", and the card says so.
   */
  signature?: SignatureStatus;
  /** Human name for the grant, from the Authority Server's attestation record. */
  grantTitle?: string | null;
  /** Owner line — shown on the Team tab, where whose authority it was matters. */
  ownerLabel?: string | null;
  /** Authority Server base URL, for the public receipt link. */
  spUrl: string;
  formatDate: (ts: number) => string;
  onOpenComplete: () => void;
  /** Issued since the last visit to Tickets (UI spec §12.3). */
  isNew?: boolean;
  /** Start opened — e.g. the only ticket, or a direct link. Default: a compact row. */
  defaultOpen?: boolean;
}

export function ReceiptCard({
  receipt,
  manifests,
  localAuth,
  localUnavailable,
  signature,
  grantTitle,
  ownerLabel,
  spUrl,
  formatDate,
  onOpenComplete,
  isNew = false,
  defaultOpen = false,
}: Props) {
  const profile = useProfile(receipt.profileId);
  const scope = scopeSummary(receipt, profile);
  const allowed = allowedSummary(localAuth?.context, profile);
  const usage = usageSummary(receipt, localAuth?.bounds ?? receipt.limits, profile);
  const intent = localAuth?.intent;
  // Test setup: the delegation profile, OR a setup__* tool — both run only
  // while simulation mode is on (see lib/profile-identity.ts).
  const testSetup = profileIdentity(receipt.profileId).testSetup || isTestSetupAction(receipt.action);
  // AU6: the mockup always shows the intent's first two lines, with "Show
  // full intent" only toggling the clamp — same pattern as the approval
  // card's mandate+intent block (components/ApprovalBody.tsx, AU5).
  const [intentExpanded, setIntentExpanded] = useState(false);
  // UI spec §12.2/§12.3: a ticket is a stub — a compact row that opens in
  // place to the full record below.
  const [open, setOpen] = useState(defaultOpen);
  const now = Date.now();
  const catalog = useAreaCatalog();
  const area = areaName(receipt.profileId, catalog);
  const system = systemName(receipt.action, manifests);
  const foldsRef = useFoldAccordion<HTMLDivElement>();
  const mandateName = grantTitle || profileVersionLabel(receipt.profileId);
  const when = ticketTime(receipt.timestamp, now);
  const shortId = shortTicketId(receipt.id);

  return (
    <div
      className={`ob-card ticket-obj-card${isNew ? ' is-new' : ''}${open ? ' is-open' : ''}`}
      data-new={isNew ? 'true' : 'false'}
      data-testid="ticket-card"
    >
      <button type="button" className="ob-head ticket-obj-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ObTypeLine
          tag="Ticket"
          profileId={receipt.profileId}
          className="obj-line"
          parts={[
            area,
            `via ${system}`,
            when,
            <span className="ob-st" key="st">{wasReviewed(receipt) ? 'Approved' : 'Automatic'}</span>,
            testSetup ? 'Test setup' : null,
            isNew ? <span className="ob-st" key="new" aria-label="new since your last visit">New</span> : null,
          ]}
        />
        {/* Headline: what happened, in words — "<Area> · <summary>" (§18.1). */}
        <span className="ob-title receipt-what">
          {area} · <span data-testid="ticket-headline"><TicketHeadline ticketId={receipt.id} timestamp={receipt.timestamp} proposalId={receipt.proposalId} tool={receipt.action} manifests={manifests} label={actionLabel(receipt, manifests)} /></span>
        </span>
        {/* The signature line sits under the title (§18.3) — only what was actually checked here. */}
        {signature === 'valid' && (
          <span className="ob-check" title="Ed25519 signature checked on this device against the issuer key archived when the ticket was issued — no Authority Server involved.">
            <span aria-hidden="true">&#10003;</span><span>Signature verified on this device · ticket <span className="ob-mono">{shortId}</span></span>
          </span>
        )}
        {signature === 'valid-legacy' && (
          <span className="ob-check" title="Ed25519 signature checked on this device against the issuer key archived when the ticket was issued. This ticket was issued before protocol 0.7 and is checked with that version's format.">
            <span aria-hidden="true">&#10003;</span><span>Signature verified on this device · issued before protocol 0.7 · ticket <span className="ob-mono">{shortId}</span></span>
          </span>
        )}
        {signature === 'invalid' && (
          <span className="ob-check ob-check-x" title="The stored ticket does not match what was signed.">
            <span aria-hidden="true">&#10005;</span><b>Signature check failed · ticket <span className="ob-mono">{shortId}</span></b>
          </span>
        )}
        {signature !== 'valid' && signature !== 'valid-legacy' && signature !== 'invalid' && (
          <span className="ob-one">Ticket <span className="ob-mono">{shortId}</span></span>
        )}
        {/* What THIS call touched (from the signed receipt). */}
        {scope && <span className="ob-one receipt-scope">{scope}</span>}
      </button>

      {open && (
        <div ref={foldsRef} className="ob-open">
          {/* "What was sent" FIRST — sealed in the ticket (grey lock tile), or recorded by
              this gateway (open, no tile), then Result as a fold (UI spec §14, §18.3). */}
          <TicketWhatWasDone receipt={receipt} manifests={manifests} />

          {/* AU10 §8.4 — "What you saw": only meaningful for a ticket that ran
              via a committed (review-mode) proposal. */}
          {receipt.proposalId && (
            <TicketWhatYouSaw proposalId={receipt.proposalId} tool={receipt.action} manifests={manifests} />
          )}

          <ObFold title="Mandate" summary={[mandateName, usage].filter(Boolean).join(' · ')} testId="ticket-mandate">
            <p className="ob-lbl">
              {intent || allowed ? 'Name, allowed values and intent: from this device.' : 'Name: from this device.'}
              {usage ? ' Use: sealed in the ticket.' : ''}
            </p>
            <dl className="ob-kv receipt-rows">
              <dt>Mandate</dt><dd>{mandateName}</dd>
              {ownerLabel && <><dt>Owner</dt><dd>{ownerLabel}</dd></>}
              {allowed && <><dt>Allowed</dt><dd>{allowed}</dd></>}
              {usage && <><dt>Used</dt><dd className="receipt-num">{usage}</dd></>}
              <dt>Intent</dt>
              <dd className="ob-plain">
                {intent
                  ? (
                    <>
                      <span className={`intent-text${intentExpanded ? '' : ' intent-clamped'}`}>{intent}</span>{' '}
                      <button type="button" className="ob-link" onClick={() => setIntentExpanded(!intentExpanded)}>
                        {intentExpanded ? 'Show less' : 'Show full intent'}
                      </button>
                    </>
                  )
                  : <span className="receipt-absent">
                      {localUnavailable
                        ? 'local store unreachable — sign in to the gateway to read it'
                        : 'not on this device — the Authority Server stores only its hash'}
                    </span>}
              </dd>
            </dl>
          </ObFold>

          <ObFold title="Technical details" summary={`ticket ${shortId} · ${formatDate(receipt.timestamp)}`} testId="ticket-technical">
            <p className="ob-lbl">Read from the signed ticket.</p>
            <dl className="ob-kv">
              <dt>Ticket</dt><dd className="ob-mono">{receipt.id}</dd>
              <dt>Issued</dt><dd className="receipt-when">{formatDate(receipt.timestamp)}</dd>
              <dt>Action</dt><dd className="ob-mono">{receipt.action}</dd>
            </dl>
            <details className="ob-raw receipt-more">
              <summary>Raw</summary>
              <div className="ob-mono receipt-kv">
                <div>ticket &middot; {receipt.id}</div>
                <div>action &middot; {receipt.action}</div>
                <div>profile &middot; {receipt.profileId}</div>
                {receipt.authorizationId && <div>mandate &middot; {receipt.authorizationId}</div>}
                {Object.keys(receipt.executionContext ?? {}).length > 0 && (
                  <div>
                    scope &middot;{' '}
                    {Object.entries(receipt.executionContext)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' · ')}
                  </div>
                )}
                {localAuth?.boundsHash && <div>bounds hash &middot; {localAuth.boundsHash}</div>}
                {localAuth?.contextHash && <div>scope hash &middot; {localAuth.contextHash}</div>}
                {receipt.contentHash && <div>content &middot; {receipt.contentHash}</div>}
                {receipt.proposalId && <div>proposal &middot; {receipt.proposalId}</div>}
                <div>signature &middot; {receipt.signature}</div>
              </div>
            </details>
          </ObFold>

          {/* Evidence: the complete record vs the shareable redacted view. */}
          <div className="ob-btns receipt-foot">
            <button type="button" className="ob-btn receipt-evidence-link" onClick={onOpenComplete}>
              Complete ticket
            </button>
            {spUrl && (
              <a
                className="ob-btn receipt-link"
                href={`${spUrl}/r/${receipt.id}`}
                target="_blank"
                rel="noreferrer"
                title="Redacted, shareable"
              >
                Public link &#8599;<span className="ob-btn-q"> · redacted</span>
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
