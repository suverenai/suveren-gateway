/**
 * Tool preview (AU3/AU4) — the gatekeeper-internal, pre-approval read a
 * manifest declares for an action tool via
 * `toolGating.overrides[<tool>].preview` (see tool-gating-types.ts).
 *
 * Decisions (Andreas, 2026-10-10 — temp/briefs/au3-au5-brief.md):
 *   1. The preview read is always allowed for the approver, shown ONLY on the
 *      gateway UI — never returned to the AI/any MCP client, not subject to
 *      the mandate's read access, recorded locally with no content.
 *   2. No preview / connector unreachable → the card still works with the
 *      bound values; Approve/Reject stay enabled.
 *   3. Any approving gateway reads with its OWN connector — nothing about
 *      the record goes to the Authority Server.
 *
 * Consumed by:
 *   - bin/http.ts's POST /internal/preview — the approver's live read.
 *   - tool-proxy.ts, at proposal submission, to snapshot a `previewHash` for
 *     a tool that declares a preview but no `version` (AU4 fallback).
 *   - commitments.ts's executeCommitted, which re-reads and compares that
 *     hash right before the tool runs.
 */
import { computeContentHash } from '@hap/core';
import type { IntegrationManager } from './integration-manager';
import { getManifest } from './manifest-loader';
import type { ToolPreviewConfig } from './tool-gating-types';

export type { ToolPreviewConfig };

/** A read's body, generic across connectors. */
export interface PreviewBody {
  structured?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  text?: string;
}

export type PreviewReadResult =
  | { status: 'ok'; body: PreviewBody }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string };

/** Per-read timeout (contract: "Timeout per read: 5s"). */
export const PREVIEW_READ_TIMEOUT_MS = 5_000;
/** Connector-answer text cap — "from the system" messages shown to the approver. */
export const PREVIEW_MESSAGE_CAP = 500;

export function capText(text: string | undefined, max = PREVIEW_MESSAGE_CAP): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** The manifest's declared preview for a tool, or undefined — never inferred. */
export function getToolPreviewConfig(integrationId: string, toolName: string): ToolPreviewConfig | undefined {
  const manifest = getManifest(integrationId);
  const overrides = manifest?.toolGating?.overrides ?? {};
  const entry = overrides[toolName] as { preview?: ToolPreviewConfig } | null | undefined;
  return entry?.preview;
}

/**
 * Map the action's bound arguments onto the preview (read) tool's own
 * argument names, per the manifest's `args` dict (key = preview arg name,
 * value = action arg name — same direction as `executionMapping`). An action
 * arg that is absent is simply omitted, never invented.
 */
export function mapPreviewArgs(
  preview: Pick<ToolPreviewConfig, 'args'>,
  actionArgs: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [targetArg, sourceArg] of Object.entries(preview.args)) {
    if (sourceArg in actionArgs) mapped[targetArg] = actionArgs[sourceArg];
  }
  return mapped;
}

/**
 * True when the preview declares args but the action carries none of them —
 * an optional link left out (crm create_task without a contact_id). There is
 * no record to show, so this is "no preview", never a read with empty args
 * that the connector would answer with "not found".
 */
export function previewHasNoTarget(
  preview: Pick<ToolPreviewConfig, 'args'>,
  mapped: Record<string, unknown>,
): boolean {
  return Object.keys(preview.args).length > 0 && Object.keys(mapped).length === 0;
}

export class PreviewTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreviewTimeoutError('preview read timed out')), ms);
  });
  return (Promise.race([p, timeout]) as Promise<T>).finally(() => clearTimeout(timer));
}

/**
 * Call a declared preview (read) tool directly through the integration
 * manager — NOT tool-proxy: no ticket, no read gate (decision 1). The caller
 * is responsible for only ever naming a tool resolved from the manifest's own
 * `preview.tool` — never an arbitrary caller-supplied name (see http.ts).
 *
 * `previewTool` must be present in the integration's CURRENT discovered tool
 * list — not just named by the manifest — so a connector that isn't running,
 * or whose tool disappeared, answers `unavailable` rather than throwing.
 */
