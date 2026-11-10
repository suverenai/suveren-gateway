/**
 * Change notice — tells a running chat, on its next tool answer, that the agent brief or the
 * mandates changed since it was told.
 *
 * The gateway hands the AI the brief and the mandate overview once, in the MCP session
 * instructions. A running chat keeps that copy. There is no way to push to it, so the only
 * channel is the answer to whatever the AI calls next (the same one outcome-outbox.ts uses).
 *
 * Two memories, because a chat can outlive its MCP session (measured 2026-11-10, Claude Code
 * 2.1.322 and Codex 0.167 through a logging proxy):
 *  - Per session: what this session was told at start, then by each note. A long chat is
 *    covered by this alone.
 *  - Per app (the client's `clientInfo.name`, persisted): what that app was last told. A gateway
 *    restart makes Codex open a new session inside the same chat, and it keeps the old
 *    instructions; `claude --resume` opens a new session and keeps the old instructions too. Such
 *    a session's own start says nothing changed, so it starts from what the app last heard
 *    instead. The price: a brand-new chat in an app that has not yet heard about a change gets
 *    the note once as well. There is no chat id on the wire, so the two cannot be told apart.
 *
 * Gateway to AI only: a note is appended to the MCP reply after the call has run, outside the
 * gate, so it can never reach a proposal, a ticket or an approval card.
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EnrichedAuthorization } from './shared-state';
import type { IntegrationManager } from './integration-manager';
import { getContextForBrief } from './context-loader';
import { agentVisibleAuthorizations } from './agent-visibility';
import { areaName } from './tool-proxy';

export interface MandateSeen {
  id: string;
  /** The title the person gave it, else the area's name. */
  title: string;
  area: string;
  /** What the mandate allows; a change here (without a new id) is an edit. */
  fingerprint: string;
  expiresAt: number;
}

