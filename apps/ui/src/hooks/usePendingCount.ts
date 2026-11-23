import { useApprovalQueue } from '../contexts/ApprovalQueueContext';

/**
 * How many things are waiting for this human to decide: exactly the approvals the Approvals list and the panel show (the one queue,
 * ApprovalQueueContext), so the tab, the dock and the nav never say "1" while the list says "Nothing waiting for you"
 * (dev lane 2026-11-23: a request closed on the phone left the badge at 1 for a long time — it had its own reads and its own refresh).
 * 0 until the queue has been read: never a guessed count.
 */
export function usePendingCount(): number {
  const q = useApprovalQueue();
  return q.loaded ? q.entries.length : 0;
}
