/**
 * AU10 — pure view-model builders for the Request + History blocks
 * (doc/au10-request-context.md §3; mockup temp/au10-mockup/index.html). The
 * component (RequestContextBox.tsx) only renders what these functions
 * return — it never branches on `RequestResult`/`HistoryResult` itself,
 * same split as approval-preview-view.ts for AU8.
 *
 * Labels/wording here follow the contract's own exact strings where it
 * specifies them ("No request linked", "Request: link not readable
 * (<reason>)", "Written by the AI via Suveren, <time> — not checked", etc.)
 * — an e2e test asserts substrings of these, not a rendered layout.
 */
import type {
  RequestResult,
  HistoryResult,
  HistoryItem,
  ConnectorHistoryMatch,
} from './sp-client';

const BODY_PREVIEW_LINES = 6;

function formatTime(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function splitBodyPreview(body: string | undefined): { first: string; more?: string } {
  if (!body) return { first: '' };
  const lines = body.split('\n');
  if (lines.length <= BODY_PREVIEW_LINES) return { first: body };
  return { first: lines.slice(0, BODY_PREVIEW_LINES).join('\n'), more: lines.slice(BODY_PREVIEW_LINES).join('\n') };
}

export interface RequestChainItemView {
  author?: string;
  at?: string;
  title?: string;
  body?: string;
}

export interface RequestBlockView {
  state: 'none' | 'unreadable' | 'not_found' | 'ok';
  /** Set for 'none' | 'unreadable' | 'not_found' — the contract's own exact wording. */
  note?: string;
  implicit?: boolean;
  metaLine?: string;
  title?: string;
  bodyFirst?: string;
  bodyMore?: string;
  attribution?: string;
  chain: RequestChainItemView[];
}

/** doc §3 — Request block states: none ("No request linked"), not readable
 *  (reason), not found ("no longer exists"). */
export function requestBlockView(result: RequestResult): RequestBlockView {
  if (result.status === 'none') {
    return { state: 'none', note: 'No request linked.', chain: [] };
  }
  if (result.status === 'unreadable') {
    return { state: 'unreadable', note: `Request: link not readable (${result.reason}).`, chain: [] };
  }
  if (result.status === 'not_found') {
    return { state: 'not_found', note: 'Request: this message no longer exists.', chain: [] };
  }
  const { first, more } = splitBodyPreview(result.body);
  const metaParts = [result.connector, result.kind, result.author ? `from ${result.author}` : undefined, formatTime(result.at)]
    .filter((v): v is string => Boolean(v));
  return {
    state: 'ok',
    implicit: result.implicit,
    metaLine: metaParts.join(' · '),
    title: result.title,
    bodyFirst: first,
    bodyMore: more,
    attribution: result.author ? `— from ${result.author}, not checked` : undefined,
    chain: result.chain.map((c) => ({ ...c, at: formatTime(c.at) })),
  };
}

export interface HistoryItemView {
  headLabel: string;
  at?: string;
  title?: string;
  body?: string;
  attribution: string;
  aiWritten: boolean;
}

export interface HistoryBlockView {
  state: 'no_customer_link' | 'no_match' | 'unreachable' | 'empty' | 'ok';
  note: string;
  /** doc §2 — "The card states the match" (per connector that matched). */
  matchNotes: string[];
  items: HistoryItemView[];
  unreachableNote?: string;
}

function matchNoteFor(match: ConnectorHistoryMatch): string {
  const kindLabel = match.matchedKeyType === 'email_domain' ? 'matched by email domain' : 'matched by email';
  return `Latest entries for ${match.matchedKeyValue} (${kindLabel})`;
}

function itemView(item: HistoryItem): HistoryItemView {
  const aiWritten = Boolean(item.aiWritten);
  const label = aiWritten ? 'Activity' : (item.type ?? item.kind ?? 'Entry');
  let attribution: string;
  if (aiWritten) {
    const at = item.aiWritten?.at !== undefined ? formatTime(new Date(item.aiWritten.at).toISOString()) : undefined;
    attribution = at
      ? `— Written by the AI via Suveren, ${at} — not checked`
      : '— Written by the AI via Suveren — not checked';
  } else {
    attribution = item.author ? `— from ${item.author}, not checked` : '— not checked';
  }
  return {
    headLabel: label,
    at: formatTime(item.at),
    title: item.title,
    body: item.body,
    attribution,
    aiWritten,
  };
}

/** doc §3 — History block states: no key ("no customer link"), connector
 *  not reachable, nothing in the last N days. */
export function historyBlockView(result: HistoryResult): HistoryBlockView {
  if (result.status === 'no_customer_link') {
    return { state: 'no_customer_link', note: 'No customer link — nothing to match history against.', matchNotes: [], items: [] };
  }
  if (result.status === 'no_match') {
    return {
      state: 'no_match',
      note: 'No match — no connector here matches on this customer\'s available identity key.',
      matchNotes: [],
      items: [],
    };
  }
  if (result.status === 'unreachable') {
    return {
      state: 'unreachable',
      note: `${result.connectorIds.join(', ')} not reachable — history could not be read.`,
      matchNotes: [],
      items: [],
    };
  }
  const items = result.matches
    .flatMap((m) => m.items.map((it) => ({ it, m })))
    .sort((a, b) => (Date.parse(b.it.at ?? '') || 0) - (Date.parse(a.it.at ?? '') || 0))
    .map(({ it }) => itemView(it));
  const matchNotes = result.matches.map(matchNoteFor);
  const unreachableNote = result.unreachableConnectorIds.length > 0
    ? `${result.unreachableConnectorIds.join(', ')} not reachable — showing what could be read.`
    : undefined;
  if (items.length === 0) {
    return { state: 'empty', note: 'Nothing in the last few days.', matchNotes, items: [], unreachableNote };
  }
  return { state: 'ok', note: '', matchNotes, items, unreachableNote };
}
