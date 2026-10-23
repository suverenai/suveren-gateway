/**
 * "Covered by" on the approval card (UI spec §17.3): the mandate's usage so
 * far today, read from the newest ticket the mandate issued today — the
 * Authority Server's own running count (the same read the dashboard's
 * "mandates at work" uses). Nothing is estimated: no ticket today → "none yet today".
 */
import { useEffect, useState } from 'react';
import type { AgentProfile } from '@hap/core';
import { spClient, type ExecutionReceipt } from './sp-client';
import { isToday } from './core-objects';
import { windowUsage } from './receipt-summary';

const TTL_MS = 15_000;
let cache: { at: number; p: Promise<ExecutionReceipt[]> } | null = null;

function recentTickets(): Promise<ExecutionReceipt[]> {
  const now = Date.now();
  if (!cache || now - cache.at > TTL_MS) {
    cache = {
      at: now,
      p: spClient.getMyReceiptsPage({ limit: 200 }).then((page) => page.receipts).catch(() => [] as ExecutionReceipt[]),
    };
  }
  return cache.p;
}

export interface UsageLine { label: string; text: string }

/** The newest ticket today for one mandate, or null. */
export function newestToday(receipts: ExecutionReceipt[], authorizationId: string, nowMs: number): ExecutionReceipt | null {
  let best: ExecutionReceipt | null = null;
  for (const r of receipts) {
    if (r.authorizationId !== authorizationId || !isToday(r.timestamp, nowMs)) continue;
    if (!best || r.timestamp > best.timestamp
      || (r.timestamp === best.timestamp && (r.cumulativeState?.daily?.count ?? 0) > (best.cumulativeState?.daily?.count ?? 0))) best = r;
  }
  return best;
}

/** Today and this month, as short figures: "1 of 10", or "3 calls" without a declared limit. */
export function usageLines(
  receipt: ExecutionReceipt,
  bounds: Record<string, string | number> | undefined,
  profile: AgentProfile | null | undefined,
): UsageLine[] {
  const out: UsageLine[] = [];
  for (const [window, label] of [['daily', 'today'], ['monthly', 'this month']] as const) {
    const u = windowUsage(receipt, bounds, profile, window);
    if (!u) continue;
    out.push({ label, text: 'limit' in u ? `${u.used} of ${u.limit}` : `${u.count} ${u.count === 1 ? 'call' : 'calls'}` });
  }
  return out;
}

export type MandateUsage = { state: 'loading' } | { state: 'none' } | { state: 'ok'; lines: UsageLine[] };

/** Today's usage of one mandate. `loading` until the tickets are read. */
export function useMandateUsage(
  authorizationId: string,
  bounds: Record<string, string | number> | undefined,
  profile: AgentProfile | null | undefined,
): MandateUsage {
  const [receipt, setReceipt] = useState<ExecutionReceipt | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setReceipt(undefined);
    void recentTickets().then((rs) => { if (live) setReceipt(newestToday(rs, authorizationId, Date.now())); });
    return () => { live = false; };
  }, [authorizationId]);
  if (receipt === undefined) return { state: 'loading' };
  if (receipt === null) return { state: 'none' };
  const lines = usageLines(receipt, bounds, profile);
  return lines.length ? { state: 'ok', lines } : { state: 'none' };
}
