/** GET /internal/unlock-password: the MCP server asks whether an unlock password exists, by internal secret only. */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createInternalDeviceRouter } from '../routes/internal-device';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function ask(hasPassword: (() => boolean) | undefined, secret?: string) {
  const app = express();
  app.use('/internal', createInternalDeviceRouter(() => 's3cret', {} as never, {} as never, undefined, hasPassword));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server!.once('listening', r));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/internal/unlock-password`, { headers: secret ? { 'X-Internal-Secret': secret } : {} });
  return { status: res.status, body: await res.json() };
}

describe('GET /internal/unlock-password', () => {
  it('says whether the vault has an unlock password', async () => {
    expect(await ask(() => true, 's3cret')).toEqual({ status: 200, body: { hasPassword: true } });
    expect(await ask(() => false, 's3cret')).toEqual({ status: 200, body: { hasPassword: false } });
    expect(await ask(undefined, 's3cret')).toEqual({ status: 200, body: { hasPassword: false } });
  });
  it('is refused without the internal secret', async () => {
    expect((await ask(() => true)).status).toBe(401);
    expect((await ask(() => true, 'wrong')).status).toBe(401);
  });
});
