import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';

// Every frame, alert and code box is the gateway page's own (packages/approval-card/src/components/DeviceFrame.tsx).
export { useDriver, Notice } from '@suveren/approval-card/components/DeviceFrame';
export const Screen = DeviceFrame;

/** The same line on the gateway page: one function in the shared package. */
export { whenText } from '@suveren/approval-card/lib/pairing-texts';