/** What an AI has been told. */
export interface Told {
  /** Hash of the brief, or '' when there is none. Never the text. */
  brief: string;
  mandates: MandateSeen[];
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The state an AI should have now, for the mandates it may see (same filter as the brief). */
export function currentTold(
  auths: EnrichedAuthorization[],
  im: IntegrationManager | undefined,
  contextDir?: string,
): Told {
  const { brief } = getContextForBrief(contextDir);
  const mandates = agentVisibleAuthorizations(auths, im)
    .filter(a => a.complete)
    .map(a => ({
      id: a.authorizationId,
      title: a.title ?? areaName(a.profileId.replace(/@.*$/, '').split('/').pop() ?? a.profileId),
      area: a.profileId.replace(/@.*$/, ''),
      fingerprint: sha(JSON.stringify([a.bounds ?? a.frame, a.context ?? {}, a.signedCommitmentMode ?? null])),
      expiresAt: Math.min(...a.attestations.map(x => x.expiresAt)),
    }))
    .sort((x, y) => x.id.localeCompare(y.id));
  return { brief: brief ? sha(brief) : '', mandates };
}

/** Same to the AI: no change in the brief, and no mandate added, gone or edited. */
export function sameTold(a: Told, b: Told): boolean {
  if (a.brief !== b.brief || a.mandates.length !== b.mandates.length) return false;
  return a.mandates.every((m, i) => m.id === b.mandates[i].id && m.fingerprint === b.mandates[i].fingerprint);
}

export type SinceWhen = 'chat' | 'app';
const since = (w: SinceWhen): string => (w === 'chat' ? 'since this chat started' : 'since this app last connected');

function quoted(mandates: MandateSeen[]): string {
  return [...new Set(mandates.map(m => `"${m.title}"`))].join(', ');
}

/**
 * The note, or undefined when nothing changed. Facts only, one idea per sentence: the brief is
 * quoted whole because it replaces the copy the AI holds, the mandates are named by the title the
 * person gave so the AI can name them back.
 */
export function changeNote(
  from: Told,
  to: Told,
  when: SinceWhen,
  currentBrief: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | undefined {
  const parts: string[] = [];
  if (from.brief !== to.brief) {
    parts.push(currentBrief
      ? `The agent brief changed ${since(when)}. Call list-authorizations() with no area to read the current one.`
      : `The agent brief was removed ${since(when)}. There is none now.`);
  }

  const before = new Map(from.mandates.map(m => [m.id, m]));
  const after = new Map(to.mandates.map(m => [m.id, m]));
  const added = to.mandates.filter(m => !before.has(m.id));
  const gone = from.mandates.filter(m => !after.has(m.id));
  const edited = to.mandates.filter(m => before.has(m.id) && before.get(m.id)!.fingerprint !== m.fingerprint);
  // Editing a mandate signs a new one and revokes the old under the same title: one edit, not two events.
  for (const g of [...gone]) {
    const replacement = added.find(a => a.title === g.title && a.area === g.area);
    if (replacement) {
      edited.push(replacement);
      added.splice(added.indexOf(replacement), 1);
      gone.splice(gone.indexOf(g), 1);
    }
  }
  const expired = gone.filter(m => m.expiresAt <= nowSeconds);
  const revoked = gone.filter(m => m.expiresAt > nowSeconds);
  const events = [
    added.length > 0 ? `added ${quoted(added)}` : '',
    edited.length > 0 ? `edited ${quoted(edited)}` : '',
    revoked.length > 0 ? `revoked ${quoted(revoked)}` : '',
    expired.length > 0 ? `expired ${quoted(expired)}` : '',
  ].filter(Boolean);
  if (events.length > 0) {
    parts.push(`Mandates changed ${since(when)}: ${events.join('; ')}. For the details call list-authorizations.`);
  }
  return parts.length > 0 ? `[Suveren gateway] ${parts.join('\n\n')}` : undefined;
}

// ─── What each app was last told, across sessions and restarts ───────────────

interface LedgerEntry { told: Told; at: number }
interface LedgerFile { version: 1; apps: Record<string, LedgerEntry> }
interface EncryptedBlob { iv: string; ciphertext: string; tag: string }

/** Kept per app name, so a hostile or buggy client cannot grow this without bound. */
const MAX_APPS = 32;
const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

/** Plaintext before the vault key arrives, AES-256-GCM after (mandate titles are the person's words). */
export class ChangeLedger {
  private apps: Record<string, LedgerEntry> = {};
  private vaultKey: Buffer | null = null;
  private baseDir: string;

  constructor(filePath?: string) {
    this.baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.loadPlaintext();
  }

  setVaultKey(key: Buffer): void {
    this.vaultKey = key;
    if (existsSync(this.encPath)) {
      this.loadEncrypted();
    } else if (Object.keys(this.apps).length > 0) {
      this.persist();
      if (existsSync(this.plainPath)) { try { unlinkSync(this.plainPath); } catch { /* ignore */ } }
    }
  }

  lastTold(app: string): Told | undefined {
    return this.apps[app]?.told;
  }

  record(app: string, told: Told): void {
    const prev = this.apps[app]?.told;
    this.apps[app] = { told, at: Date.now() };
    const names = Object.keys(this.apps);
    if (names.length > MAX_APPS) {
      const oldest = names.reduce((x, y) => (this.apps[x].at <= this.apps[y].at ? x : y));
      delete this.apps[oldest];
    }
    if (!prev || !sameTold(prev, told)) this.persist();
  }

  private get plainPath(): string { return join(this.baseDir, 'change-ledger.json'); }
  private get encPath(): string { return join(this.baseDir, 'change-ledger.enc.json'); }

  private loadPlaintext(): void {
    if (!existsSync(this.plainPath)) return;
    try { this.apps = (JSON.parse(readFileSync(this.plainPath, 'utf-8')) as LedgerFile).apps ?? {}; } catch { this.apps = {}; }
  }

  private loadEncrypted(): void {
    try {
      const blob = (JSON.parse(readFileSync(this.encPath, 'utf-8')) as { blob: EncryptedBlob }).blob;
      const d = createDecipheriv('aes-256-gcm', this.vaultKey!, Buffer.from(blob.iv, 'hex'));
      d.setAuthTag(Buffer.from(blob.tag, 'hex'));
      const text = Buffer.concat([d.update(Buffer.from(blob.ciphertext, 'hex')), d.final()]).toString('utf8');
      this.apps = (JSON.parse(text) as LedgerFile).apps ?? {};
    } catch (err) {
      console.error('[ChangeLedger] Could not read the encrypted file, starting fresh:', err);
      this.apps = {};
    }
  }

  private persist(): void {
    const data: LedgerFile = { version: 1, apps: this.apps };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    if (!this.vaultKey) {
      writeFileSync(this.plainPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      return;
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
    const blob: EncryptedBlob = { iv: iv.toString('hex'), ciphertext: enc.toString('hex'), tag: c.getAuthTag().toString('hex') };
    writeFileSync(this.encPath, JSON.stringify({ version: 1, blob }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}

// ─── One MCP session ────────────────────────────────────────────────────────

type ToolResult = { content?: Array<Record<string, unknown>>; [k: string]: unknown };

export interface ChangeNoticeDeps {
  /** What the AI should have now. */
  now: () => Told;
  /** The brief's text, for the note. */
  currentBrief: () => string | null;
  ledger?: Pick<ChangeLedger, 'lastTold' | 'record'>;
  /** The app's own name, known only after `initialize`. */
  appName: () => string | undefined;
}

/**
 * One per MCP session, created next to the instructions it mirrors. `wrap` goes around a tool
 * handler; the note is worked out after the call, so a change the call itself caused counts too.
 */
export class SessionChangeNotice {
  private told: Told;
  private answered = false;
  private when: SinceWhen = 'chat';

  constructor(private deps: ChangeNoticeDeps) {
    this.told = deps.now();
  }

  /** The note this answer should carry, if any; moves what this session has been told. */
  noteForAnswer(): string | undefined {
    const app = this.deps.appName() ?? 'unknown';
    if (!this.answered) {
      this.answered = true;
      const last = this.deps.ledger?.lastTold(app);
      // A new session whose app last heard something else may be an old chat that reconnected.
      if (last && !sameTold(last, this.told)) {
        this.told = last;
        this.when = 'app';
      }
    }
    const now = this.deps.now();
    const note = changeNote(this.told, now, this.when, this.deps.currentBrief());
    this.told = now;
    this.when = 'chat';
    this.deps.ledger?.record(app, now);
    return note;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrap<T extends (...args: any[]) => unknown>(handler: T): T {
    return (async (...args: unknown[]) => {
      const result = (await handler(...args)) as ToolResult | undefined;
      if (!result || !Array.isArray(result.content)) return result;
      const note = this.noteForAnswer();
      if (!note) return result;
      return { ...result, content: [...result.content, { type: 'text' as const, text: note }] };
    }) as unknown as T;
  }
}
