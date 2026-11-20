import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';
import { P } from '../texts';

// Every frame, alert and code box is the gateway page's own (packages/approval-card/src/components/DeviceFrame.tsx).
export { useDriver, Notice } from '@suveren/approval-card/components/DeviceFrame';
export const Screen = DeviceFrame;

/** `Intl` time for a list line; the phone's own locale. */
export function whenText(epochSeconds: number, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - epochSeconds) / 86400);
  if (days <= 0) return P.whenToday;
  if (days === 1) return P.whenYesterday;
  if (days < 14) return P.whenDaysAgo(days);
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
