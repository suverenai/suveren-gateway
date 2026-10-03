/**
 * A CONNECT-tunnelling `https.Agent` — for callers that hand an agent to
 * Node's own `http(s).request()` rather than using `fetch` (in this
 * codebase, the control-plane's long-lived `/api` reverse proxy to the
 * Authority Server; `fetchAs` in as-tls-pin.ts uses undici's `ProxyAgent`
 * instead, which already tunnels for `fetch`/`undici.request`).
 *
 * Deliberately hand-rolled rather than depending on a third-party
 * CONNECT-tunnelling agent package (`https-proxy-agent` was evaluated and
 * rejected): it subclasses `agent-base`'s `http.Agent`, which does NOT merge
 * the agent's own constructor options (`ca`, `checkServerIdentity`) into the
 * TLS connection it opens to the REAL target — only to the connection to the
 * proxy itself (irrelevant here; proxies are virtually always plain `http:`).
 * Only Node's OWN `https.Agent` merges constructor options into every
 * connection it creates (via `this.options`), which is exactly why
 * subclassing it directly — and overriding only `createConnection` to route
 * the socket through a CONNECT tunnel first — is the one construction
 * that is guaranteed to carry pin-tls/`--ca-file` through a proxy correctly.
 *
 * Mirrors `apps/mcp-server/src/lib/proxy-https-agent.ts`. Keep the two in
 * step.
 */
import { Agent as HttpsAgent, type AgentOptions, type RequestOptions } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type { Duplex } from 'node:stream';

export interface ConnectTunnelAgentOptions extends AgentOptions {
  /** e.g. `http://proxy.corp.example:8080` or `http://user:pass@proxy.corp.example:8080` */
  proxyUrl: string;
}

const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024;

/**
 * Opens a `CONNECT host:port` tunnel through `proxyUrl` and resolves with the
 * raw (post-tunnel, pre-TLS) socket. Rejects on a non-200 CONNECT response, a
 * malformed/oversized response, or a transport-level error on the socket to
 * the proxy — never leaves the caller hanging on either.
 */
function openConnectTunnel(proxyUrl: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80 });

    const onSocketError = (err: Error) => {
      socket.removeListener('data', onData);
      reject(err);
    };
    socket.once('error', onSocketError);

    socket.once('connect', () => {
      const authHeader = proxyUrl.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
          ).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authHeader}Proxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffered.length > MAX_CONNECT_RESPONSE_BYTES) {
          socket.removeListener('error', onSocketError);
          socket.destroy();
          reject(new Error(`Proxy CONNECT response to ${host}:${port} exceeded ${MAX_CONNECT_RESPONSE_BYTES} bytes without completing`));
        }
        return;
      }
      socket.removeListener('data', onData);
      socket.removeListener('error', onSocketError);

      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString('latin1');
      const statusCode = Number(statusLine.split(' ')[1]);
      if (statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT to ${host}:${port} failed: ${statusLine.trim() || `unexpected status ${statusCode}`}`));
        return;
      }

      // Bytes received AFTER the CONNECT response's blank-line terminator
      // already belong to the tunnelled protocol (a fast proxy can pipeline
      // the target's first TLS bytes in the same read) — push them back onto
      // the socket's readable side before handing it to tls.connect(), or
      // they are silently dropped and the handshake hangs.
      const extra = buffered.subarray(headerEnd + 4);
      if (extra.length > 0) socket.unshift(extra);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/**
 * A `https.Agent` whose connections are tunnelled through an HTTP(S) proxy
 * via `CONNECT`, then TLS-upgraded with THIS agent's own constructor options
 * (`ca`, `checkServerIdentity`, ...) applied — exactly the merge a direct
 * (non-proxied) `https.Agent` performs internally, reproduced explicitly here
 * via the same `createConnection` extension point the core class itself
 * uses for every connection.
 */
export class ConnectTunnelHttpsAgent extends HttpsAgent {
  private readonly proxyUrl: URL;

  constructor(options: ConnectTunnelAgentOptions) {
    const { proxyUrl, ...agentOptions } = options;
    super(agentOptions);
    this.proxyUrl = new URL(proxyUrl);
  }

  /**
   * Matches `https.Agent`'s own `createConnection` signature exactly (see
   * `node:https`'s type definitions) so this remains a true override — the
   * base type's `callback` parameter is optional (a from-scratch `Agent`
   * subclass is allowed to connect synchronously and return the stream
   * directly instead), but every real caller in this codebase (Node's own
   * HTTP client machinery) always supplies one, since a CONNECT tunnel is
   * inherently asynchronous. The explicit runtime check turns a theoretical
   * synchronous caller into a clear error instead of a silent no-op.
   */
  override createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (!callback) {
      throw new Error('ConnectTunnelHttpsAgent.createConnection requires a callback (synchronous connection creation is not supported)');
    }
    const host = options.host ?? 'localhost';
    const port = options.port != null ? Number(options.port) : 443;
    openConnectTunnel(this.proxyUrl, host, port)
      .then((tunnelSocket: Socket) => {
        const tlsSocket = tlsConnect({
          ...(this.options as TlsConnectionOptions),
          ...(options as TlsConnectionOptions),
          socket: tunnelSocket,
        });
        // `tls.connect({ socket })` wraps `tunnelSocket` without taking
        // ownership of it — destroying `tlsSocket` alone leaves the
        // underlying CONNECT-tunnel TCP socket (and, transitively, the
        // proxy's end of it) open. `https.Agent`'s own bookkeeping only
        // ever sees `tlsSocket` (that's what this function hands back), so
        // without this, every connection through a proxy leaks one socket
        // at the proxy for the life of the process.
        tlsSocket.once('close', () => tunnelSocket.destroy());
        tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
        tlsSocket.once('error', (err: Error) => callback(err, tlsSocket));
      })
      .catch((err: Error) => callback(err, undefined as unknown as Duplex));
    return undefined;
  }
}
