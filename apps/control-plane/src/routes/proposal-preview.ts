/**
 * AU3/AU5 — GET /proposal-status/:id/preview and GET /proposal-status/:id/outcome.
 *
 * `preview` fetches the proposal from the Authority Server with THIS
 * gateway's own session (same pattern as evidence-export.ts: fetchAs + TLS
 * pin), then asks the MCP server for the declared preview read
 * (POST /internal/preview) — gateway-internal, never ticketed, never read-
 * gated (decision 1, temp/briefs/au3-au5-brief.md). Always 200 unless the
 * caller's own session or the proposal fetch itself fails.
 *
 * PE1: a proposal fetched here may carry `content` (sealed) instead of
 * `toolArgs` — decrypted locally with the vault's private key (same
 * construction as /api/decrypt-proposal-content) before it ever reaches
 * getToolPreview. A device that cannot decrypt it (no key wrap for this
 * user) answers `unavailable` rather than failing the whole page.
 *
 * `outcome` reads the LOCAL execution journal (plaintext, like denials-
 * reader.ts reads denials.enc.json) so the UI can show what this gateway
 * actually did, instead of the Authority Server's "executed" (which it
 * marks when it ISSUES the ticket — before the action runs).
 */
import { Router, type Request, type Response } from 'express';
import { getToolPreview, getToolRequestContext, getAttachmentPreview } from '../lib/mcp-bridge';
import { findSealedAttachment } from '../lib/attachment-preview-types';
import { decryptProposalContent, type ProposalContentWire } from '../lib/content-crypto';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';
import { readPairing } from '../lib/as-pairing';
import { resolvePinTls } from '../lib/as-config';
import { fetchAs, AsTlsMismatchError } from '../lib/as-tls-pin';
import { findLatestByProposal } from '../lib/execution-journal-reader';
import type { PreviewResponse, ProposalOutcome } from '../lib/preview-types';
import type { RequestContextResult } from '../lib/request-context-types';
import { computeShownHash, type ShownSnapshotStore } from '../lib/shown-snapshot';

const AS_FETCH_TIMEOUT_MS = 10_000;

interface ProposalForPreview {
  tool: string;
  /** Present only on a legacy (pre-encryption) row. */
  toolArgs?: Record<string, unknown>;
  /** PE1 — present iff `toolArgs` is absent. */
  content?: ProposalContentWire;
}

/** Shared by both routes below — fetch the proposal from the AS with this
 *  gateway's own session, then resolve its (possibly PE1-sealed) toolArgs.
 *  On any failure, writes the response itself and returns undefined — the
 *  caller just checks for that and returns. */
async function resolveProposalToolArgsForRoute(
  spUrl: string,
  vault: Vault,
  dataDir: string,
  lockAsTlsMismatch: () => void,
  proposalId: string,
  res: Response,
): Promise<{ tool: string; toolArgs: Record<string, unknown> } | undefined> {
  const cookie = vault.getSpCookie();
  if (!cookie) {
    res.status(401).json({ error: 'No Authority Server session — sign in to preview this proposal.' });
    return undefined;
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
      return undefined;
    }
    proposal = asBody.proposal;
  } catch (err) {
    if (err instanceof AsTlsMismatchError) {
      lockAsTlsMismatch();
      res.status(502).json({ error: err.message });
      return undefined;
    }
    res.status(502).json({ error: `Authority Server unreachable: ${err instanceof Error ? err.message : String(err)}` });
    return undefined;
  }

  // PE1 — resolve toolArgs: the plain field on a legacy row, or decrypt
  // `content` with this device's own vault key. A device added after the
  // proposal was made (no key wrap for this user) cannot preview it —
  // answered as `unavailable`, same shape as a connector that refused.
  if (proposal.toolArgs) {
    return { tool: proposal.tool, toolArgs: proposal.toolArgs };
  }
  if (proposal.content) {
    try {
      const kp = await loadOrGenerateKeyPair(vault);
      const me = vault.getSessionUser();
      const plaintext = await decryptProposalContent(proposal.content, me?.id ?? '', kp.privateKey);
      return { tool: proposal.tool, toolArgs: JSON.parse(plaintext) as Record<string, unknown> };
    } catch (err) {
      res.json({ status: 'unavailable', reason: 'connector_error', message: `Could not decrypt this proposal's content on this device: ${err instanceof Error ? err.message : String(err)}` } satisfies PreviewResponse);
      return undefined;
    }
  }
  res.status(502).json({ error: `Proposal ${proposalId} carries neither tool_args nor content.` });
  return undefined;
}

