/**
 * Core objects — approvals, mandates, tickets (UI spec §12, signed off
 * 2026-10-16). Pure view logic shared by the dashboard, the Approvals page and
 * the Tickets page: the "area · system · time" line every object carries,
 * automatic vs. approved tickets, the "Done automatically" groups and the
 * "Mandates at work today" usage. No fetching here.
 */
import type { AgentProfile } from '@hap/core';
import type { ExecutionReceipt, IntegrationManifest } from './sp-client';
import { splitAction, actionLabel, wasReviewed, windowUsage } from './receipt-summary';
import { systemDisplayName } from './approval-view';
import { profileDisplayName } from './profile-display';

export type TicketFilter = 'automatic' | 'approved' | 'all';

export const TICKET_FILTERS: readonly TicketFilter[] = ['automatic', 'approved', 'all'];

/** `?filter=` value → filter; anything unknown is "all" (never hides tickets). */
export function parseTicketFilter(raw: string | null | undefined): TicketFilter {
  return raw === 'automatic' || raw === 'approved' ? raw : 'all';
}

/**
 * Automatic = no person approved it: the ticket references no proposal.
 * Approved = it executed an approved proposal (`proposalId` set).
 */
export function matchesTicketFilter(r: ExecutionReceipt, f: TicketFilter): boolean {
  if (f === 'all') return true;
  return f === 'approved' ? wasReviewed(r) : !wasReviewed(r);
}

/** Area = the mandate's title when it has one, else the profile's name. */
export function areaName(
  authorizationId: string | undefined,
  profileId: string,
  titles: Record<string, string>,
): string {
  const t = authorizationId ? titles[authorizationId] : undefined;
  return t && t.trim() ? t : profileDisplayName(profileId);
}

/** System = the connector's display name, from the `<integration>__<tool>` name. */
export function systemName(namespacedTool: string, manifests: IntegrationManifest[] | undefined): string {
  return systemDisplayName(splitAction(namespacedTool).integrationId, manifests);
}