export async function readPreview(
  integrationManager: IntegrationManager,
  integrationId: string,
  previewTool: string,
  args: Record<string, unknown>,
): Promise<PreviewReadResult> {
  const discovered = integrationManager
    .getAllTools()
    .find(t => t.integrationId === integrationId && t.originalName === previewTool);
  if (!discovered) {
    return { status: 'unavailable', reason: 'no_connector' };
  }
  try {
    const result = await withTimeout(
      integrationManager.callTool(integrationId, previewTool, args),
      PREVIEW_READ_TIMEOUT_MS,
    );
    const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text;
    if (result.isError) {
      return { status: 'not_found', message: capText(text) };
    }
    return {
      status: 'ok',
      body: {
        ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
        ...(discovered.outputSchema ? { outputSchema: discovered.outputSchema } : {}),
        ...(text !== undefined ? { text } : {}),
      },
    };
  } catch (err) {
    if (err instanceof PreviewTimeoutError) {
      return { status: 'unavailable', reason: 'timeout' };
    }
    return {
      status: 'unavailable',
      reason: 'connector_error',
      message: capText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * jcs/sha256 of the structured result, else text — the AU4 fallback snapshot
 * for a preview WITHOUT a declared `version`. This never leaves the machine;
 * it exists only to detect "did the record change since we read it", not as
 * a security/binding hash.
 */
export function hashPreviewBody(body: Pick<PreviewBody, 'structured' | 'text'>): string {
  if (body.structured !== undefined) {
    return computeContentHash({ kind: 'jcs', version: '1' }, body.structured);
  }
  return computeContentHash({ kind: 'text', version: '1' }, body.text ?? '');
}

/**
 * AU4 fallback snapshot at proposal submission, for a preview WITHOUT a
 * declared `version` (a connector with no document-version enforcement of
 * its own — e.g. nothing like ERP 0.6.0's own revision refusal). Reads the
 * preview ONCE with the action's bound args and hashes the result.
 *
 * Returns undefined when: the tool declares no preview; it declares one
 * WITH a version (the connector refuses a stale version itself — no
 * fallback needed, see executeCommitted); or the read didn't succeed —
 * nothing to compare against later is better than snapshotting an error and
 * refusing every future execution because of it.
 */
export async function computeSubmissionPreviewHash(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
): Promise<string | undefined> {
  const preview = getToolPreviewConfig(integrationId, toolName);
  if (!preview || preview.version) return undefined;
  const mapped = mapPreviewArgs(preview, actionArgs);
  if (previewHasNoTarget(preview, mapped)) return undefined;
  const read = await readPreview(integrationManager, integrationId, preview.tool, mapped);
  if (read.status !== 'ok') return undefined;
  return hashPreviewBody(read.body);
}

/**
 * AU4 — re-read and compare against a `previewHash` stored at submission,
 * right before executing a committed proposal. True means "do not run":
 * the record provably changed, OR the re-read could not positively confirm
 * it did NOT — fail-closed, the same way an unreadable execution journal
 * refuses rather than guessing (see execution-journal.ts).
 */
export async function previewChangedSinceSubmission(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
  previousHash: string,
): Promise<boolean> {
  const preview = getToolPreviewConfig(integrationId, toolName);
  if (!preview) return true; // nothing to re-verify against — fail closed
  const mapped = mapPreviewArgs(preview, actionArgs);
  const read = await readPreview(integrationManager, integrationId, preview.tool, mapped);
  if (read.status !== 'ok') return true; // can't confirm unchanged — fail closed
  return hashPreviewBody(read.body) !== previousHash;
}

/**
 * Full orchestration for one `/internal/preview` call: resolves the
 * manifest's declared preview (if any), reads it, and — when the manifest
 * declares `version` — performs the SECOND read (mapped args minus the
 * version arg) to detect staleness. Everything the manifest knows about this
 * connector (which field, which arg) stays here; callers (http.ts, and the
 * control plane relaying its answer) never see a connector-specific name.
 */
export type InternalPreviewResult =
  | { status: 'none' }
  | { status: 'unavailable'; reason: 'no_connector' | 'connector_error' | 'timeout'; message?: string }
  | { status: 'not_found'; message?: string }
  | {
      status: 'ok';
      integration: string;
      tool: string;
      body: PreviewBody;
      version?: {
        field: string;
        approved: string | number;
        current: string | number;
        stale: boolean;
        currentBody?: PreviewBody;
      };
      /** The manifest's declared `preview.fields`, passed through untouched
       *  so the UI's field order/priority comes from the same one place —
       *  never re-declared or guessed on the wire. */
      fields?: string[];
    };

export async function buildInternalPreview(
  integrationManager: IntegrationManager,
  integrationId: string,
  toolName: string,
  actionArgs: Record<string, unknown>,
): Promise<InternalPreviewResult> {
  const preview = getToolPreviewConfig(integrationId, toolName);
  if (!preview) return { status: 'none' };

  const mappedArgs = mapPreviewArgs(preview, actionArgs);
  if (previewHasNoTarget(preview, mappedArgs)) return { status: 'none' };
  const read1 = await readPreview(integrationManager, integrationId, preview.tool, mappedArgs);
  if (read1.status !== 'ok') return read1;

  // One place builds every "ok" return from here on, so `fields` (the
  // manifest's declared field priority — see tool-gating-types.ts) can
  // never be forgotten on one of the several early-return branches below.
  const ok = (extra: Partial<Extract<InternalPreviewResult, { status: 'ok' }>> = {}): InternalPreviewResult => ({
    status: 'ok',
    integration: integrationId,
    tool: preview.tool,
    body: read1.body,
    ...(preview.fields ? { fields: preview.fields } : {}),
    ...extra,
  });

  if (!preview.version) {
    return ok();
  }

  const approved = actionArgs[preview.version.arg];
  if (typeof approved !== 'string' && typeof approved !== 'number') {
    // The action arg the manifest says carries the version is absent or the
    // wrong type at call time — a manifest/call mismatch, not a connector
    // fault. Degrade to "no version info" rather than fail the whole read.
    return ok();
  }

  const { [preview.version.arg]: _omit, ...withoutVersion } = actionArgs;
  const mappedCurrentArgs = mapPreviewArgs(preview, withoutVersion);
  const read2 = await readPreview(integrationManager, integrationId, preview.tool, mappedCurrentArgs);
  if (read2.status !== 'ok' || read2.body.structured === undefined) {
    // Can't determine staleness — show the approved read without a version
    // comparison rather than failing the whole preview.
    return ok();
  }

  const current = read2.body.structured[preview.version.field];
  if (typeof current !== 'string' && typeof current !== 'number') {
    return ok();
  }

  const stale = String(current) !== String(approved);
  return ok({
    version: {
      field: preview.version.field,
      approved,
      current,
      stale,
      ...(stale ? { currentBody: read2.body } : {}),
    },
  });
}
