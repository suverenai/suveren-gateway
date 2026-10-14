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

/** AU10 F3 — the ONE tag string for a resolved link, regardless of whether
 *  it came from an explicit `_source` or a manifest's `sourceFromArg`: an
 *  implicit link is still the AI's own choice of what it's replying to, not
 *  checked, same as an explicit one (contract + mockup case 5). Exported so
 *  the component never hardcodes it a second time. */
export const REQUEST_LINKED_TAG = 'Linked by the AI';

/** AU10 F3 — shown ONLY for an implicit (sourceFromArg) link, additionally
 *  to {@link REQUEST_LINKED_TAG} — explains HOW it was linked without
 *  changing WHO gets credit for it. */
export const REQUEST_IMPLICIT_NOTE = "linked automatically — this action already carried a reference to it";

export interface RequestBlockView {
  state: 'none' | 'unreadable' | 'not_found' | 'ok';
  /** Set for 'none' | 'unreadable' | 'not_found' — the contract's own exact wording. */
  note?: string;
  implicit?: boolean;
  /** AU10 F3 — set ONLY for state 'ok' (a resolved link); the "No request
   *  linked."/unreadable/not_found states show no tag at all. */
  tag?: string;
  /** AU10 F3 — set ONLY alongside `tag` when `implicit` is true. */
  implicitNote?: string;
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
    tag: REQUEST_LINKED_TAG,
    ...(result.implicit ? { implicitNote: REQUEST_IMPLICIT_NOTE } : {}),
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

/** AU10 F2 — shown in EVERY History state, not just 'ok': the reader must
 *  always know who produced this block, even when there's nothing in it
 *  (no customer link, not reachable, nothing recent). Exported so the
 *  component never hardcodes it a second time. */
export const HISTORY_LABEL = 'Read by the gateway — same customer, not matched to this request';

export interface HistoryBlockView {
  state: 'no_customer_link' | 'no_match' | 'unreachable' | 'empty' | 'ok';
  /** AU10 F2 — always set, regardless of state. */
  label: string;
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
    return { state: 'no_customer_link', label: HISTORY_LABEL, note: 'No customer link — nothing to match history against.', matchNotes: [], items: [] };
  }
  if (result.status === 'no_match') {
    return {
      state: 'no_match',
      label: HISTORY_LABEL,
      note: 'No match — no connector here matches on this customer\'s available identity key.',
      matchNotes: [],
      items: [],
    };
  }
  if (result.status === 'unreachable') {
    return {
      state: 'unreachable',
      label: HISTORY_LABEL,
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
    return { state: 'empty', label: HISTORY_LABEL, note: 'Nothing in the last few days.', matchNotes, items: [], unreachableNote };
  }
  return { state: 'ok', label: HISTORY_LABEL, note: '', matchNotes, items, unreachableNote };
}
