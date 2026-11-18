import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
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

/**
 * While a recovery code is on screen, printing prints only the code. The class sits on `body` only for that time,
 * so printing any other page is untouched.
 */
export function PrintScope() {
  useEffect(() => {
    document.body.classList.add('print-recovery-code');
    return () => document.body.classList.remove('print-recovery-code');
  }, []);
  return null;
}

/** An input for a recovery code: a plain text field that password managers are asked to leave alone. */
export function CodeInput(props: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <input id={props.id} className="form-input" type="text" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
      data-1p-ignore="true" data-lpignore="true" data-form-type="other"
      value={props.value} onChange={e => props.onChange(e.target.value)} disabled={props.disabled} style={{ padding: '0.75rem' }} />
  );
}

/** A line the screens show: error, info or success, in the design system's alert. */
export function Notice({ kind, children }: { kind: 'error' | 'info' | 'success'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}
