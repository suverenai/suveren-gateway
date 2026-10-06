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
import { getReport, saveReport, recheckReport, exportReport, McpLockedError } from '../lib/mcp-bridge';

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

/**
 * @param getGatewayVersion A GETTER, not a value: `RUNNING_VERSION` in
 *   index.ts is computed later in that file than this router is mounted, so
 *   capturing the plain value here would read it before initialization
 *   (TDZ). Reading it lazily, on request, is safe — by the time any request
 *   arrives the whole module has finished loading.
 */
export function createReportRouter(getGatewayVersion: () => string): Router {
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

  // "Export with proof" (R6) — a self-contained HTML file, not JSON, so it
  // gets its own response handling rather than reusing handleError's JSON
  // error body for the one success path.
  router.get('/export', async (_req: Request, res: Response) => {
    try {
      const { html, filename } = await exportReport(getGatewayVersion());
      res
        .setHeader('Content-Type', 'text/html; charset=utf-8')
        .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
        .setHeader('Cache-Control', 'no-store')
        .send(html);
    } catch (err) {
      if (err instanceof McpLockedError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(502).json({
        error: 'Export failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
