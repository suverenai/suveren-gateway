// The only door out of the AI's place. Two openings, nothing else:
//
//   1. the gateway port  -> the Suveren gateway on this computer
//   2. port 3128         -> an HTTPS proxy that lets through only the hosts
//                           listed in ALLOW (your AI provider)
//
// Node built-ins only; no packages to install. See ../sandbox.md.

const net = require('net');
const http = require('http');

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'host.docker.internal';
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 3430);
const ALLOW = (process.env.ALLOW || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function join(a, b) {
  a.pipe(b);
  b.pipe(a);
  const end = () => { a.destroy(); b.destroy(); };
  a.on('error', end);
  b.on('error', end);
}

// 1. The gateway, and only the gateway.
net.createServer((client) => join(client, net.connect(GATEWAY_PORT, GATEWAY_HOST)))
  .listen(GATEWAY_PORT, '0.0.0.0');

// 2. HTTPS to the listed hosts, port 443 only. Everything else is refused
//    and written to the log (`docker logs ai-door`).
const proxy = http.createServer((req, res) => {
  console.log(`refused ${req.method} ${req.url}`);
  res.writeHead(403);
  res.end('Only HTTPS to the allowed hosts passes this door.\n');
});

proxy.on('connect', (req, client) => {
  const at = req.url.lastIndexOf(':');
  const host = req.url.slice(0, at).toLowerCase();
  const port = req.url.slice(at + 1);
  if (port !== '443' || !ALLOW.includes(host)) {
    console.log(`refused ${req.url}`);
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    join(client, upstream);
  });
  upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
});

proxy.listen(3128, '0.0.0.0', () => {
  console.log(`door open: gateway -> ${GATEWAY_HOST}:${GATEWAY_PORT}; HTTPS only to ${ALLOW.join(', ') || '(no host)'}`);
});
