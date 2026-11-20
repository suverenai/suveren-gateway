import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';

// Every frame, alert and code box is the gateway page's own (packages/approval-card/src/components/DeviceFrame.tsx).
export { useDriver, Notice } from '@suveren/approval-card/components/DeviceFrame';
export const Screen = DeviceFrame;

/** The same line on the gateway page: one function in the shared package. */
export { whenText } from '@suveren/approval-card/lib/pairing-texts';

/**
 * While the system's touch window is coming (Andreas, 2026-11-20): only "Waiting for your touch…" with the gateway's spinner, in
 * place of the buttons. No sketch of the system window, no other text. The gateway card's own waiting stamp (av3-stamp-wait).
 */
export function TouchWait({ text }: { text: string }) {
  return (
    <div className="av3-stamp av3-stamp-wait" role="status" data-testid="touch-wait">
      <span className="av3-spin" aria-hidden="true" />
      {text}
    </div>
  );
}
