/**
 * The native unlock helper as the control plane uses it (device-keys plan 5a, DEC-38, DEC-47;
 * packages/unlock-helper/DESIGN.md). It starts the helper as a child process on demand, keeps it
 * for a short while, and ends it. It never logs or returns anything the helper sends except codes.
 *
 * Before every start the helper's files are hashed and compared with a list the gateway carries
 * itself (not the one beside the helper): a swapped binary is refused, and the hashes are looked
 * at again after the helper answered, so a swap between the check and the start is seen too.
 * Both lists (the hashes and the callers) sit in folders the person's own user can write. Against a program
 * of that user they add nothing: it rewrites the helper, the hashes and the callers together. They catch a
 * damaged or half-updated install and a wrong program started by mistake. See DESIGN.md section 4.
 *
 * macOS on Apple silicon and 64-bit Windows (x64, arm64) have a helper. Everywhere else the answer is
 * "not available, and why", and every caller falls back to the password, which is what the gateway did before.
 * The Windows helper reports no secure hardware until Windows Hello is measured on real hardware
 * (DESIGN.md section 8), so on Windows the password stays the way in for now.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UnlockHelperClient, HelperError, wrapVaultKey, type HelloInfo, type KeyInfo, type Policy } from '@suveren/unlock-helper';
import type { PlatformKeyService } from './vault';

/** Why there is no helper, as a neutral code. The page's wording for each is the maintainer's (O19). */
export type HelperUnavailable =
  | 'unsupported_platform'   // neither macOS nor Windows
  | 'unsupported_arch'       // an Intel Mac, or 32-bit Windows: password only
  | 'helper_not_installed'   // this install carries no helper
  | 'helper_modified'        // a file of the helper is not the one this gateway was built with
  | 'helper_failed'          // it did not start or answer
  | 'caller_refused'         // the helper refused this gateway process
  | 'no_secure_hardware'     // no Secure Enclave, or no way to verify a person
  | 'no_biometry';           // only for the check key: no Touch ID here

export interface HelperFile { path: string; sha256: string }

export interface HelperSpec {
  command: string;
  args: string[];
  /** Hashed before every start. Absolute paths. */
  files: HelperFile[];
  /** The helper's list of callers it serves, written before every start (release builds only; tests use --allowed-callers). */
  callers?: { path: string; body: string };
  env?: NodeJS.ProcessEnv;
}

export type Located = { spec: HelperSpec } | { unavailable: HelperUnavailable };

export interface PlatformStatus {
  available: boolean;
  reason?: HelperUnavailable;
  platform?: HelloInfo['platform'];
  backend?: string;
  secureHardware?: boolean;
  biometry?: boolean;
  userPresence?: boolean;
}

/** The pinned hashes of a helper app: `{ "files": { "Contents/MacOS/suveren-unlock-helper": "<sha256 hex>", … } }`. */
export interface HelperManifest { v: 1; files: Record<string, string> }

export const HELPER_EXECUTABLE = 'Contents/MacOS/suveren-unlock-helper';
/** Beside the .app, not inside it: a file added to a signed bundle breaks its seal (packages/unlock-helper/DESIGN.md section 4). */
export const HELPER_CALLERS_FILE = '../allowed-callers.json';
/** Windows: a folder `helper/windows-<arch>` with the .exe; the helper reads allowed-callers.json beside its .exe. */
export const WINDOWS_HELPER_EXECUTABLE = 'suveren-unlock-helper.exe';
export const WINDOWS_HELPER_CALLERS_FILE = 'allowed-callers.json';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file's hash equals the pinned one. Throws `helper_modified` (or `helper_not_installed` for a missing file). */
export function verifyHelperFiles(files: HelperFile[]): void {
  for (const f of files) {
    if (!existsSync(f.path)) throw new HelperUnavailableError('helper_not_installed');
    let actual: string;
    try { actual = sha256File(f.path); } catch { throw new HelperUnavailableError('helper_not_installed'); }
    if (actual !== f.sha256) throw new HelperUnavailableError('helper_modified');
  }
}

