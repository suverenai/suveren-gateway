import { useEffect, useState, type ReactNode } from 'react';
import { T, DRAFT } from '../../lib/device-texts';
import { DeviceScreen, Notice } from './DeviceScreen';

/** After this long without an answer the page says what may be missing and offers a way out. */
export const CONNECT_STUCK_MS = 45_000;

/**
 * The page while the person finishes Connect in the browser tab it opened. It says what is still missing (the
 * Connect button on suveren.ai), and after a while that nothing came yet, with "Start again": a tab left over from
 * an earlier attempt, a closed tab or a missed button must never leave the page waiting for good.
 */
export function ConnectWaiting({ error, onStartAgain, startAgainLabel, children, initiallyStuck = false }: {
  error?: string;
  /** Tests only: render as if the wait had already run long (the page has no DOM test environment for timers). */
  initiallyStuck?: boolean;
  onStartAgain: () => void;
  startAgainLabel?: string;
  children?: ReactNode;
}) {
  const [stuck, setStuck] = useState(initiallyStuck);
  useEffect(() => {
    const id = window.setTimeout(() => setStuck(true), CONNECT_STUCK_MS);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <DeviceScreen title={T.connectTitle}>
      <Notice kind="info">{T.connectWaiting}</Notice>
      <p>{DRAFT.connectWaitingWhat}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {stuck && <Notice kind="info">{DRAFT.connectStuck}</Notice>}
      {stuck && <button className="btn btn-secondary btn-full" onClick={onStartAgain}>{startAgainLabel ?? DRAFT.connectStartAgain}</button>}
      {children}
    </DeviceScreen>
  );
}
