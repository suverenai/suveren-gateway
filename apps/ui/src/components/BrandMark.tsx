/**
 * The Suveren mark — display master (the "stamp ring": an open ring completed
 * by a detached key segment; no receipt, no execution as geometry).
 *
 * Inherits `currentColor`, so it follows the surrounding text colour and the
 * app's [data-theme] toggle without a second asset. The favicon is a separate,
 * wider-gapped master (public/favicon.svg) — that difference is deliberate,
 * not drift.
 *
 * Geometry is frozen (ring R41/stroke 15, gap 104° at 1–2 o'clock, key on the
 * ring line) and identical to the Authority Server's BrandMark. Regenerate from
 * the brand asset scripts rather than editing the numbers here.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M 104.6 58.29 A 41 41 0 1 1 48.64 25.99"
        stroke="currentColor"
        strokeWidth="15"
        strokeLinecap="round"
      />
      <line
        x1="73.24"
        y1="21.99"
        x2="95.76"
        y2="34.99"
        stroke="currentColor"
        strokeWidth="15"
        strokeLinecap="round"
      />
    </svg>
  );
}
