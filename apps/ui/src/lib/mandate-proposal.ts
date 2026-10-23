/**
 * The setup / create_mandate approval card (UI spec §17.3, mandate proposals):
 * which parts of the gateway's `describe_mandate_proposal` preview move out of
 * the sealed tile — the intent and the mode get their own prominent blocks, the
 * proposal's own bookkeeping (proposal, profile version, workspace) goes to
 * "Technical details", the delegation checks to "Proposed through". Driven by
 * the preview's field names only; no per-profile code.
 */
import { COMMITMENT_LABEL, COMMITMENT_REVIEW, COMMITMENT_AUTOMATIC } from './commitment-words';

export const CREATE_MANDATE_TOOL = 'setup__create_mandate';

/** Preview fields that leave the tile (each has another place on the card). */
export const MANDATE_TILE_OMIT = ['proposal', 'profile_version', 'workspace', 'mode', 'intent', 'checks'] as const;

export interface ModeView { label: string; title: string; text: string }

/** The commitment block, in the words of the manual mandate screen (lib/commitment-words.ts). */
export function modeView(mode: unknown): ModeView | null {
  if (typeof mode !== 'string' || !mode.trim()) return null;
  switch (mode.trim()) {
    case 'review':
      return { label: COMMITMENT_LABEL, ...COMMITMENT_REVIEW };
    case 'automatic':
      return { label: COMMITMENT_LABEL, ...COMMITMENT_AUTOMATIC };
    default:
      return { label: COMMITMENT_LABEL, title: mode.trim(), text: '' };
  }
}

export interface MandatePreviewParts {
  intent?: string;
  mode?: string;
  proposal?: string;
  profileVersion?: string;
  workspace?: string;
  checks: string[];
}

/** The parts the card pulls out of a resolved preview's structured body. */
export function mandatePreviewParts(structured: Record<string, unknown> | undefined): MandatePreviewParts {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    intent: str(structured?.intent),
    mode: str(structured?.mode),
    proposal: str(structured?.proposal),
    profileVersion: str(structured?.profile_version),
    workspace: str(structured?.workspace),
    checks: Array.isArray(structured?.checks) ? (structured!.checks as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [],
  };
}

/** The one-line "Technical details" summary: "sales 0.4 · Weninger Translations · new mandate". */
export function mandateTechnicalLine(p: MandatePreviewParts): string {
  return [p.profileVersion, p.workspace, 'new mandate'].filter(Boolean).join(' · ');
}

/** The mandate proposal's title parts: the area, and the AI-proposed name (amber on the card). */
export function mandateTitleParts(areaName: string, args: object | null | undefined): { area: string; name: string | null } {
  const t = (args as Record<string, unknown> | null | undefined)?.title;
  return { area: areaName, name: typeof t === 'string' && t.trim() ? t.trim() : null };
}

/** Plain-text form: "Sales · Quotes to customers", or "Sales · new mandate" without a name. */
export function mandateTitleText(areaName: string, args: object | null | undefined): string {
  const p = mandateTitleParts(areaName, args);
  return `${p.area} · ${p.name ?? 'new mandate'}`;
}

/** The area a mandate proposal is about: the profile it targets, else the profile it rides on. */
export function mandateTargetProfile(args: object | null | undefined, fallbackProfileId: string): string {
  const t = (args as Record<string, unknown> | null | undefined)?.profile;
  return typeof t === 'string' && t ? t : fallbackProfileId;
}
