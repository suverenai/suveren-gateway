/**
 * S1 increment 4: the broker lets only the pinned agent build talk to the daemon.
 *
 * Real kernel and code-signing checks, as the normal user, on a Unix socket in a
 * scratch folder (no port, no root, no account). The binaries are built with swiftc
 * and signed ad hoc, as the installer's cdhash pin intends (DEC-74: no Developer ID).
 * Skipped where swiftc, codesign or macOS are missing.
 *
 * Not shown here, only the VM run can: the same check with the daemon under another
 * account (the kernel call is the same; not measured), and a debugger attach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentChannel, createAgentHandler, type AgentChannel } from '../../../../bundle/lib/agent-channel.mjs';
import { parseCdhash, buildPinJson, AGENT_IDENTIFIER } from '../../../../bundle/lib/system-install-mac.mjs';

const root = join(__dirname, '../../../../native/macos');
const tools = process.platform === 'darwin' &&
  spawnSync('which', ['swiftc']).status === 0 && spawnSync('which', ['codesign']).status === 0;

describe.skipIf(!tools)('broker and agent channel', () => {
  let dir: string;
  let channel: AgentChannel;
  const seen: unknown[] = [];
  const refused: string[] = [];
  let sock: string;

  const sign = (name: string, id: string, flags: string[] = []) => {
    copyFileSync(join(dir, 'stub'), join(dir, name));
    const r = spawnSync('codesign', ['--force', '-s', '-', '-i', id, ...flags, join(dir, name)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const ask = (bin: string, args: string[], json = '{"op":"hello"}') =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(bin, [sock, json, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out: out.trim() }));
    });
  const pythonClient = ['-c', `import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.send(b'{"op":"hello"}\\n');print(s.recv(200).decode())`];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 's1-brk-')));
    for (const [src, out] of [['suveren-broker.swift', 'broker'], ['test/agent-stub.swift', 'stub']]) {
      const r = spawnSync('swiftc', ['-O', join(root, src), '-o', join(dir, out)], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    sign('agent', AGENT_IDENTIFIER, ['-o', 'runtime']);
    sign('lookalike', AGENT_IDENTIFIER, ['-o', 'runtime,library']); // same identifier, different build
    sign('other', 'com.example.other', ['-o', 'runtime']);
    // The "installer": read the cdhash of the genuine build and write the pin.
    const cd = spawnSync('codesign', ['-dvvv', join(dir, 'agent')], { encoding: 'utf8' });
    writeFileSync(join(dir, 'pin.json'), buildPinJson({ cdhash: parseCdhash(cd.stderr) }));
    // A copy of the genuine build with one code byte changed, signature kept.
    copyFileSync(join(dir, 'agent'), join(dir, 'edited'));
    const fd = openSync(join(dir, 'edited'), 'r+');
    closeSync(fd);
    spawnSync('bash', ['-c', `printf 'Z' | dd of='${join(dir, 'edited')}' bs=1 seek=20000 conv=notrunc 2>/dev/null`]);

    sock = join(dir, 'a.sock');
    channel = startAgentChannel({
      brokerPath: join(dir, 'broker'),
      socketPath: sock,
      pinPath: join(dir, 'pin.json'),
      onMessage: (msg, reply, conn) => { seen.push(msg); createAgentHandler({ version: '9.9.9', isLocked: () => true })(msg, reply); void conn; },
      onRefused: (v) => refused.push(v),
    });
    await channel.ready;
  }, 240_000);

  afterAll(() => {
    channel?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves the genuine pinned agent', async () => {
    const r = await ask(join(dir, 'agent'), []);
    expect(JSON.parse(r.out)).toEqual({ ok: true, op: 'hello', daemon: 'suveren-gateway', version: '9.9.9', locked: true });
    expect(seen).toContainEqual({ op: 'hello' });
  });

  it('answers an unknown request with an error, not silence', async () => {
    const r = await ask(join(dir, 'agent'), [], '{"op":"unlock-everything"}');
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: 'unknown_op' });
  });

  it('refuses a copy with the same identifier but another build (the cdhash pin)', async () => {
    const before = seen.length;
    const r = await ask(join(dir, 'lookalike'), []);
    expect(JSON.parse(r.out)).toEqual({ error: 'refused' });
    expect(seen.length).toBe(before); // never reached the daemon's handler
    expect(refused.some((v) => v.includes('requirement not met'))).toBe(true);
  });

  it('refuses another signed program', async () => {
    const before = seen.length;
    expect(JSON.parse((await ask(join(dir, 'other'), [])).out)).toEqual({ error: 'refused' });
    expect(seen.length).toBe(before);
  });

  it('refuses a script of the same user (python3)', async () => {
    const before = seen.length;
    const r = await new Promise<string>((resolve) => {
      const p = spawn('/usr/bin/python3', [...pythonClient, sock], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => resolve(out.trim()));
    });
    expect(r).toContain('refused');
    expect(seen.length).toBe(before);
  });

  it('never serves the genuine build with one code byte changed', async () => {
    const before = seen.length;
    const r = await ask(join(dir, 'edited'), []);
    expect(r.out).not.toContain('"ok":true');
    expect(seen.length).toBe(before);
  });

  it('removes its socket and exits when the daemon goes away', async () => {
    expect(existsSync(sock)).toBe(true);
    channel.stop();
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(sock)).toBe(false);
  });
});
