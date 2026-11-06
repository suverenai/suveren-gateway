/**
 * The approval panel that opens by itself — the pure rules. No React, no DOM,
 * no fetching; the host component feeds these functions and renders the answer.
 *
 * Words used here:
 *   - "For me": the approvals waiting for THIS person (lib/approval-queue.ts).
 *   - "typing": the person is in a form or dialog right now. Nothing slides over it.
 *   - "owed": an approval arrived while the person was typing; the panel opens
 *     the moment they are done.
 */
import type { GatewaySettings } from './sp-client';
import { nextAfter } from './approval-flow';

// ─── Setting: "Open approvals by themselves" (stored in the gateway, never the browser) ───

export interface SettingsClient {
  getGatewaySettings(): Promise<GatewaySettings>;
  setGatewaySettings(patch: Partial<GatewaySettings>): Promise<GatewaySettings>;
}

/** What the gateway holds. null = it could not be read — never guessed. */
export async function loadAutoOpen(client: SettingsClient): Promise<boolean | null> {
  try {
    const s = await client.getGatewaySettings();
    return typeof s.openApprovalsAutomatically === 'boolean' ? s.openApprovalsAutomatically : null;
  } catch {
    return null;
  }
}

/** Writes the setting and returns what the gateway PERSISTED (not what was asked). Throws when the write fails. */
export async function saveAutoOpen(client: SettingsClient, value: boolean): Promise<boolean> {
  const saved = await client.setGatewaySettings({ openApprovalsAutomatically: value });
  if (typeof saved.openApprovalsAutomatically !== 'boolean') throw new Error('The gateway did not confirm the setting');
  return saved.openApprovalsAutomatically;
}

// ─── Is the person in the middle of a form? ───

export interface FormSignals {
  /** A dialog / modal is open. */
  modalOpen: boolean;
  /** The keyboard focus is in a text field, text area, select or editable region (outside the approval panel itself). */
  fieldFocused: boolean;
  /** The page is a multi-step form (the new-mandate wizard). */
  wizardRoute: boolean;
}

export function isFormInProgress(s: FormSignals): boolean {
  return s.modalOpen || s.fieldFocused || s.wizardRoute;
}

export function isWizardRoute(pathname: string): boolean {
  return pathname === '/mandates/new' || pathname.startsWith('/mandates/new/');
}

// 'search': a search box is not work in progress — nothing is lost when it loses focus (2026-11-06).
const NON_TEXT_INPUT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'search']);
/** Does focus on this element mean "the person is typing"? */
export function isTypingTarget(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT.has((el.type ?? 'text').toLowerCase());
  return !!el.isContentEditable;
}

// ─── Which approvals open the panel, and when ───

export interface PanelState {
  open: boolean;
  /** Ids the person has already been shown (or had the chance to be). A new id is an arrival. */
  knownIds: string[];
  /** An arrival was held back because the person was typing. */
  owed: boolean;
}
export const INITIAL_PANEL: PanelState = { open: false, knownIds: [], owed: false };

export interface PanelInput {
  /** The "For me" queue, oldest first. */
  ids: string[];
  /** The queue and the setting have answered. Before that, nothing happens. */
  loaded: boolean;
  /** The gateway's setting; null = unknown, which never opens anything by itself. */
  autoOpen: boolean | null;
  typing: boolean;
  /** The Approvals page itself is showing the queue — the panel would only repeat it. */
  onApprovalsPage: boolean;
  /** A decision's result is still on screen in the panel — do not close it under the person. */
  hold: boolean;
}

/** Called whenever an input changes; returns the next state. */
export function reconcilePanel(prev: PanelState, input: PanelInput): PanelState {
  if (!input.loaded) return prev;
  const { ids } = input;
  if (input.onApprovalsPage) {
    // The page lists them: seen — nothing slides in by itself here, and leaving the page later does not make
    // them arrivals. A panel the person opened (by clicking a row) stays as it is.
    if (ids.length === 0 && !input.hold) return { open: false, knownIds: [], owed: false };
    return { open: prev.open, knownIds: ids, owed: false };
  }
  if (ids.length === 0) {
    return input.hold ? { ...prev, knownIds: [], owed: false } : { open: false, knownIds: [], owed: false };
  }
  const known = new Set(prev.knownIds);
  const arrival = ids.some((id) => !known.has(id));
  let { open, owed } = prev;
  if (input.autoOpen !== true) {
    owed = false;
  } else if (arrival || owed) {
    if (input.typing) owed = true;
    else { open = true; owed = false; }
  }
  return { open, knownIds: ids, owed };
}

/** Which of panel / "N approvals waiting — Open" bar / edge strip is on screen. */
export interface PanelChrome { panel: boolean; bar: boolean; strip: boolean }

export function panelChrome(args: { count: number; open: boolean; typing: boolean; onApprovalsPage: boolean; hold: boolean }): PanelChrome {
  const { count, open, typing, onApprovalsPage, hold } = args;
  if (count === 0 && !hold) return { panel: false, bar: false, strip: false };
  // On the Approvals page the list is the page: no strip or bar, but the panel shows once a row was clicked.
  if (onApprovalsPage) return { panel: open, bar: false, strip: false };
  // The bar and the strip only exist for approvals that still wait; the last result alone (hold) keeps just the panel.
  return { panel: open, bar: count > 0 && typing && !open, strip: count > 0 && !open && !typing };
}

// ─── Moving between the waiting approvals ───

/** The id to show: the current one if it is still waiting, else the first. null when nothing waits. */
export function resolveCurrent(ids: readonly string[], currentId: string | null): string | null {
  if (currentId && ids.includes(currentId)) return currentId;
  return ids[0] ?? null;
}

/** "1 of N" (1-based). */
export function positionOf(ids: readonly string[], currentId: string | null): { index: number; total: number } | null {
  if (!currentId) return null;
  const at = ids.indexOf(currentId);
  return at < 0 ? null : { index: at + 1, total: ids.length };
}

/** Previous / Next. null at either end. */
export function neighbour(ids: readonly string[], currentId: string | null, step: -1 | 1): string | null {
  if (!currentId) return null;
  const at = ids.indexOf(currentId);
  if (at < 0) return null;
  return ids[at + step] ?? null;
}

/**
 * After the gateway answered a decision: what the panel does once the result has been shown.
 * `next` = open that approval; null = nothing is left, the panel slides out completely.
 */
export function afterDecision(idsBefore: readonly string[], decidedId: string): { next: string | null } {
  return { next: nextAfter(idsBefore, decidedId) };
}

/** How long the result (Approved / Rejected) stays on the card before the next one opens. */
export const RESULT_SHOW_MS = 1500;
/** The slide takes this long; content stays mounted until it has gone. */
export const SLIDE_MS = 380;

/** The word under the strip's count: "Auto off" when new approvals do not open by themselves. */
export function stripAutoLabel(autoOpen: boolean | null): string {
  return autoOpen === true ? '' : 'Auto off';
}
