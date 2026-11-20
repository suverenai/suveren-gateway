import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { wrapVaultKey } from './wrap.js';
import {
  DIGEST_RE, PROTOCOL_VERSION,
  type ErrorCode, type HelloInfo, type KeyInfo, type Policy, type SignResult,
} from './protocol.js';

export class HelperError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

export interface StartOptions {
  /** Path to suveren-unlock-helper (or, in tests, to the runtime that runs a fake). */
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Calls that need no touch. Default 10 s. */
  quickTimeoutMs?: number;
  /** Calls that wait for a person (unwrap, check.sign). Default 120 s. */
  touchTimeoutMs?: number;
}

interface Pending {
  op: string;
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: HelperError) => void;
  timer: NodeJS.Timeout;
}

const MAX_LINE = 64 * 1024;

/**
 * Talks to one helper child process. Requests run one at a time: only one prompt can be on the
 * screen, and the person must be able to tell which request a touch answers.
 * The gateway starts the helper itself; nothing else can reach its pipes (DESIGN.md section 2).
 */
export class UnlockHelperClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed: HelperError | null = null;
  private stderrTail = '';
  private quickMs: number;
  private touchMs: number;

  private constructor(child: ChildProcessWithoutNullStreams, o: StartOptions) {
    this.child = child;
    this.quickMs = o.quickTimeoutMs ?? 10_000;
    this.touchMs = o.touchTimeoutMs ?? 120_000;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-500); });
    child.on('error', (e) => this.fail(new HelperError('helper_missing', `Cannot start the helper: ${e.message}`)));
    // Exit code 77 is the helper's refusal of a caller. At start it refuses before it reads anything, so no message comes first.
    child.on('exit', (code, sig) => this.fail(code === 77
      ? new HelperError('caller_refused', 'The helper refused this caller.')
      : new HelperError('helper_exited', `The helper stopped (${sig ?? code}). ${this.stderrTail.trim()}`.trim())));
    child.stdin.on('error', () => { /* the exit handler reports it */ });
  }

  /** Starts the helper and checks its protocol version. */
  static async start(o: StartOptions): Promise<UnlockHelperClient> {
    const child = spawn(o.command, o.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env: o.env ?? process.env });
    const c = new UnlockHelperClient(child, o);
    try {
      const info = await c.hello();
      if (info.protocol !== PROTOCOL_VERSION) {
        throw new HelperError('bad_response', `Helper speaks protocol ${info.protocol}, expected ${PROTOCOL_VERSION}.`);
      }
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }

  async hello(): Promise<HelloInfo> {
    const r = await this.call('hello', {});
    return {
      helper: str(r, 'helper'), version: str(r, 'version'), protocol: num(r, 'protocol'),
      platform: str(r, 'platform') as HelloInfo['platform'], backend: str(r, 'backend'),
      secureHardware: bool(r, 'secureHardware'), biometry: bool(r, 'biometry'), userPresence: bool(r, 'userPresence'),
    };
  }

  /** New wrap key. No touch. Policy: see DESIGN.md section 6. */
  async createWrapKey(policy: Policy): Promise<KeyInfo> {
    return keyInfo(await this.call('wrap.create', { policy }));
  }

  /**
   * Wraps the 32-byte vault key to the wrap key's public half. Done in Node, no helper call: the helper never
   * receives the plaintext vault key (DESIGN.md 3.2). `aad` binds the wrap (account id and purpose).
   */
  async wrap(a: { publicKey: string; vaultKey: Buffer; aad: string }): Promise<string> {
    return wrapVaultKey(a);
  }

  /** One touch. Returns the vault key; the caller zeroes the buffer when done. */
  async unwrap(a: { keyBlob: string; wrapped: string; aad: string }): Promise<Buffer> {
    const r = await this.call('unwrap', { keyBlob: a.keyBlob, wrapped: a.wrapped, aad: a.aad }, this.touchMs);
    const key = Buffer.from(str(r, 'vaultKey'), 'base64url');
    if (key.length !== 32) throw new HelperError('bad_response', 'The helper returned a key of the wrong size.');
    return key;
  }

  /** New check key. No touch. */
  async createCheckKey(policy: Policy): Promise<KeyInfo> {
    return keyInfo(await this.call('check.create', { policy }));
  }

  /**
   * One touch. Signs the 32 digest bytes (ECDSA P-256, SHA-256 inside, DER out).
   * `object` is the exact bytes whose SHA-256 is `digest`; the helper checks that before it asks for a
   * touch and builds the prompt text from the object itself (DESIGN.md section 5). There is no way to
   * pass text: a caller cannot choose what the person reads. `reason` in the answer is what was shown.
   */
  async signCheck(a: { keyBlob: string; digest: string; object: Uint8Array; /** A DID that picks one member of a team member list for the prompt; the name and code shown come from the object. */ focus?: string; /** The signed bytes of the member list before this one: the helper compares the two to say what the touch is for (DEC-73 step 5). */ previous?: Uint8Array }): Promise<SignResult> {
    if (!DIGEST_RE.test(a.digest)) throw new HelperError('bad_request', 'digest must be "sha256:" and 64 lower-case hex digits.');
    if (sha256Hash(a.object) !== a.digest) throw new HelperError('digest_mismatch', 'digest is not the SHA-256 of object.');
    const r = await this.call('check.sign', { keyBlob: a.keyBlob, digest: a.digest, object: b64u(a.object), ...(a.focus !== undefined ? { focus: a.focus } : {}), ...(a.previous !== undefined ? { previous: b64u(a.previous) } : {}) }, this.touchMs);
    return { signature: str(r, 'signature'), publicKey: str(r, 'publicKey'), reason: str(r, 'reason') };
  }

  close(): void {
    if (this.closed) return;
    this.fail(new HelperError('helper_exited', 'The helper was closed.'));
    try { this.child.stdin.end(); } catch { /* already closed */ }
    this.child.kill();
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private call(op: string, fields: Record<string, unknown>, timeoutMs = this.quickMs): Promise<Record<string, unknown>> {
    const run = () => this.send(op, fields, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private send(op: string, fields: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A prompt may still be on screen; end the helper so a late touch cannot answer an old request.
        reject(new HelperError('timeout', `The helper did not answer ${op} in time.`));
        this.child.kill();
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE && !this.buf.includes('\n')) {
      this.fail(new HelperError('bad_response', 'The helper sent an oversized line.'));
      this.child.kill();
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { return this.fail(new HelperError('bad_response', 'The helper sent invalid JSON.')); }
    // The helper refuses a caller with a message that has no id, then exits.
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) {
      const e = (msg.error ?? {}) as { code?: string; message?: string };
      if (e.code === 'caller_refused') return this.fail(new HelperError('caller_refused', e.message ?? 'The helper refused this caller.'));
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.id as number);
    if (msg.ok === true) return p.resolve(msg);
    const e = (msg.error ?? {}) as { code?: string; message?: string };
    p.reject(new HelperError((e.code as ErrorCode) ?? 'internal', e.message ?? 'The helper refused.'));
  }

  private fail(e: HelperError): void {
    if (!this.closed) this.closed = e;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

export function b64u(b: Uint8Array): string { return Buffer.from(b).toString('base64url'); }

export function sha256Hash(bytes: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== 'string') throw new HelperError('bad_response', `The helper's answer has no ${k}.`);
  return v;
}
function num(r: Record<string, unknown>, k: string): number {
  const v = r[k];
  if (typeof v !== 'number') throw new HelperError('bad_response', `The helper's answer has no ${k}.`);
  return v;
}
function bool(r: Record<string, unknown>, k: string): boolean {
  const v = r[k];
  if (typeof v !== 'boolean') throw new HelperError('bad_response', `The helper's answer has no ${k}.`);
  return v;
}
function keyInfo(r: Record<string, unknown>): KeyInfo {
  const publicKey = str(r, 'publicKey');
  const pub = Buffer.from(publicKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4) throw new HelperError('bad_response', 'The helper returned a public key that is not a P-256 point.');
  return { keyBlob: str(r, 'keyBlob'), publicKey, policy: str(r, 'policy') as Policy };
}

/** What goes into a chain entry's `device.check` (hap-core 3.1): `{ type: 'platform', pub }`. */
export function platformCheckKey(publicKey: string): { type: 'platform'; pub: string } {
  return { type: 'platform', pub: publicKey };
}
/** What goes into the entry's `checks[].check`: `{ signature }`. */
export function platformCheckProof(signature: string): { signature: string } {
  return { signature };
}
