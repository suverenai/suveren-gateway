/**
 * The setup / create_mandate approval card (UI spec §17.3, mandate proposals):
 * which parts of the gateway's `describe_mandate_proposal` preview move out of
 * the sealed tile — the intent and the mode get their own prominent blocks, the
 * proposal's own bookkeeping (proposal, profile version, workspace) goes to
 * "Technical details", the delegation checks to "Proposed through". Driven by
 * the preview's field names only; no per-profile code.
 */
export const CREATE_MANDATE_TOOL = 'setup__create_mandate';

/** Preview fields that leave the tile (each has another place on the card). */
export const MANDATE_TILE_OMIT = ['proposal', 'profile_version', 'workspace', 'mode', 'intent', 'checks'] as const;

export interface ModeView { title: string; text: string; mark: string }

/** "Asks you each time" (review) / "Runs automatically within these limits" (automatic). */
export function modeView(mode: unknown): ModeView | null {
  if (typeof mode !== 'string' || !mode.trim()) return null;
  switch (mode.trim()) {
    case 'review':
      return { title: 'Asks you each time', text: 'Every action under this mandate waits here for your approval before it runs.', mark: '?' };
    case 'automatic':
      return { title: 'Runs automatically within these limits', text: 'Actions inside the limits run without asking you; anything beyond them is refused.', mark: '→' };
    default:
      return { title: mode.trim(), text: 'How actions under this mandate are decided.', mark: '?' };
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

/** "New mandate · Sales" — built from the proposal's own area, never AI text. */
export function mandateTitle(areaName: string): string {
  return `New mandate · ${areaName}`;
}
