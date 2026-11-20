import { useEffect, useState } from 'react';
import { spClient, type IntegrationManifest, type Proposal, type TicketHeadlineMaps } from '../lib/sp-client';
import { useProposalContent } from '@suveren/approval-card/lib/use-proposal-content';
import { ticketHeadline } from '../lib/ticket-what-was-done';
import { headlineSourceFor } from '../lib/ticket-headline-source';

/** One proposal fetch per page load, shared by every ticket that came from it. */
const proposals = new Map<string, Promise<Proposal | null>>();
function loadProposal(id: string): Promise<Proposal | null> {
  let p = proposals.get(id);
  if (!p) {
    p = spClient.getProposal(id).catch(() => null);
    proposals.set(id, p);
  }
  return p;
}

const EMPTY: TicketHeadlineMaps = { automatic: {}, approved: {} };

/**
 * One fetch of the tickets' headline values for the whole list
 * (`GET /api/evidence/headlines`, this device's archive): what was sent for
 * automatic tickets, the approved toolArgs for review-path tickets this
 * gateway executed. Fetched again only for a ticket issued after the last
 * fetch — a new ticket arriving while the page is open — never per row. A
 * failed fetch is not kept, so the next ticket tries again; until then the
 * past-tense label stands.
 */
let headlines: { fetchedAtMs: number; maps: Promise<TicketHeadlineMaps> } | null = null;
function loadHeadlines(ticketTimestampSec: number): Promise<TicketHeadlineMaps> {
  if (!headlines || ticketTimestampSec * 1000 > headlines.fetchedAtMs) {
    const entry = {
      fetchedAtMs: Date.now(),
      maps: spClient.getTicketHeadlines().catch(() => {
        if (headlines === entry) headlines = null;
        return EMPTY;
      }),
    };
    headlines = entry;
  }
  return headlines.maps;
}

/** Test hook: forget the page-load caches. */
export function resetTicketHeadlineCaches(): void {
  headlines = null;
  proposals.clear();
}

function FromProposal({ proposal, tool, manifests, label }: { proposal: Proposal; tool: string; manifests: IntegrationManifest[]; label: string }) {
  const content = useProposalContent(proposal);
  return <>{ticketHeadline({ tool, manifests, label, approved: true, proposalArgs: content.toolArgs })}</>;
}

type Source =
  | { t: 'loading' }
  | { t: 'archive-approved'; args: Record<string, unknown> }
  | { t: 'proposal'; proposal: Proposal | null }
  | { t: 'archive-automatic'; args: Record<string, unknown> | null };

/**
 * A ticket's headline (UI spec §13.4): for an approved ticket, the sentence
 * the approver saw, built from the manifest's summary template ("Payment link
 * of 0.10 EUR: Suveren test charge"). Its values come first from this
 * gateway's own archive — the approved toolArgs kept when it executed the
 * ticket — because the Authority Server deletes a proposal's content once its
 * ticket is issued (DEC-22). Only when this device's archive has no entry (a
 * ticket another device executed) is the proposal fetched and decrypted, as
 * before; a proposal whose content is gone then shows the label. For an
 * automatic ticket, the same sentence from what this gateway sent (§14).
 * Otherwise — not readable here, older than §14, no template — the
 * manifest's past-tense label ("Payment link created").
 */
export function TicketHeadline({ ticketId, timestamp, proposalId, tool, manifests, label }: {
  ticketId: string;
  timestamp: number;
  proposalId?: string;
  tool: string;
  manifests: IntegrationManifest[];
  label: string;
}) {
  const [src, setSrc] = useState<Source>({ t: 'loading' });
  useEffect(() => {
    let live = true;
    setSrc({ t: 'loading' });
    void loadHeadlines(timestamp).then(maps => {
      if (!live) return;
      const pick = headlineSourceFor(maps, ticketId, proposalId);
      if (pick.t !== 'fetch-proposal') { setSrc(pick); return; }
      void loadProposal(pick.proposalId).then(p => { if (live) setSrc({ t: 'proposal', proposal: p }); });
    });
    return () => { live = false; };
  }, [proposalId, ticketId, timestamp]);

  switch (src.t) {
    case 'loading':
      return <>{label}</>;
    case 'archive-approved':
      return <>{ticketHeadline({ tool, manifests, label, approved: true, proposalArgs: src.args })}</>;
    case 'proposal':
      if (!src.proposal) return <>{label}</>;
      return <FromProposal proposal={src.proposal} tool={tool} manifests={manifests} label={label} />;
    case 'archive-automatic':
      return <>{ticketHeadline({ tool, manifests, label, approved: false, sentArgs: src.args })}</>;
  }
}
