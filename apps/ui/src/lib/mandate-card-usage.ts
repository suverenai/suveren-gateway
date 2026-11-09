/**
 * What an opened mandate card (UI spec §18.2) says about use: "N used today"
 * beside a limit, and "Tickets under this mandate". Both are read from the
 * tickets this account already has (the same newest-200 read the approval
 * card's "Covered by" uses) — nothing is estimated. When that read cannot
 * prove the answer (the page is full and still reaches back into today), no
 * figure is shown rather than a guess.
 */
import { useEffect, useState } from 'react';
import type { AgentProfile } from '@hap/core';
import { spClient, type ExecutionReceipt } from './sp-client';
import { isToday } from './core-objects';
import { chooseCumulativeBound } from './receipt-summary';

export const RECEIPT_PAGE = 200;

export interface MandateReceipts {
  receipts: ExecutionReceipt[];
  /** True when the read provably covers all of today (page not full, or it reaches before today). */
  coversToday: boolean;
}

export type MandateReceiptsState =
  | { state: 'loading' }
  | { state: 'failed' }
  | ({ state: 'ok' } & MandateReceipts);

export function coversToday(receipts: ExecutionReceipt[], nowMs: number, pageSize = RECEIPT_PAGE): boolean {
  if (receipts.length < pageSize) return true;
  return receipts.some((r) => !isToday(r.timestamp, nowMs));
}

/** Newest first. */
export function ticketsUnder(receipts: ExecutionReceipt[], authorizationId: string): ExecutionReceipt[] {
  return receipts.filter((r) => r.authorizationId === authorizationId).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * The Authority Server's running figure per limit key, as numbers: the newest
 * ticket today carries it for the bound that governs it; a daily cumulative
 * bound with no ticket today and a complete read is 0.
 */
export function usedTodayNumbers(opts: {
  receipts: ExecutionReceipt[];
  coversToday: boolean;
  authorizationId: string;
  bounds: Record<string, string | number> | undefined;
  profile: AgentProfile | null | undefined;
  nowMs: number;
}): Record<string, number> {
  const out: Record<string, number> = {};
  const { bounds, profile, authorizationId, nowMs } = opts;
  if (!bounds) return out;
  const today = ticketsUnder(opts.receipts, authorizationId).filter((r) => isToday(r.timestamp, nowMs));
  const newest = today.reduce<ExecutionReceipt | null>((best, r) => {
    if (!best || r.timestamp > best.timestamp) return r;
    if (r.timestamp === best.timestamp && (r.cumulativeState?.daily?.count ?? 0) > (best.cumulativeState?.daily?.count ?? 0)) return r;
    return best;
  }, null);
  if (newest) {
    const chosen = chooseCumulativeBound(newest, bounds, profile, 'daily');
    const state = newest.cumulativeState?.daily;
    if (chosen && state) out[chosen.key] = chosen.isAmount ? state.amount : state.count;
    return out;
  }
  if (!opts.coversToday) return out;
  for (const [key, def] of Object.entries(profile?.boundsSchema?.fields ?? {})) {
    const bt = def.boundType;
    if (key in bounds && bt && (bt.kind === 'cumulative_sum' || bt.kind === 'cumulative_count') && bt.window === 'daily') {
      out[key] = 0;
    }
  }
  return out;
}

/** "N used today" per limit key (mandate card rows). */
export function usedToday(opts: Parameters<typeof usedTodayNumbers>[0]): Record<string, string> {
  return Object.fromEntries(Object.entries(usedTodayNumbers(opts)).map(([k, n]) => [k, `${n} used today`]));
}

/**
 * The same running figure for a mandate that does not exist yet (the form):
 * the newest ticket today under ANY mandate of this profile that a bound of
 * this key governs. A daily bound with no such ticket and a complete read is
 * 0; anything the read cannot prove is left out.
 */
export function usedTodayForBound(opts: {
  receipts: ExecutionReceipt[];
  coversToday: boolean;
  profileId: string;
  key: string;
  profile: AgentProfile | null | undefined;
  nowMs: number;
}): number | undefined {
  const def = (opts.profile?.boundsSchema?.fields ?? {})[opts.key];
  const bt = def?.boundType;
  if (!def || !bt || (bt.kind !== 'cumulative_sum' && bt.kind !== 'cumulative_count') || bt.window !== 'daily') return undefined;
  const family = (id: string) => id.replace(/@.*$/, '').split('/').pop();
  const governs = def.appliesTo;
  let newest: ExecutionReceipt | null = null;
  for (const r of opts.receipts) {
    if (family(r.profileId) !== family(opts.profileId) || !isToday(r.timestamp, opts.nowMs)) continue;
    const at = r.actionType ?? (typeof r.executionContext?.action_type === 'string' ? (r.executionContext.action_type as string) : undefined);
    if (governs && at && !governs.includes(at)) continue;
    if (!newest || r.timestamp > newest.timestamp
      || (r.timestamp === newest.timestamp && (r.cumulativeState?.daily?.count ?? 0) > (newest.cumulativeState?.daily?.count ?? 0))) newest = r;
  }
  if (newest) {
    const state = newest.cumulativeState?.daily;
    return state ? (bt.kind === 'cumulative_sum' ? state.amount : state.count) : undefined;
  }
  return opts.coversToday ? 0 : undefined;
}

const TTL_MS = 15_000;
let cache: { at: number; p: Promise<MandateReceipts> } | null = null;

function load(): Promise<MandateReceipts> {
  const now = Date.now();
  if (!cache || now - cache.at > TTL_MS) {
    const entry = {
      at: now,
      p: spClient.getMyReceiptsPage({ limit: RECEIPT_PAGE }).then((page) => ({
        receipts: page.receipts,
        coversToday: coversToday(page.receipts, Date.now()),
      })),
    };
    // A failed read is never kept — the next card tries again.
    entry.p.catch(() => { if (cache === entry) cache = null; });
    cache = entry;
  }
  return cache.p;
}

/** The account's newest tickets, read once per few seconds for every opened mandate. */
export function useMandateReceipts(): MandateReceiptsState {
  const [res, setRes] = useState<MandateReceiptsState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(
      (r) => { if (live) setRes({ state: 'ok', ...r }); },
      () => { if (live) setRes({ state: 'failed' }); },
    );
    return () => { live = false; };
  }, []);
  return res;
}
