/**
 * One "gateway process" for the device-key tests: the REAL routers
 * (mountDeviceKeyRoutes, createAuthRouter, createPasswordRouter, the page-session
 * guard), a REAL vault in a temp folder, REAL page sessions. The only stand-ins
 * are the network to the Authority Server (StubAs) and the MCP server's address
 * (recorders).
 */

import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../lib/vault';
import { PageSessions, SESSION_COOKIE, SESSION_HEADER } from '../../lib/page-session';
import { UnlockLimiter } from '../../lib/unlock-limiter';
import { ChangeConfirmations } from '../../lib/change-confirmation';
import { requireAuth, type PageSessionDeps } from '../../middleware/auth';
import { createAuthRouter, checkAsKeyBeforeLogin } from '../../routes/auth';
import { mountDeviceKeyRoutes } from '../../routes/device-keys-mount';
import { createEstablish } from '../../lib/device-session-establish';
import { createAsKeyCheck, asPinning } from '../../lib/device-as-trust';
import { createVaultRouter } from '../../routes/vault';
import { CheckKeyStore } from '../../lib/platform-checks';
import { DeviceChainStore } from '../../lib/device-chain-store';
import type { PlatformHelper } from '../../lib/platform-helper';
import type { StubAs } from './stub-as';
import { createMandateRouter } from '../../routes/mandate';
import { createInternalMandateRouter } from '../../routes/internal-mandate';
import { asAuthHeaders } from '../../lib/as-credential';
import { computeIntentDisclosureHash } from '@hap/core';
import type { CeremonyDeps } from '../../lib/mandate-ceremony';
import type { MandateGrants } from '../../lib/mandate-grants';

export const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };
export const PW = 'correct horse battery';

const dirs: string[] = [];
export const tmpDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'device-setup-')); dirs.push(d); return d; };

export interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown>; text: string }

export function call(
  port: number, method: string, path: string,
  opts: { headers?: Record<string, string>; body?: unknown; host?: string; origin?: string | null; connectTo?: string } = {},
): Promise<Reply> {
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, ...(opts.headers ?? {}) };
  if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? `http://${host}`;
  else if (opts.origin) headers.origin = opts.origin;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: opts.connectTo ?? '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const sessionHeaders = (s: { token: string; cookie: string }): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${s.cookie}`, [SESSION_HEADER]: s.token });

export function sessionOf(r: Reply): { token: string; cookie: string } {
  const setCookie = String(r.headers['set-cookie']?.[0] ?? '');
  const cookie = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
  return { token: String(r.body.sessionToken ?? ''), cookie };
}

export interface FakeTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
  pending: Array<{ id: number; fn: () => void; ms: number; live: boolean }>;
  /** Run the oldest live timer, then wait until `done` holds (the work behind a timer is several network calls). */
  fire: (done?: () => boolean) => Promise<void>;
}

export function fakeTimers(): FakeTimers {
  const pending: FakeTimers['pending'] = [];
  let n = 0;
  return {
    pending,
    set: (fn, ms) => { const t = { id: ++n, fn, ms, live: true }; pending.push(t); return t.id; },
    clear: h => { const t = pending.find(x => x.id === h); if (t) t.live = false; },
    fire: async done => {
      const t = pending.find(x => x.live);
      if (!t) throw new Error('no live timer');
      t.live = false;
      t.fn();
      const end = Date.now() + 5000;
      while (done && !done() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 50));
    },
  };
}

export interface GatewayRig {
  port: number;
  dir: string;
  vault: Vault;
  sessions: PageSessions;
  deps: PageSessionDeps;
  configured: Array<{ credential: string; keyHex?: string }>;
  alarms: string[];
  discards: { count: number };
  /** Set `wait` to hold every MCP hand-over until it resolves. */
  configureGate: { wait: Promise<void> | null };
  /** The sign-in object, for the 401 path (what the session lock calls). */
  signin: import('../../lib/device-signin').DeviceSignin | undefined;
  sweeps: { count: number };
  timers: FakeTimers;
  clock: { t: number };
  confirmations: ChangeConfirmations;
  checkStore: CheckKeyStore;
  /** Grants mandates on this computer (step 13); undefined with the switch off. */
  grants: MandateGrants | undefined;
  approvals: import('../../lib/device-approvals').DeviceApprovals | undefined;
  /** What the mandate router handed to the intent delivery and the gate resync. */
  delivered: Array<{ authorizationId: string }>;
  resynced: { count: number };
  /** Unlock with the password and return the page session. */
  unlock: () => Promise<{ token: string; cookie: string }>;
  close: () => Promise<void>;
}

export interface BootOptions {
  dir?: string;
  as: StubAs;
  /** SUVEREN_DEVICE_KEYS. Default on. */
  enabled?: boolean;
  /** Epoch seconds, shared with the stub AS where a test moves time. */
  clock?: { t: number };
  /** The address the server listens on. Default 127.0.0.1. */
  listenHost?: string;
  /** The native helper (step 5a), as the control plane's index.ts wires it. Unset: none of 5a is mounted. */
  platform?: PlatformHelper;
  /** Tests only: the other branch of PLATFORM_UNLOCK_OPENS_PAGE_SESSION. */
  opensPageSession?: boolean;
  /** Pass the vault the same MCP re-key client the real gateway has. */
  mcp?: import('../../lib/vault').McpRekeyClient;
  /** Decisions on the gateway page (step 12), wired as index.ts wires them. */
  decision?: NonNullable<Parameters<typeof mountDeviceKeyRoutes>[1]['device']>['decision'];
  /** Make the password vault in a fresh folder. Default true; false leaves the folder as it is (a restart). */
  fresh?: boolean;
  /** The desktop notification for a pending request for a new root DID (step 7). */
  notifyIdentityReset?: (title: string, message: string) => void;
  /** Mount `/api/mandate` (the sign page's router, step 13) with the real ceremony; only the intent delivery is a recorder. */
  mandate?: { deliver?: CeremonyDeps['deliverGateContent']; reads?: import('../../routes/mandate').MandateReads };
}

