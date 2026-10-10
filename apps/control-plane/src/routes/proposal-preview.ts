/**
 * AU3/AU5 — GET /proposals/:id/preview and GET /proposals/:id/outcome.
 *
 * `preview` fetches the proposal from the Authority Server with THIS
 * gateway's own session (same pattern as evidence-export.ts: fetchAs + TLS
 * pin), then asks the MCP server for the declared preview read
 * (POST /internal/preview) — gateway-internal, never ticketed, never read-
 * gated (decision 1, temp/briefs/au3-au5-brief.md). Always 200 unless the
 * caller's own session or the proposal fetch itself fails.
 *
 * `outcome` reads the LOCAL execution journal (plaintext, like denials-
 * reader.ts reads denials.enc.json) so the UI can show what this gateway
 * actually did, instead of the Authority Server's "executed" (which it
 * marks when it ISSUES the ticket — before the action runs).
 */
import { Router, type Request, type Response } from 'express';
import { getToolPreview } from '../lib/mcp-bridge';
import type { Vault } from '../lib/vault';
import { readPairing } from '../lib/as-pairing';
import { resolvePinTls } from '../lib/as-config';
import { fetchAs, AsTlsMismatchError } from '../lib/as-tls-pin';
import { findLatestByProposal } from '../lib/execution-journal-reader';
import type { PreviewResponse, ProposalOutcome } from '../lib/preview-types';

const AS_FETCH_TIMEOUT_MS = 10_000;

interface ProposalForPreview {
  tool: string;
  toolArgs: Record<string, unknown>;
}

export function createProposalStatusRouter(
  spUrl: string,
  vault: Vault,
  dataDir: string,
  /** Same AS-TLS-mismatch lock every other call site uses — see evidence-export.ts. */
  lockAsTlsMismatch: () => void,
): Router {
  const router = Router();

  router.get('/:id/preview', async (req: Request, res: Response) => {
    const proposalId = req.params.id;
    const cookie = vault.getSpCookie();
    if (!cookie) {
      res.status(401).json({ error: 'No Authority Server session — sign in to preview this proposal.' });
      return;
    }

    let proposal: ProposalForPreview;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AS_FETCH_TIMEOUT_MS);
      const pin = readPairing(dataDir);
      let asStatus: number;
      let asBody: { proposal?: ProposalForPreview; error?: string };
      try {
        const { res: asRes } = await fetchAs(
          `${spUrl}/api/proposals/${encodeURIComponent(proposalId)}`,
          { headers: { Cookie: cookie }, signal: controller.signal },
          {
            enforce: resolvePinTls(dataDir),
            pinnedSpkiHex: pin && pin.asUrl === spUrl ? pin.tlsSpkiPinHex : undefined,
          },
        );
        asStatus = asRes.status;
        asBody = await asRes.json().catch(() => ({})) as { proposal?: ProposalForPreview; error?: string };
      } finally {
        clearTimeout(timeout);
      }
      if (asStatus < 200 || asStatus >= 300 || !asBody.proposal) {
        res.status(asStatus >= 400 ? asStatus : 502).json({
          error: asBody.error ?? `Could not fetch proposal ${proposalId} (${asStatus})`,
        });
        return;
      }
      proposal = asBody.proposal;
    } catch (err) {
      if (err instanceof AsTlsMismatchError) {
        lockAsTlsMismatch();
        res.status(502).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: `Authority Server unreachable: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    try {
      const result = await getToolPreview({ proposalId, tool: proposal.tool, toolArgs: proposal.toolArgs });
      if (result.status !== 'ok') {
        res.json(result);
        return;
      }
      const response: PreviewResponse = { ...result, readAt: Date.now() };
      res.json(response);
    } catch (err) {
      res.status(502).json({ error: `MCP server unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  router.get('/:id/outcome', (req: Request, res: Response) => {
    try {
      const entry = findLatestByProposal(dataDir, req.params.id);
      if (!entry) {
        const none: ProposalOutcome = { state: 'none' };
        res.json(none);
        return;
      }
      if (entry.state === 'intent') {
        const intent: ProposalOutcome = { state: 'intent', at: entry.startedAt };
        res.json(intent);
        return;
      }
      if (entry.state === 'done') {
        const done: ProposalOutcome = { state: 'done', at: entry.finishedAt ?? entry.startedAt };
        res.json(done);
        return;
      }
      const failed: ProposalOutcome = {
        state: 'failed',
        at: entry.finishedAt ?? entry.startedAt,
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      };
      res.json(failed);
    } catch (err) {
      res.status(500).json({ error: `Could not read the execution journal: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}
