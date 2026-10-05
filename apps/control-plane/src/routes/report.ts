/**
 * GET/POST /api/report — authenticated UI surface for the one current
 * evidence-backed report (work-plan "evidence-backed reports", R5, gateway
 * frame half). Proxies the MCP server's `/internal/report*` routes, the same
 * pattern `evidence.ts` uses for `/internal/evidence` — the MCP server holds
 * the report store (vault-encrypted, next to the receipt archive); this
 * router is the authenticated path the UI actually calls.
 *
 * `POST /api/report` exists for the dev/test path (R's fixture-posting
 * command) and for a later AI-facing save tool to reuse the same store via
 * the control plane if it ever needs to — today nothing in this change calls
 * it from a gated tool (scope: "NOT building MCP tools").
 */
import { Router, type Request, type Response } from 'express';
import { getReport, saveReport, recheckReport, McpLockedError } from '../lib/mcp-bridge';

function handleError(res: Response, err: unknown): void {
  if (err instanceof McpLockedError) {
    res.status(503).json({ error: err.message });
    return;
  }
  res.status(502).json({
    error: 'Report unavailable',
    detail: err instanceof Error ? err.message : String(err),
  });
}

export function createReportRouter(): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      res.json(await getReport());
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const html = (req.body as { html?: unknown })?.html;
    if (typeof html !== 'string' || !html.trim()) {
      res.status(400).json({ error: 'Missing required field: html (non-empty string)' });
      return;
    }
    try {
      res.json(await saveReport(html));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/recheck', async (_req: Request, res: Response) => {
    try {
      res.json(await recheckReport());
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