export class HelperUnavailableError extends Error {
  constructor(readonly code: HelperUnavailable) {
    super(code);
    this.name = 'HelperUnavailableError';
  }
}

function parseManifest(path: string, executable: string): HelperManifest | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8')) as HelperManifest;
    if (m?.v !== 1 || !m.files || typeof m.files !== 'object' || !(executable in m.files)) return null;
    for (const h of Object.values(m.files)) if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return null;
    return m;
  } catch {
    return null;
  }
}

export interface LocateOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Folder of the running control plane (`dist/control-plane` in the package). */
  here: string;
  env?: NodeJS.ProcessEnv;
  /** The running script, for the list of callers. */
  scriptPath?: string;
  execPath?: string;
}

/**
 * Where the helper is, and what it must hash to. In the published package:
 *   <package>/helper/Suveren.app                      the ad-hoc signed bundle
 *   <package>/dist/control-plane/helper-manifest.json the hashes (written by bundle/build.mjs, from the same build)
 * On Windows (x64 or arm64) the same, with a folder instead of the app:
 *   <package>/helper/windows-<arch>/suveren-unlock-helper.exe
 *   <package>/dist/control-plane/helper-manifest-windows-<arch>.json  `{ "files": { "suveren-unlock-helper.exe": "<sha256>" } }`
 * (one list per architecture, so one package can carry the Mac app and both Windows builds).
 * `SUVEREN_HELPER_APP` (the dev lane, a hand test) names another Suveren.app, or on Windows another helper folder;
 * its hashes are then read from the list of the same name beside it, which is weaker (a swap that also swaps the list is
 * not seen) and is why it is a deliberate setting.
 */
export function locateHelper(o: LocateOptions): Located {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  let layout: { folder: string; executable: string; callersFile: string; manifest: string };
  if (platform === 'darwin') {
    if (arch !== 'arm64') return { unavailable: 'unsupported_arch' };
    layout = { folder: join('helper', 'Suveren.app'), executable: HELPER_EXECUTABLE, callersFile: HELPER_CALLERS_FILE, manifest: 'helper-manifest.json' };
  } else if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') return { unavailable: 'unsupported_arch' };
    layout = { folder: join('helper', `windows-${arch}`), executable: WINDOWS_HELPER_EXECUTABLE, callersFile: WINDOWS_HELPER_CALLERS_FILE, manifest: `helper-manifest-windows-${arch}.json` };
  } else {
    return { unavailable: 'unsupported_platform' };
  }
  const env = o.env ?? process.env;
  const override = env.SUVEREN_HELPER_APP?.trim();
  const app = override ? resolve(override) : resolve(o.here, '..', '..', layout.folder);
  const manifestPath = override ? join(dirname(app), layout.manifest) : join(o.here, layout.manifest);
  if (!existsSync(join(app, layout.executable)) || !existsSync(manifestPath)) return { unavailable: 'helper_not_installed' };
  const manifest = parseManifest(manifestPath, layout.executable);
  if (!manifest) return { unavailable: 'helper_modified' };
  const files = Object.entries(manifest.files).map(([rel, sha256]) => ({ path: join(app, rel), sha256 }));
  // The list of callers: the Node program that runs this code, and the folder its entry script is in.
  let callers: HelperSpec['callers'];
  try {
    const exe = realpathSync(o.execPath ?? process.execPath);
    const script = realpathSync(o.scriptPath ?? process.argv[1] ?? '');
    callers = { path: resolve(app, layout.callersFile), body: JSON.stringify({ v: 1, callers: [{ exe, scriptPrefix: dirname(script) }] }) };
  } catch {
    return { unavailable: 'helper_failed' };
  }
  return { spec: { command: join(app, layout.executable), args: ['serve'], files, callers } };
}

