/**
 * GET /api/evidence-export — the user's evidence download, local-first.
 *
 * Two sources, different guarantees:
 *  - LOCAL (receipt archive + gate store, via the MCP bridge): the copy that
 *    works with no Authority Server at all — complete signed receipts as
 *    issued, the attestation blobs they ran under, the issuer key at issuance,
 *    and the intent/context text whose hashes those attestations commit to.
 *    Covers only executions performed through THIS gateway.
 *  - AUTHORITY SERVER (/api/receipts/export, best-effort): the full account
 *    history — other devices, review-mode approvals, up to the AS's index
 *    floor — available only while the account exists and the AS cooperates.
 *
 * The bundle always states which sources contributed. Serving one source
 * silently as if it were both would read as complete when it isn't; serving
 * nothing as a 200 would be a stale-fallback lie — if both sources fail, the
 * request fails visibly.
 */

import { Router, type Request, type Response } from 'express';
import { getLocalEvidence } from '../lib/mcp-bridge';
import { readApprovedIntents } from './approved-intents';
import type { Vault } from '../lib/vault';

const AS_FETCH_TIMEOUT_MS = 20_000;

export function createEvidenceExportRouter(spUrl: string, vault: Vault): Router {
  const router = Router();
  const getSpCookie = () => vault.getSpCookie();

  router.get('/', async (_req: Request, res: Response) => {
    // Local half — the custody copy.
    let local: Record<string, unknown> | null = null;
    let localError: string | undefined;
    try {
      local = await getLocalEvidence();
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
    }

    // AS half — best-effort completeness while the account exists.
    let authorityServer: unknown = null;
    let asError: string | undefined;
    const cookie = getSpCookie();
    if (!cookie) {
      asError = 'No Authority Server session — sign in to include the full account history.';
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AS_FETCH_TIMEOUT_MS);
      try {
        const asRes = await fetch(`${spUrl}/api/receipts/export`, {
          headers: { Cookie: cookie },
          signal: controller.signal,
        });
        if (asRes.ok) {
          authorityServer = await asRes.json();
        } else {
          asError = `Authority Server export failed: ${asRes.status}`;
        }
      } catch (err) {
        asError = `Authority Server unreachable: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        clearTimeout(timeout);
      }
    }

    // Both sources gone → fail visibly, never a hollow 200.
    if (!local && !authorityServer) {
      res.status(502).json({
        error: 'No evidence source available.',
        localError,
        asError,
      });
      return;
    }

    // Approver accountability records — the intent text each approver saw at
    // approval time (P6.4). Held by the control-plane itself, so it is
    // available even when the MCP server is down.
    let approvedIntents: Record<string, string> = {};
    try {
      approvedIntents = readApprovedIntents(vault);
    } catch { /* vault locked — the bundle notes nothing; store may be empty anyway */ }

    const exportedAt = Math.floor(Date.now() / 1000);
    const date = new Date(exportedAt * 1000).toISOString().slice(0, 10);
    res
      .setHeader('Content-Disposition', `attachment; filename="suveren-evidence-${date}.json"`)
      .setHeader('Cache-Control', 'no-store')
      .json({
        format: 'suveren-evidence-bundle/1',
        exportedAt,
        sources: {
          local: local !== null,
          authorityServer: authorityServer !== null,
          ...(localError ? { localError } : {}),
          ...(asError ? { asError } : {}),
        },
        local,
        approvedIntents,
        authorityServer,
      });
  });

  return router;
}