export async function bootGateway(o: BootOptions): Promise<GatewayRig> {
  const dir = o.dir ?? tmpDir();
  const enabled = o.enabled ?? true;
  const clock = o.clock ?? { t: Math.floor(Date.now() / 1000) };
  const vault = new Vault(dir, { ...FAST, deviceKeys: enabled });
  if (o.fresh !== false && !existsSync(join(dir, 'vault.enc.json'))) await vault.createWithPassword(PW, 'u1');
  const sessions = new PageSessions();
  const deps: PageSessionDeps = { sessions, listensOnLoopbackOnly: true };
  vault.onLocked(() => sessions.endAll());
  const configured: GatewayRig['configured'] = [];
  const sweeps = { count: 0 };
  const alarms: string[] = [];
  const discards = { count: 0 };
  const configureGate: { wait: Promise<void> | null } = { wait: null };
  const timers = fakeTimers();
  const app = express();
  const json = express.json();
  const guard = requireAuth(vault, deps);
  // Wired like index.ts: with the helper, the check key's slot decides whether the password still confirms.
  const checkStore = new CheckKeyStore(vault, new DeviceChainStore(vault));
  const confirmations = new ChangeConfirmations(o.platform ? { checkRequired: () => checkStore.has() } : {});
  const { deviceChainState, signin, loginChangeGate, grants, approvals } = mountDeviceKeyRoutes(app, {
    enabled, vault, pageSession: deps, limiter: new UnlockLimiter(), confirmations,
    hasCheckKey: o.platform ? () => checkStore.has() : () => false, internalSecret: () => 'sekret', jsonParser: json,
    platform: o.platform ? { host: o.platform, checkStore, opensPageSession: o.opensPageSession } : undefined,
    mcp: o.mcp,
    device: {
      asUrl: o.as.url,
      pinning: () => asPinning(o.as.url, dir),
      checkAs: createAsKeyCheck(o.as.url, dir, checkAsKeyBeforeLogin, () => {}),
      establish: createEstablish({
        vault,
        configure: async (credential, keyHex) => { configured.push({ credential, keyHex }); await configureGate.wait; },
        sweep: async () => { sweeps.count++; },
        log: () => {},
      }),
      now: () => clock.t,
      timers,
      onAlarm: c => { alarms.push(c); },
      notifyIdentityReset: o.notifyIdentityReset,
      discard: () => { vault.clearSpCookie(); discards.count++; },
      decision: o.decision,
    },
  });
  app.use('/auth', json, createAuthRouter(
    vault, guard, (_q, _s, n) => n(), undefined, { asUrl: o.as.url, dataDir: dir }, undefined, undefined, deps, deviceChainState,
  ));
  app.use('/vault', json, guard, createVaultRouter(vault, loginChangeGate));
  app.get('/api/x', guard, (_q, s) => { s.json({ ok: true }); });
  const delivered: GatewayRig['delivered'] = [];
  const resynced = { count: 0 };
  if (o.mandate) {
    const as: CeremonyDeps['as'] = async (method, path, body) => {
      const credential = vault.getSpCookie();
      if (!credential) return { status: 401, body: { error: 'not signed in' } };
      const r = await fetch(`${o.as.url}${path}`, {
        method, headers: { ...asAuthHeaders(credential), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual',
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const ceremonyDeps = (): Omit<CeremonyDeps, 'newAuthorizationId'> => ({
      user: vault.getSessionUser(), as,
      encrypt: async (_intent, recipients) => ({
        intentCiphertext: 'Y2lwaGVy', encryptedKeys: Object.fromEntries(recipients.map(r => [r.userId, { ct: 'a', enc: 'b' }])),
        approversFrozen: recipients.map(r => r.userId), intentDisclosureHash: computeIntentDisclosureHash('Y2lwaGVy', recipients.map(r => r.userId)),
      }),
      deliverGateContent: async a => { delivered.push({ authorizationId: a.authorizationId }); await o.mandate!.deliver?.(a); },
      resyncGates: async () => { resynced.count++; },
      // as production wires it (index.ts): the MCP server's copy of a held mandate, here the test's `reads.signedMandate`
      signedMandate: async (authorizationId: string) => { const r = await o.mandate!.reads?.signedMandate?.(authorizationId); return r && 'old' in r ? r.old : null; },
      ...(grants ? { grants } : {}),
    });
    app.use('/api/mandate', json, guard, createMandateRouter(ceremonyDeps, o.mandate.reads));
    app.use('/internal', json, createInternalMandateRouter(() => 'sekret', ceremonyDeps, approvals));
  }
  const server: Server = await new Promise(r => { const sv = app.listen(0, o.listenHost ?? '127.0.0.1', () => r(sv)); });
  const port = (server.address() as { port: number }).port;
  return {
    port, dir, vault, sessions, deps, configured, alarms, discards, configureGate, signin, sweeps, timers, clock, confirmations, checkStore, grants, approvals, delivered, resynced,
    unlock: async () => {
      const r = await call(port, 'POST', '/auth/unlock', { body: { password: PW }, connectTo: o.listenHost });
      if (r.status !== 200) throw new Error(`unlock failed: ${r.status} ${r.text}`);
      return sessionOf(r);
    },
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