export interface HostOptions {
  locate: () => Located;
  /** A helper process kept idle this long is ended (so the next use hashes the files again). Default 60 s. */
  idleMs?: number;
  quickTimeoutMs?: number;
  touchTimeoutMs?: number;
  /** Tests: make the client another way. */
  startClient?: (spec: HelperSpec) => Promise<UnlockHelperClient>;
}

/** Wrap policies decided in DESIGN.md 6.1 (the maintainer decides): unlock by presence, the check by biometry. */
export const UNLOCK_POLICY: Policy = 'user-presence';
export const CHECK_POLICY: Policy = 'biometry-current-set';
/**
 * The check key's policy on this computer. macOS: biometry (Touch ID), as decided in DESIGN.md 6.1. Windows (DEC-97):
 * Windows Hello with the PIN counts as well as a fingerprint or face, so `user-presence`; Windows' key storage cannot
 * require biometry only anyway (DESIGN.md 8.0).
 */
export function checkPolicyFor(platform: HelloInfo['platform'] | undefined): Policy {
  return platform === 'windows' ? 'user-presence' : CHECK_POLICY;
}

export class PlatformHelper {
  private client: UnlockHelperClient | null = null;
  private starting: Promise<UnlockHelperClient> | null = null;
  private info: HelloInfo | null = null;
  private idle: NodeJS.Timeout | null = null;
  /** Calls that are using the helper right now: it is never ended under one (a prompt may be on screen). */
  private active = 0;
  private readonly idleMs: number;

  constructor(private readonly o: HostOptions) {
    this.idleMs = o.idleMs ?? 60_000;
  }

  /** What this computer can do. Starts the helper (no touch) when there is one. Never throws. */
  async status(): Promise<PlatformStatus> {
    this.active++;
    try {
      await this.get();
      const i = this.info;
      if (!i) throw new HelperUnavailableError('helper_failed');   // ended by another call in between
      if (!i.secureHardware) return { available: false, reason: 'no_secure_hardware', platform: i.platform, backend: i.backend, secureHardware: false, biometry: i.biometry, userPresence: i.userPresence };
      return { available: true, platform: i.platform, backend: i.backend, secureHardware: true, biometry: i.biometry, userPresence: i.userPresence };
    } catch (err) {
      return { available: false, reason: unavailableCode(err) };
    } finally {
      this.active--;
      this.touchIdle();
    }
  }

  /** The helper's description, or throws HelperUnavailableError. */
  async describe(): Promise<HelloInfo> {
    return this.use(async (_c, info) => info);
  }

  /** Run `fn` with a started, verified helper. The helper is ended on a failure of the process itself. */
  async use<T>(fn: (c: UnlockHelperClient, info: HelloInfo) => Promise<T>): Promise<T> {
    this.active++;
    this.touchIdle();
    try {
      const c = await this.get();
      const info = this.info;
      if (!info) throw new HelperUnavailableError('helper_failed');
      return await fn(c, info);
    } catch (err) {
      // A dead or timed-out helper is dropped; the next use starts a fresh, freshly verified one.
      if (err instanceof HelperError && ['helper_exited', 'timeout', 'bad_response', 'caller_refused', 'helper_missing'].includes(err.code)) this.close();
      throw err;
    } finally {
      this.active--;
      this.touchIdle();
    }
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.client?.close();
    this.client = null;
    this.info = null;
  }

