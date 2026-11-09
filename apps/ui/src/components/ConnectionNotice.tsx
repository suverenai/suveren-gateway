import { useEffect, useState, useSyncExternalStore } from 'react';
import { unreachableRetry } from '../lib/unreachable-retry';

/** A read could not reach the server: say so, and when the next try is. A reload would mean signing in again. */
export function ConnectionNotice() {
  const { waiting, nextTryAt } = useSyncExternalStore(unreachableRetry.subscribe, unreachableRetry.getState);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (nextTryAt === null) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextTryAt]);

  if (!waiting) return null;
  const seconds = nextTryAt === null ? 0 : Math.max(1, Math.ceil((nextTryAt - now) / 1000));

  return (
    <div className="connection-notice" role="status" aria-live="polite" data-testid="connection-notice">
      <span>
        Could not reach the server.{' '}
        {nextTryAt === null ? 'Trying again now…' : `Trying again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`}
        {' '}No need to reload, you stay signed in.
      </span>
      {nextTryAt !== null && (
        <button type="button" className="connection-notice-btn" onClick={unreachableRetry.tryNow} data-testid="connection-try-now">Try now</button>
      )}
    </div>
  );
}
