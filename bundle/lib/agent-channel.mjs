/**
 * The daemon's end of the agent channel (S1, docs/own-os-user.md section 4).
 *
 * Starts the broker as a child, reads what it reports, and hands every message
 * from a verified agent to a handler. A peer that fails the code check never
 * produces a message: the broker answers it itself and only reports "refused".
 *
 * The channel carries messages, not trust: what the daemon sends back must not
 * depend on the sender being the person (the agent is the same user as an AI
 * could be). Secrets travel only after a touch, in increment 5.
 */

import { spawn } from 'node:child_process';

/**
 * @param opts.brokerPath  the signed broker binary (root-owned install folder)
 * @param opts.socketPath  where the agent connects (folder owned by the daemon's account)
 * @param opts.pinPath     the root-owned pin file
 * @param opts.onMessage   (msg, reply) => void; reply(obj) answers on the same connection
 * @param opts.onRefused   (verdict: string) => void, optional
 * @param opts.onExit      (code) => void, optional
 */
export function startAgentChannel({ brokerPath, socketPath, pinPath, onMessage, onRefused, onExit, spawnFn = spawn }) {
  const child = spawnFn(brokerPath, ['--socket', socketPath, '--pin', pinPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (obj) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + '\n'); };
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.event === 'ready') resolveReady();
      else if (ev.event === 'msg') onMessage(ev.msg, (data) => send({ conn: ev.conn, data }), ev.conn);
      else if (ev.event === 'refused') onRefused?.(String(ev.verdict));
    }
  });
  child.on('exit', (code) => { rejectReady(new Error(`broker exited (${code})`)); onExit?.(code); });
  child.on('error', (err) => rejectReady(err));

  return {
    ready,
    send,
    close: (conn) => send({ conn, close: true }),
    // Closing stdin is the polite stop (the broker removes its socket); SIGTERM does the same.
    stop: () => { child.stdin.end(); child.kill('SIGTERM'); },
  };
}

/** The first thing the agent can ask: is the daemon there, and is it locked? */
export function createAgentHandler({ version, isLocked }) {
  return (msg, reply) => {
    if (msg && msg.op === 'hello') reply({ ok: true, op: 'hello', daemon: 'suveren-gateway', version, locked: Boolean(isLocked()) });
    else reply({ ok: false, error: 'unknown_op' });
  };
}
