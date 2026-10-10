/**
 * AU3/AU5 wire shapes — the interface contract in
 * temp/briefs/au3-au5-brief.md ("Control plane — GET /proposal-status/:id/preview").
 * The UI card is built in parallel against exactly this; don't change field
 * names here without the owner.
 */

export interface PreviewBody {
  structured?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  text?: string;
}

export interface PreviewVersionInfo {
  field: string;
  approved: string | number;
  current: string | number;
  stale: boolean;
  /** Only present when `stale` — the current read's body, for a side-by-side compare. */
  currentBody?: PreviewBody;
}

/**
 * What the MCP server's POST /internal/preview answers — identical to
 * {@link PreviewResponse}'s 'ok' branch minus `readAt`, which the control
 * plane stamps on relay (the read happens inside that call, so the MCP
 * server's own clock is the honest one; the control plane just can't see it
 * from outside).
 */
export type InternalPreviewResult =
  | { status: 'none' }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | { status: 'ok'; integration: string; tool: string; body: PreviewBody; version?: PreviewVersionInfo };

/** GET /proposal-status/:id/preview's response (always 200 unless auth/proposal fetch fails). */
export type PreviewResponse =
  | { status: 'none' }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | {
      status: 'ok';
      integration: string;
      tool: string;
      readAt: number;
      body: PreviewBody;
      version?: PreviewVersionInfo;
    };

/** GET /proposal-status/:id/outcome's response. */
export interface ProposalOutcome {
  state: 'none' | 'intent' | 'done' | 'failed';
  outcome?: 'refused' | 'changed';
  detail?: string;
  at?: number;
}
