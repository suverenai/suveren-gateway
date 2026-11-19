/**
 * GET /api/profiles and /api/profiles/:id are answered from THIS gateway's own
 * profiles (what it enforces), never forwarded to the Authority Server (DEC-77).
 * Real HTTP through the real router; the gateway's catalog is the reads stand-in
 * (mcp-server's own endpoint is tested in apps/mcp-server/test/profile-catalog.test.ts).
 * A stand-in "Authority Server" sits behind the same express app, as the proxy
 * does in production, to prove it is never reached for these two reads.
 */
import { it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createProfilesRouter, type LocalProfileReads } from '../routes/profiles';

const NEWEST = { id: 'github.com/x/hap-profiles/email@0.10', name: 'Email', version: '0.10', description: 'd' };
const OLDER = { id: 'github.com/x/hap-profiles/email@0.7', name: 'Email', version: '0.7', description: 'd' };

let srv: Server | undefined;
afterEach(() => { srv?.close(); srv = undefined; });

function start(reads: LocalProfileReads) {
  const asHits: string[] = [];
  const app = express();
  app.use('/api/profiles', createProfilesRouter(reads));
  // Stands in for the AS proxy that follows in index.ts: reached only by what the router lets through.
  app.use('/api', (req, res) => { asHits.push(`${req.method} ${req.originalUrl}`); res.json({ from: 'authority-server' }); });
  srv = app.listen(0);
  return { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/profiles`, asHits };
}

const reads: LocalProfileReads = {
  list: async () => ({ profiles: [OLDER, NEWEST] }),
  get: async (id) => (id === NEWEST.id ? { status: 200, body: NEWEST }
    : id === OLDER.id ? { status: 200, body: OLDER }
    : { status: 404, body: { error: 'profile_not_shipped', message: `This gateway does not include the area "${id}". Update the gateway to use it.` } }),
};

it('the list is the gateway\'s own, and the Authority Server is not asked', async () => {
  const { base, asHits } = start(reads);
  const r = await fetch(base);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ profiles: [OLDER, NEWEST] });
  expect(asHits).toEqual([]);
});

it('one profile is the gateway\'s own copy; the id travels URL-encoded, slashes included', async () => {
  const { base, asHits } = start(reads);
  const r = await fetch(`${base}/${encodeURIComponent(NEWEST.id)}`);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(NEWEST);
  expect(asHits).toEqual([]);
});

it('a profile the gateway does not ship answers 404 with a plain reason, and is not fetched from the Authority Server', async () => {
  const { base, asHits } = start(reads);
  const r = await fetch(`${base}/${encodeURIComponent('example.org/profiles/offered-by-as@3')}`);
  expect(r.status).toBe(404);
  expect(await r.json()).toMatchObject({ error: 'profile_not_shipped', message: expect.stringMatching(/does not include the area .* Update the gateway/) });
  expect(asHits).toEqual([]);
});

it('when the gateway cannot read its catalog it fails visibly (502), it does not fall back to the Authority Server', async () => {
  const { base, asHits } = start({ list: async () => { throw new Error('mcp down'); }, get: async () => { throw new Error('mcp down'); } });
  expect((await fetch(base)).status).toBe(502);
  expect((await fetch(`${base}/x`)).status).toBe(502);
  expect(asHits).toEqual([]);
});

it('anything but a read (publishing a community profile) is not this router\'s: it falls through', async () => {
  const { base, asHits } = start(reads);
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(await r.json()).toEqual({ from: 'authority-server' });
  expect(asHits).toEqual(['POST /api/profiles']);
});
