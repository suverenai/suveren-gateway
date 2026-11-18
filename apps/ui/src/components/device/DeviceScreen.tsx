import { useSyncExternalStore, type ReactNode } from 'react';
import type { Driver } from '../../lib/driver';
import { TopNav } from '../TopNav';
import { UpdateBanner } from '../UpdateBanner';

/** Read a driver's state in React. */
export function useDriver<S>(driver: Driver<S>): S {
  return useSyncExternalStore(driver.subscribe, driver.get, driver.get);
}

/** The frame of every device-key screen: the top bar and one centred column (the look of the sign-in). */
export function DeviceScreen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <>
      <TopNav />
      <UpdateBanner />
      <div className="device-screen">
        {title && <h1>{title}</h1>}
        {children}
      </div>
    </>
  );
}

/** A line the screens show: error, info or success, in the design system's alert. */
export function Notice({ kind, children }: { kind: 'error' | 'info' | 'success'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}
