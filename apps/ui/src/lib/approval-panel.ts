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

// ─── Which approvals open the panel, and when: shared with the phone app ───
export {
  INITIAL_PANEL, RESULT_SHOW_MS, SLIDE_MS, afterDecision, neighbour, panelChrome, positionOf,
  reconcilePanel, resolveCurrent, stripAutoLabel,
} from '@suveren/approval-card/lib/approval-panel';
export type { PanelChrome, PanelInput, PanelState } from '@suveren/approval-card/lib/approval-panel';
