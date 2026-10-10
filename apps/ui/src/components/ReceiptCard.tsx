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
import { ProfileRail } from './ProfileRail';
import { TicketWhatWasDone } from './TicketWhatWasDone';
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
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="receipt-row-label">{label}</dt>
      <dd className="receipt-row-value">{children}</dd>
    </>
  );
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

  return (
    <div className="card id-card" style={{ marginBottom: 0 }}>
      <ProfileRail profileId={receipt.profileId} />
      <div className="id-body">
      {/* Headline: what happened, in words. */}
      <div className="receipt-head">
        <span className="receipt-what">{actionLabel(receipt, manifests)}</span>
        <span className="receipt-tag">{wasReviewed(receipt) ? 'review' : 'automatic'}</span>
        {receipt.contentHash && (
          <span
            className="receipt-tag receipt-tag-bound"
            title={receipt.contentBinding?.fields
              ? `The ticket binds: ${receipt.contentBinding.fields.join(', ')}`
              : 'This exact content was authorized'}
          >
            content bound
          </span>
        )}
        {testSetup && <span className="sim-mark">Test setup</span>}
        <span className="auth-card-time">{formatDate(receipt.timestamp)}</span>
      </div>

      {/* What THIS call touched (from the signed receipt). */}
      {scope && <div className="receipt-scope">{scope}</div>}

      {/* "What was done" FIRST — the ticket's bound content (sealed), or the
          checked values when it binds none, or an off-device notice. See
          components/TicketWhatWasDone.tsx (AU6). */}
      <TicketWhatWasDone receipt={receipt} profile={profile} />

      {/* The record, as stored. */}
      <dl className="receipt-rows">
        <Row label="mandate">
          <strong>{grantTitle || profileVersionLabel(receipt.profileId)}</strong>{' '}
          <span className="src-tag src-tag-local">local</span>
        </Row>

        {ownerLabel && <Row label="owner">{ownerLabel}</Row>}

        {allowed && (
          <Row label="allowed">
            {allowed} <span className="src-tag src-tag-local">local</span>
          </Row>
        )}

        {usage && (
          <Row label="used">
            <span className="receipt-num">{usage}</span> <span className="src-tag src-tag-sealed">sealed</span>
          </Row>
        )}

        <Row label="intent">
          {intent
            ? (
              <>
                <span className={`intent-text${intentExpanded ? '' : ' intent-clamped'}`}>{intent}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm intent-toggle"
                  onClick={() => setIntentExpanded(!intentExpanded)}
                >
                  {intentExpanded ? 'Show less' : 'Show full intent'}
                </button>{' '}
                <span className="src-tag src-tag-local">local</span>
              </>
            )
            : <span className="receipt-absent">
                {localUnavailable
                  ? 'local store unreachable — sign in to the gateway to read it'
                  : 'not on this device — the Authority Server stores only its hash'}
              </span>}
        </Row>
      </dl>

      {/* Evidence: the complete record vs the shareable redacted view. */}
      <div className="receipt-foot">
        {signature === 'valid' && (
          <span className="receipt-verified" title="Ed25519 signature checked on this device against the issuer key archived when the ticket was issued — no Authority Server involved.">
            &#10003; Verified on this device
          </span>
        )}
        {signature === 'valid-legacy' && (
          <span className="receipt-verified" title="Ed25519 signature checked on this device against the issuer key archived when the ticket was issued. This ticket was issued before protocol 0.7 and is checked with that version's format.">
            &#10003; Verified on this device · issued before protocol 0.7
          </span>
        )}
        {signature === 'invalid' && (
          <span className="receipt-tamper" title="The stored ticket does not match what was signed.">
            &#9888; Signature check FAILED
          </span>
        )}
        <button type="button" className="receipt-evidence-link" onClick={onOpenComplete}>
          Complete ticket
        </button>
        {spUrl && (
          <span className="receipt-public">
            redacted, shareable:{' '}
            <a
              className="receipt-link"
              href={`${spUrl}/r/${receipt.id}`}
              target="_blank"
              rel="noreferrer"
            >
              public link &#8599;
            </a>
          </span>
        )}
      </div>

      <details className="receipt-more">
        <summary>Raw</summary>
        <div className="receipt-kv">
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
      </div>
    </div>
  );
}
