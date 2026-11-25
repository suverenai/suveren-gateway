/**
 * A QR code as SVG rects: no image, no inline style (CSP `style-src 'self'`). One component for the phone (its recovery code) and
 * the gateway page (the pairing QR of "Add a phone" and "Add this computer"). The class `device-qr` keeps it dark on light in
 * both themes (design-system.css).
 */
import { useMemo } from 'react';
import { qrMatrix } from '../lib/qr-matrix';

export function QrCode({ text, label, testid = 'qr-code' }: { text: string; label: string; testid?: string }) {
  const rows = useMemo(() => qrMatrix(text), [text]);
  const quiet = 4;
  const size = rows.length + quiet * 2;
  return (
    <svg className="device-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} data-testid={testid} shapeRendering="crispEdges">
      {rows.flatMap((row, r) => row.map((dark, c) => (dark ? <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} /> : null)))}
    </svg>
  );
}
