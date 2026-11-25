/**
 * Live events (0.46.1, DEC-107): whether the gateway holds its live connection to the Authority Server. While it does,
 * the AS announces every change (the control plane passes it on as the SSE event `as-changed`), so the page's own
 * polls only need to be a slow backup.
 *
 *   const live = useLiveEventsUp();
 *   useVisiblePolling(load, live ? LIVE_BACKUP_MS : 30_000);
 *   useSSEEvent('as-changed', load);
 */
import { useEffect, useState } from 'react';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { spClient } from '../lib/sp-client';

/** The backup poll while the live connection is up. */
export const LIVE_BACKUP_MS = 5 * 60_000;

let known: boolean | null = null;
const listeners = new Set<(up: boolean) => void>();
let asked = false;

function publish(up: boolean): void {
  known = up;
  for (const l of listeners) l(up);
}

export function useLiveEventsUp(): boolean {
  const [up, setUp] = useState<boolean>(known ?? false);
  useEffect(() => {
    listeners.add(setUp);
    if (!asked) {
      asked = true;
      void spClient.getLiveStatus().then(publish).catch(() => { asked = false; });
    }
    return () => { listeners.delete(setUp); };
  }, []);
  useSSEEvent('live-events', (payload) => {
    const v = (payload as { up?: unknown } | null)?.up;
    if (typeof v === 'boolean') publish(v);
  });
  return up;
}

/** Tests only. */
export function _resetLiveEventsForTests(): void {
  known = null;
  asked = false;
  listeners.clear();
}