/** "5 min" / "2 h" / "3 days" — how long something has existed. */
export function ageLabel(sinceMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** "waiting 5 min" — an approval shows how long it has waited (UI spec §12.2). */
export function waitingLabel(createdAtSec: number, nowMs: number): string {
  const age = ageLabel(createdAtSec * 1000, nowMs);
  return age === 'just now' ? 'waiting just now' : `waiting ${age}`;
}

const DEADLINE_WINDOW_SEC = 24 * 3600;

/**
 * The deadline line — only inside the last 24 hours (UI spec §12.2). The
 * window itself is the Authority Server's (72 h, or the mandate's end);
 * the UI only words it. `null` outside the window or once expired.
 */
export function deadlineLabel(expiresAtSec: number, nowMs: number, locale?: string): string | null {
  const left = expiresAtSec - Math.floor(nowMs / 1000);
  if (left <= 0 || left > DEADLINE_WINDOW_SEC) return null;
  const when = new Date(expiresAtSec * 1000).toLocaleString(locale, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return `Decide by ${when} — otherwise it won't run`;
}

/** Tickets carry no separate number — the short id stands in for one (§12.2). */
export function shortTicketId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(timestampSec: number, nowMs: number): boolean {
  return sameLocalDay(timestampSec * 1000, nowMs);
}

/** A ticket is new when it was issued after the last visit to Tickets. */
export function isNewTicket(r: ExecutionReceipt, lastSeenMs: number): boolean {
  return r.timestamp * 1000 > lastSeenMs;
}

export interface AutomaticGroup {
  key: string;
  area: string;
  system: string;
  profileId: string;
  /** The manifest's past-tense action label, e.g. "Contact created". */
  label: string;
  count: number;
  newCount: number;
  latestSec: number;
  /** Newest first. */
  tickets: ExecutionReceipt[];
}

/**
 * "Done automatically" (UI spec §12.4): automatic tickets grouped per mandate
 * and action. Groups with something new come first, then the most recent.
 */
export function groupAutomatic(
  receipts: ExecutionReceipt[],
  opts: { titles: Record<string, string>; manifests: IntegrationManifest[]; lastSeenMs: number },
): AutomaticGroup[] {
  const groups = new Map<string, AutomaticGroup>();
  for (const r of receipts) {
    if (wasReviewed(r)) continue;
    const label = actionLabel(r, opts.manifests);
    const owner = r.authorizationId ?? r.profileId;
    const key = `${owner}|${r.action}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        area: areaName(r.authorizationId, r.profileId, opts.titles),
        system: systemName(r.action, opts.manifests),
        profileId: r.profileId,
        label,
        count: 0,
        newCount: 0,
        latestSec: 0,
        tickets: [],
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (isNewTicket(r, opts.lastSeenMs)) g.newCount += 1;
    g.latestSec = Math.max(g.latestSec, r.timestamp);
    g.tickets.push(r);
  }
  const out = [...groups.values()];
  for (const g of out) g.tickets.sort((a, b) => b.timestamp - a.timestamp);
  return out.sort((a, b) => (Number(b.newCount > 0) - Number(a.newCount > 0)) || b.latestSec - a.latestSec);
}

export interface MandateAtWork {
  authorizationId: string;
  area: string;
  system: string;
  profileId: string;
  /** Today's usage as of the latest ticket: against a declared limit, or a plain count. */
  used: number;
  limit?: number;
  /** used / limit, 0 when there is no limit. */
  ratio: number;
}

/**
 * "Mandates at work today" (UI spec §12.4): every mandate with at least one
 * ticket today, its daily usage read from the newest of those tickets (the
 * Authority Server's cumulative state after that call), closest to a limit
 * first.
 */
export function mandatesAtWork(
  receipts: ExecutionReceipt[],
  opts: {
    nowMs: number;
    titles: Record<string, string>;
    manifests: IntegrationManifest[];
    boundsOf: (authorizationId: string) => Record<string, string | number> | undefined;
    profileOf: (profileId: string) => AgentProfile | null | undefined;
  },
): MandateAtWork[] {
  const newest = new Map<string, ExecutionReceipt>();
  for (const r of receipts) {
    if (!r.authorizationId || !isToday(r.timestamp, opts.nowMs)) continue;
    const cur = newest.get(r.authorizationId);
    // Tickets issued within the same second tie on timestamp; the AS's
    // running count only grows, so it breaks the tie.
    const later = !cur || r.timestamp > cur.timestamp
      || (r.timestamp === cur.timestamp && (r.cumulativeState?.daily?.count ?? 0) > (cur.cumulativeState?.daily?.count ?? 0));
    if (later) newest.set(r.authorizationId, r);
  }
  const out: MandateAtWork[] = [];
  for (const [authorizationId, r] of newest) {
    const u = windowUsage(r, opts.boundsOf(authorizationId) ?? r.limits, opts.profileOf(r.profileId), 'daily');
    const base = {
      authorizationId,
      area: areaName(authorizationId, r.profileId, opts.titles),
      system: systemName(r.action, opts.manifests),
      profileId: r.profileId,
    };
    if (u && 'limit' in u) {
      out.push({ ...base, used: u.used, limit: u.limit, ratio: u.limit > 0 ? u.used / u.limit : 0 });
    } else {
      out.push({ ...base, used: u ? u.count : 1, ratio: 0 });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio || a.area.localeCompare(b.area));
}

/** Bold at ≥ 80 % of a limit (UI spec §12.2). */
export function nearLimit(m: Pick<MandateAtWork, 'ratio'>): boolean {
  return m.ratio >= 0.8;
}

/** "today 09:12" / "16 Oct, 09:12" — a ticket's time on its top line and stub. */
export function ticketTime(timestampSec: number, nowMs: number, locale?: string): string {
  const d = new Date(timestampSec * 1000);
  const hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (isToday(timestampSec, nowMs)) return `today ${hm}`;
  return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}, ${hm}`;
}