export function createProposalStatusRouter(
  spUrl: string,
  vault: Vault,
  dataDir: string,
  /** Same AS-TLS-mismatch lock every other call site uses — see evidence-export.ts. */
  lockAsTlsMismatch: () => void,
  /** AU10 §8.4 — the "what you saw" snapshot store. */
  shownSnapshotStore: ShownSnapshotStore,
): Router {
  const router = Router();

  router.get('/:id/preview', async (req: Request, res: Response) => {
    const proposalId = req.params.id;
    const resolved = await resolveProposalToolArgsForRoute(spUrl, vault, dataDir, lockAsTlsMismatch, proposalId, res);
    if (!resolved) return;

    try {
      const result = await getToolPreview({ proposalId, tool: resolved.tool, toolArgs: resolved.toolArgs });
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

  /**
   * UI spec §15.2 — the approval card's live attachment preview. `sha256`
   * must name an attachment ALREADY sealed on this proposal's own resolved
   * toolArgs (`_attachmentsSealed`) — the connector/kind/id to re-resolve
   * come from THAT, never from the request. A sha256 not on the proposal at
   * all answers 404, never a pass-through to the MCP server.
   */
  router.get('/:id/attachment-preview/:sha256', async (req: Request, res: Response) => {
    const proposalId = req.params.id;
    const sha256 = req.params.sha256;
    const resolved = await resolveProposalToolArgsForRoute(spUrl, vault, dataDir, lockAsTlsMismatch, proposalId, res);
    if (!resolved) return;

    const ref = findSealedAttachment(resolved.toolArgs, sha256);
    if (!ref) {
      res.status(404).json({ status: 'error', message: 'No sealed attachment with this fingerprint on this proposal.' });
      return;
    }
    try {
      const result = await getAttachmentPreview(ref);
      res.json(result);
    } catch (err) {
      res.status(502).json({ status: 'error', message: `MCP server unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // AU10 — Request + History blocks (doc/au10-request-context.md §3).
  router.get('/:id/request-context', async (req: Request, res: Response) => {
    const proposalId = req.params.id;
    const resolved = await resolveProposalToolArgsForRoute(spUrl, vault, dataDir, lockAsTlsMismatch, proposalId, res);
    if (!resolved) return;

    try {
      const result: RequestContextResult = await getToolRequestContext({ tool: resolved.tool, toolArgs: resolved.toolArgs });
      res.json(result);
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

  // AU10 §8.4 — store exactly what the card rendered, return its hash. The
  // UI sends the SAME payload it just displayed (request/history/preview
  // results + read time) — never re-read here, so no second read can
  // disagree with what the approver actually saw.
  router.post('/:id/shown-snapshot', (req: Request, res: Response) => {
    if (!vault.isUnlocked()) {
      res.status(401).json({ error: 'Vault is locked.' });
      return;
    }
    const snapshot = req.body;
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object') {
      res.status(400).json({ error: 'Request body must be the rendered snapshot (an object).' });
      return;
    }
    try {
      const shownHash = shownSnapshotStore.save(req.params.id, snapshot, vault);
      res.json({ shownHash });
    } catch (err) {
      res.status(500).json({ error: `Could not store the snapshot: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // AU10 §8.4 — ticket view's "What you saw": the LOCAL snapshot, re-hashed
  // here and compared to what was stored at decision time. No local
  // snapshot (a different device approved it, or this gateway never had
  // one) -> `status: 'off_device'`, never an error.
  router.get('/:id/shown-snapshot', (req: Request, res: Response) => {
    if (!vault.isUnlocked()) {
      res.status(401).json({ error: 'Vault is locked.' });
      return;
    }
    try {
      const entry = shownSnapshotStore.get(req.params.id, vault);
      if (!entry) {
        res.json({ status: 'off_device' });
        return;
      }
      const recomputed = computeShownHash(entry.snapshot);
      res.json({
        status: 'ok',
        snapshot: entry.snapshot,
        shownHash: entry.shownHash,
        storedAt: entry.storedAt,
        verifiedLocally: recomputed === entry.shownHash,
      });
    } catch (err) {
      res.status(500).json({ error: `Could not read the snapshot: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}
