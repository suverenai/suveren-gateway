import type { Request, Response, NextFunction } from 'express';

/**
 * The gateway page must never be embeddable by another site. A page the user
 * visits could otherwise frame http://localhost:<port> invisibly and trick a
 * click onto "Approve" (clickjacking). Found 2026-10-19 while planning the
 * Rehearsal demo: no framing header was set at all.
 *
 * 'self' (not 'none'): the gateway frames its own content — the PDF preview
 * of an approval card is a same-origin blob document, which inherits this
 * policy and must stay displayable.
 */
export function noForeignFraming(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
}
