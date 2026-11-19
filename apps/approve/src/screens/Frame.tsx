import { useSyncExternalStore, type ReactNode } from 'react';
import type { Driver } from '../lib/driver';
import { P } from '../texts';

/** Read a driver's state in React. */
export function useDriver<S>(driver: Driver<S>): S {
  return useSyncExternalStore(driver.subscribe, driver.get, driver.get);
}

/** The frame of every phone screen: one centred column, the same rules as the gateway page's device-key screens (`.device-screen`). */
export function Screen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="device-screen">
      {title && <h1>{title}</h1>}
      {children}
    </div>
  );
}

/** A line the screens show: error, info or success, in the design system's alert. */
export function Notice({ kind, children }: { kind: 'error' | 'info' | 'success'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

/** `Intl` time for a list line; the phone's own locale. */
export function whenText(epochSeconds: number, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - epochSeconds) / 86400);
  if (days <= 0) return P.whenToday;
  if (days === 1) return P.whenYesterday;
  if (days < 14) return P.whenDaysAgo(days);
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
