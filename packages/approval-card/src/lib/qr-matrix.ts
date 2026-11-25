/**
 * The modules of a QR code as a plain matrix, so a screen can draw it as SVG rects with no inline style and no image (CSP:
 * `style-src 'self'`). Used for the recovery sheet's QR (plan 2.1: "the code as text and as a QR code holding the same
 * text"). The encoder is bundled (qrcode-generator); nothing is sent anywhere.
 */
import qrcode from 'qrcode-generator';

/** Error correction M; the version is the smallest that fits. `true` is a dark module. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}
