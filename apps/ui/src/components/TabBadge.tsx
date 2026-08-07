import { useEffect } from 'react';
import { usePendingCount } from '../hooks/usePendingCount';
import { setTabBadge, clearTabBadge } from '../lib/tab-badge';

/**
 * Binds the pending count to the browser tab. Renders nothing.
 *
 * Mounted inside the authenticated shell, so it unmounts on logout — and the
 * cleanup clears the badge, because a stale "(2)" on a signed-out tab is a
 * claim about someone else's data.
 */
export function TabBadge(): null {
  const count = usePendingCount();

  useEffect(() => {
    setTabBadge(count);
  }, [count]);

  useEffect(() => clearTabBadge, []);

  return null;
}
