import { DeviceFrame } from '@suveren/approval-card/components/DeviceFrame';

// Every frame, alert and code box is the gateway page's own (packages/approval-card/src/components/DeviceFrame.tsx).
export { useDriver, Notice } from '@suveren/approval-card/components/DeviceFrame';
export const Screen = DeviceFrame;

/** The same line on the gateway page: one function in the shared package. */
export { whenText } from '@suveren/approval-card/lib/pairing-texts';

/**
 * While the system's touch window is coming (Andreas, 2026-11-20): only "Waiting for your touch…" with the gateway's spinner, in
 * place of the buttons; no sketch of the system window. A Cancel stays (the UI review): the person can always leave. When the
 * touch failed, the same place says so, with Try again and Cancel. Layout kept plain on purpose: the reviewed version replaces it.
 */
export function TouchWait({ text, error, onRetry, onCancel, retryLabel, cancelLabel }: {
  text: string; error?: string; onRetry?: () => void; onCancel?: () => void; retryLabel?: string; cancelLabel?: string;
}) {
  if (error) {
    return (
      <div data-testid="touch-failed">
        <div className="alert alert-error" role="alert">{error}</div>
        {onRetry && <button type="button" className="btn btn-primary btn-full btn-lg" onClick={onRetry} data-testid="touch-retry">{retryLabel}</button>}
        {onCancel && <button type="button" className="btn btn-ghost btn-full" onClick={onCancel} data-testid="touch-cancel">{cancelLabel}</button>}
      </div>
    );
  }
  return (
    <div data-testid="touch-wait">
      <div className="av3-stamp av3-stamp-wait" role="status">
        <span className="av3-spin" aria-hidden="true" />
        {text}
      </div>
      {onCancel && <button type="button" className="btn btn-ghost btn-full" onClick={onCancel} data-testid="touch-cancel">{cancelLabel}</button>}
    </div>
  );
}