  private touchIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.active > 0 || !this.client) return;
    this.idle = setTimeout(() => this.close(), this.idleMs);
    this.idle.unref?.();
  }

  private async get(): Promise<UnlockHelperClient> {
    if (this.client) return this.client;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<UnlockHelperClient> {
    const located = this.o.locate();
    if ('unavailable' in located) throw new HelperUnavailableError(located.unavailable);
    const { spec } = located;
    verifyHelperFiles(spec.files);
    if (spec.callers) {
      // The list of callers the helper reads. HONEST LIMIT: this file sits in a folder the person's own user can
      // write, and this very code rewrites it before each start, so any program of the same user can write itself
      // into it and be served. Against such a program the caller check adds NOTHING. It stops accidents and
      // programs of other users, nothing more. NODE_OPTIONS (the helper refuses a parent that has it, but the
      // attacker is not that parent), DYLD_INSERT_LIBRARIES into the gateway, and an inspector signal into the
      // running gateway are further ways past it. The real fix is a list written at install time into a folder
      // the user cannot write, and the gateway as its own OS user (plan section 21, S1/S2, O29). Kept because
      // it costs nothing and catches a wrong program by mistake.
      mkdirSync(dirname(spec.callers.path), { recursive: true });
      const tmp = `${spec.callers.path}.tmp`;
      writeFileSync(tmp, spec.callers.body, { mode: 0o644 });
      renameSync(tmp, spec.callers.path);
    }
    let c: UnlockHelperClient;
    try {
      c = await (this.o.startClient ?? ((s) => UnlockHelperClient.start({
        command: s.command, args: s.args, env: s.env ?? minimalEnv(process.platform), quickTimeoutMs: this.o.quickTimeoutMs, touchTimeoutMs: this.o.touchTimeoutMs,
      })))(spec);
    } catch (err) {
      throw new HelperUnavailableError(err instanceof HelperError && err.code === 'caller_refused' ? 'caller_refused' : 'helper_failed');
    }
    try {
      const info = await c.hello();
      // The files again, now that the process runs: a swap between the first look and the start shows here.
      verifyHelperFiles(spec.files);
      this.client = c;
      this.info = info;
      return c;
    } catch (err) {
      c.close();
      if (err instanceof HelperUnavailableError) throw err;
      throw new HelperUnavailableError('helper_failed');
    }
  }
}

/** The helper gets nothing of the gateway's environment (no key, no token, no NODE_OPTIONS). */
function minimalEnv(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  // SUVEREN_HELPER_NO_PROMPT only RESTRICTS (every touch fails with interaction_required): the one setting passed on.
  const noPrompt = process.env.SUVEREN_HELPER_NO_PROMPT === '1' ? { SUVEREN_HELPER_NO_PROMPT: '1' } : {};
  if (platform === 'win32') {
    // Windows needs its own folders to load its system libraries and the person's key storage; no secrets in these.
    const pick = (k: string) => (process.env[k] ? { [k]: process.env[k] } : {});
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    return { SystemRoot: root, PATH: `${root}\\System32`, ...pick('USERPROFILE'), ...pick('LOCALAPPDATA'), ...pick('APPDATA'), ...pick('TEMP'), ...noPrompt };
  }
  return { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', ...noPrompt };
}

function unavailableCode(err: unknown): HelperUnavailable {
  return err instanceof HelperUnavailableError ? err.code : 'helper_failed';
}

/**
 * The vault's view of the helper (lib/vault.ts PlatformKeyService): the unlock wrap, policy `user-presence`.
 * A Mac without Touch ID still has the Mac's own password as the touch (DESIGN.md 6.1).
 */
export function unlockKeyService(host: PlatformHelper): PlatformKeyService {
  return {
    createWrapKey: () => host.use(async (c, info) => {
      if (!info.secureHardware) throw Object.assign(new Error('no_secure_hardware'), { code: 'no_secure_hardware' });
      const k: KeyInfo = await c.createWrapKey(UNLOCK_POLICY);
      return { keyBlob: k.keyBlob, publicKey: k.publicKey, policy: k.policy, backend: info.backend };
    }),
    // In Node, no helper call: the helper never receives the plaintext vault key (DESIGN.md 3.2).
    wrap: async (a) => wrapVaultKey(a),
    unwrap: (a) => host.use((c) => c.unwrap(a)),
  };
}
