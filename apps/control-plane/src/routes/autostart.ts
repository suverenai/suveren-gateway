/**
 * Autostart — "keep the gateway running" as an HTTP surface.
 *
 * The mechanism already exists in the CLI (`suveren-gateway service …`), but a
 * feature that requires a terminal is a feature most people never get. This
 * exposes it so the UI can offer a single switch.
 *
 * Deliberately SHELLS OUT to the CLI rather than reimplementing the platform
 * logic. There is one implementation of the launchd / Task Scheduler / systemd
 * details, and it is the one that ships; a second copy here would drift, and
 * the drift would be silent — exactly how the service command managed to be
 * broken on every platform without anyone noticing.
 */
import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname as pathDirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Platforms the CLI implements autostart for. */
const SUPPORTED = new Set(['darwin', 'win32', 'linux']);

/**
 * Locate the CLI.
 *
 * Bundled layout:  <root>/bin/suveren-gateway.js, control-plane at
 *                  <root>/dist/control-plane/
 * Dev layout:      repo/bundle/bin/suveren-gateway.js
 *
 * Returns null when neither exists — running from source without a built
 * bundle, where autostart genuinely cannot be offered.
 */
/**
 * Where this module lives.
 *
 * NOT __dirname: the control-plane is bundled to ESM (.mjs), where __dirname
 * does not exist. Using it threw ReferenceError inside the route handler,
 * which surfaced as an unhandled rejection and took the ENTIRE gateway down —
 * control-plane exits, supervisor stops the MCP server, every integration dies.
 * A settings page reading its own state must never be able to do that.
 */
const MODULE_DIR = pathDirname(fileURLToPath(import.meta.url));

export function findCli(dirname: string = MODULE_DIR): string | null {
  // ORDER MATTERS. tsup flattens the control-plane into <root>/dist/control-plane/*.mjs,
  // so at runtime __dirname is that directory and the shipped CLI is exactly two
  // levels up. Checking a repo-relative path first would resolve to the SOURCE
  // CLI on a developer machine and to nothing at all on a real install — the
  // toggle would then report "unavailable" for every user while working here.
  const candidates = [
    // Bundled (the shipped layout): dist/control-plane → dist → root → bin
    resolve(dirname, '..', '..', 'bin', 'suveren-gateway.js'),
    // Bundled, were the routes/ directory ever preserved.
    resolve(dirname, '..', '..', '..', 'bin', 'suveren-gateway.js'),
    // Dev, running from source: the repo's own bundle directory.
    resolve(dirname, '..', '..', '..', '..', 'bundle', 'bin', 'suveren-gateway.js'),
    resolve(dirname, '..', '..', '..', '..', '..', 'bundle', 'bin', 'suveren-gateway.js'),
    // Deliberately NO process.cwd() fallback: it makes the result depend on
    // where the process happened to be launched from, so the same install
    // resolves differently between a shell and a login service — and it would
    // mask a genuinely missing CLI whenever the cwd happened to be the repo.
  ];
  return candidates.find(existsSync) ?? null;
}

async function cli(args: string[]): Promise<{ ok: boolean; output: string }> {
  const bin = findCli();
  if (!bin) return { ok: false, output: 'CLI not found' };
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], {
      timeout: 60_000,
      env: process.env,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'failed' };
  }
}

/**
 * Wrap an async handler so a thrown error becomes a 500 instead of an
 * unhandled rejection.
 *
 * Express 4 does not catch rejections from async handlers, so one throw
 * escapes to the process. Under Node's default that terminates the
 * control-plane, the supervisor then stops the MCP server, and every
 * integration dies — a settings page reading its own state took the whole
 * gateway down exactly once, which was once too many.
 */
function safe(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Autostart] handler failed:', message);
      if (!res.headersSent) res.status(500).json({ error: 'autostart_failed', message });
    });
  };
}

export function createAutostartRouter(): Router {
  const router = Router();

  /** Current state, so the UI can render truth rather than what it last set. */
  router.get('/', safe(async (_req: Request, res: Response) => {
    const platform = process.platform;
    const supported = SUPPORTED.has(platform);
    const bin = findCli();

    if (!supported || !bin) {
      res.json({
        supported: false,
        installed: false,
        platform,
        // Be specific about WHICH of the two reasons applies — "unavailable"
        // with no cause is the kind of dead end that generates support mail.
        reason: !supported
          ? `Autostart is not available on ${platform}.`
          : 'Autostart needs the packaged gateway; it is unavailable when running from source.',
      });
      return;
    }

    const { output } = await cli(['service', 'status']);
    res.json({
      supported: true,
      installed: /Login service:\s*installed/i.test(output),
      platform,
      detail: output,
    });
  }));

  /** Turn it on. Idempotent — the CLI overwrites an existing registration. */
  router.post('/', safe(async (_req: Request, res: Response) => {
    if (!SUPPORTED.has(process.platform) || !findCli()) {
      res.status(400).json({ error: 'unsupported', message: 'Autostart is not available here.' });
      return;
    }
    const { ok, output } = await cli(['service', 'install']);
    if (!ok) {
      res.status(500).json({ error: 'install_failed', message: output });
      return;
    }
    res.json({ ok: true, installed: true, detail: output });
  }));

  /** Turn it off. */
  router.delete('/', safe(async (_req: Request, res: Response) => {
    if (!SUPPORTED.has(process.platform) || !findCli()) {
      res.status(400).json({ error: 'unsupported', message: 'Autostart is not available here.' });
      return;
    }
    const { ok, output } = await cli(['service', 'uninstall']);
    if (!ok) {
      res.status(500).json({ error: 'uninstall_failed', message: output });
      return;
    }
    res.json({ ok: true, installed: false, detail: output });
  }));

  return router;
}
