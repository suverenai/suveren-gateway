/**
 * The frame and the small pieces of the gateway's device-key screens (unlock, set-up, recovery, join), shared with the phone app:
 * ONE implementation. The gateway page wraps the frame with its top bar (apps/ui `DeviceScreen`); the phone draws it as it is.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { Driver } from '../lib/driver';
import { groupCode } from '../mandate-screens/texts';

/** Read a driver's state in React. */
export function useDriver<S>(driver: Driver<S>): S {
  return useSyncExternalStore(driver.subscribe, driver.get, driver.get);
}

/** One centred column with a title (the look of the sign-in). */
export function DeviceFrame({ title, children }: { title?: string; children: ReactNode }) {
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

/** While a recovery code is on screen, printing prints only the code. The class sits on `body` only for that time. */
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

/** The recovery code as the gateway shows it (and prints it): a boxed, monospaced line. `children` (a QR on the phone) prints with it. */
export function RecoveryCodeBox({ code, testid = 'recovery-code', children }: { code: string; testid?: string; children?: ReactNode }) {
  return (
    <div className="recovery-code-print">
      <div className="recovery-code" data-testid={testid}>{code}</div>
      {children}
    </div>
  );
}

/** A labelled code in a monospaced line (identity codes, comparison codes). Digits are shown in groups of four. */
export function CodeBlock({ label, code, testid, grouped = true }: { label?: string; code: string; testid: string; grouped?: boolean }) {
  return (
    <div style={{ margin: '0.75rem 0' }}>
      {label && <div style={{ color: 'var(--text-secondary)' }}>{label}</div>}
      <div data-testid={testid} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '1.25rem', letterSpacing: '0.05em', overflowWrap: 'anywhere' }}>{grouped ? groupCode(code) : code}</div>
    </div>
  );
}
