import { describe, it, expect } from 'vitest';
import express from 'express';
import { noForeignFraming } from '../lib/no-foreign-framing';

describe('noForeignFraming — clickjacking (2026-10-19)', () => {
  it('every response forbids framing by another site, but allows the gateway itself', async () => {
    const app = express();
    app.use(noForeignFraming);
    app.get('/x', (_req, res) => { res.send('ok'); });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/x`);
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    } finally {
      server.close();
    }
  });
});
