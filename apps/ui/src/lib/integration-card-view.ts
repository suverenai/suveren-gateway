/**
 * What a connector card says about itself (UI spec §20.3) — the status word in
 * the type line, the one quiet line under the title, and whether the card starts
 * open. Pure, so the wording is unit-tested; the JSX only places it.
 *
 * No colour: a status is a word, told apart by weight (bold = something is
 * running or needs a look, muted = nothing is happening), never by a pill.
 */

export type CardState = 'unconfigured' | 'needs-oauth' | 'ready' | 'running' | 'starting';

export interface StatusWord {
  text: string;
  /** `bold` = running / crashed / failed; `muted` = not set up, stopped, paused, starting. */
  tone: 'bold' | 'muted';
}

/** The process status word. `stopped` is the registered-but-down chip text (Paused / Crashed / Stopped). */
export function statusWord(cardState: CardState, stopped: { t: string }): StatusWord {
  if (cardState === 'running') return { text: 'Running', tone: 'bold' };
  if (cardState === 'starting') return { text: 'Starting', tone: 'muted' };
  if (cardState === 'unconfigured' || cardState === 'needs-oauth') return { text: 'Not set up', tone: 'muted' };
  return { text: stopped.t, tone: stopped.t === 'Crashed' ? 'bold' : 'muted' };
}

/** The auth note in the type line, or null when the status word already says it (not set up). */
export function authWord(a: { needsAuth: boolean; authFailed: boolean; authConnected: boolean }): StatusWord | null {
  if (!a.needsAuth) return { text: 'No auth', tone: 'muted' };
  if (a.authFailed) return { text: 'Auth failed', tone: 'bold' };
  if (a.authConnected) return { text: 'Auth OK', tone: 'muted' };
  return null;
}

/** A card starts open only when it needs a look: auth failed, half set up (connect your
 *  account), or ready but not running (Activate). Running, starting and simply not set up
 *  (optional — nothing started yet) start closed, so the page stays short. */
export function startsOpen(cardState: CardState, authFailed: boolean): boolean {
  if (authFailed) return true;
  return cardState === 'needs-oauth' || cardState === 'ready';
}

export function readsPhrase(readAge: number | null | undefined, label: (days: number | null) => string): string | null {
  if (readAge === undefined) return null;
  if (readAge === null) return 'reads follow your mandate';
  return readAge === 0 ? 'reads nothing' : `reads ${label(readAge).toLowerCase()}`;
}

export interface OneLineInput {
  cardState: CardState;
  authFailed: boolean;
  /** The manifest's note for the current mode, e.g. "On this computer — no shared access". */
  modeNote?: string;
  /** Labels of the required credential fields, in order. */
  requiredLabels: string[];
  oauth: boolean;
  /** The manifest declares no credential fields at all. */
  noFields: boolean;
  setupHint?: string;
  /** Wording for the read window, or null when the connector has none / it is not loaded. */
  reads: string | null;
  /** Registered but down: paused by simulation mode, or crashed (an error) — else plainly stopped. */
  stopped: 'paused' | 'crashed' | 'stopped';
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The one quiet line under the title. Avoids the word "running" (the status word is the only place it appears). */
export function connectorOneLine(i: OneLineInput): string {
  if (i.authFailed) return 'The stored credentials stopped working — reconnect to use it again';
  switch (i.cardState) {
    case 'running': {
      const parts = [i.modeNote?.replace(/\.$/, ''), i.reads].filter(Boolean) as string[];
      if (parts.length) return parts.join(' · ');
      return i.noFields ? 'Nothing to set up' : 'Credentials on file';
    }
    case 'starting':
      return 'Starting…';
    case 'needs-oauth':
      return 'Credentials saved — connect your account';
    case 'unconfigured': {
      if (i.requiredLabels.length === 0) return i.setupHint ?? i.modeNote ?? 'Works out of the box — activate it to start';
      const needs = `Needs ${joinWords(i.requiredLabels)}`;
      return i.oauth ? `${needs}, then connect your account` : needs;
    }
    case 'ready':
      if (i.stopped === 'paused') return 'Paused while simulation mode is on';
      if (i.stopped === 'crashed') return 'Stopped with an error';
      return 'Credentials saved — start it to use it';
  }
}
