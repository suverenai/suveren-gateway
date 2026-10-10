/**
 * Approval-card copy for the preview box and the after-execution outcome box
 * (AU5, work-plan.md "Added 2026-10-09"). Pure and unit-tested — the
 * component only renders what these functions return; it never branches on
 * `PreviewResponse`/`OutcomeResponse` itself.
 *
 * Every branch here keeps to decisions 2–4 in temp/briefs/au3-au5-brief.md:
 * the bound values stay visible and Approve/Reject stay enabled in every
 * fallback (this module never says anything that would justify disabling
 * them); no AI-written text is ever surfaced; a connector's own refusal text
 * is labelled as coming from the system, capped at 500 chars.
 */
import { diffPreviewBodies, renderPreviewBody, type RenderedPreview } from './preview-render';
import type { OutcomeResponse, PreviewResponse } from './sp-client';

const MESSAGE_CAP = 500;

function capMessage(msg: string): string {
  return msg.length > MESSAGE_CAP ? `${msg.slice(0, MESSAGE_CAP)}…` : msg;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export interface PreviewStaleView {
  heading: string;
  approvedLabel: string;
  currentLabel: string;
  /** Present when something besides the version field itself differs. */
  approvedRendered?: RenderedPreview;
  currentRendered?: RenderedPreview;
  /** Present instead of the two renders when nothing else differs. */
  unchangedNote?: string;
}

export interface PreviewBoxView {
  /** The box heading, e.g. "From ERP, before it runs". */
  heading: string;
  /** One line of lead text — always present, always honest about what this is. */
  note: string;
  /** Present only for status 'ok'. */
  rendered?: RenderedPreview;
  /** Present only when a version was declared (status 'ok'). */
  versionNote?: string;
  /** Present only when the declared version is stale. */
  stale?: PreviewStaleView;
}

/**
 * `systemName` is the integration's display name ("ERP"), already resolved
 * by the caller — this module does no manifest lookups of its own.
 */
export function previewBoxView(resp: PreviewResponse, systemName: string): PreviewBoxView {
  switch (resp.status) {
    case 'none':
      if (resp.reason === 'no_target') {
        return {
          heading: 'Nothing to read beforehand',
          note: `This action does not refer to an existing record — nothing to read beforehand. Showing exactly what will be sent to ${systemName}.`,
        };
      }
      return {
        heading: 'No preview declared',
        note: `No preview declared for this tool — showing exactly what will be sent to ${systemName}.`,
      };

    case 'unavailable':
      if (resp.reason === 'no_connector') {
        return {
          heading: 'Preview not available',
          note: 'Preview not available on this gateway.',
        };
      }
      return {
        heading: 'Preview not available',
        note: resp.message
          ? `Preview not available — ${capMessage(resp.message)}`
          : 'Preview not available.',
      };

    case 'not_found':
      return {
        heading: 'Not found in your system',
        note: resp.message
          ? `Not found in your system — ${capMessage(resp.message)}`
          : 'Not found in your system.',
      };

    case 'ok': {
      const rendered = renderPreviewBody(resp.body, { fields: resp.fields });
      const view: PreviewBoxView = {
        heading: `From ${systemName}, before it runs`,
        note: `Read by the gateway with ${resp.tool} when you opened this card — the AI is not involved.`,
        rendered,
      };
      const version = resp.version;
      if (version) {
        view.versionNote = `You approve ${version.field} ${version.approved}; if it changes, ${systemName} refuses it.`;
        if (version.stale) {
          const diff = diffPreviewBodies(resp.body, version.currentBody, {
            fields: resp.fields,
            excludeKey: version.field,
          });
          view.stale = {
            heading: `A newer ${version.field} exists (${version.current})`,
            approvedLabel: `${capitalize(version.field)} ${version.approved}`,
            currentLabel: `${capitalize(version.field)} ${version.current}`,
            ...(diff.unchanged
              ? { unchangedNote: 'No visible change in the fields.' }
              : { approvedRendered: diff.approved, currentRendered: diff.current }),
          };
        }
      }
      return view;
    }
  }
}

export interface OutcomeBoxView {
  heading: string;
  note: string;
}

/**
 * Only non-null when there is something to say BEYOND the AS's own status —
 * i.e. the connector refused the action after approval, or the record
 * changed underneath it (AU4). `'none'`/`'intent'`/`'done'` return null:
 * nothing here contradicts what the rest of the card already shows.
 */
export function outcomeBoxView(outcome: OutcomeResponse, systemName: string): OutcomeBoxView | null {
  if (outcome.state !== 'failed') return null;
  const detail = outcome.detail ? capMessage(outcome.detail) : undefined;

  if (outcome.outcome === 'changed') {
    return {
      heading: 'Changed since your approval',
      note: `The record changed in ${systemName} since you approved it — nothing was done. Ask the AI to request it again.`,
    };
  }

  return {
    heading: `Refused by ${systemName}`,
    note: `${systemName} refused it${detail ? `: ${detail}` : ''} — nothing was done. Ask the AI to request it again.`,
  };
}
