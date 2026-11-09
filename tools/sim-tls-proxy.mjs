// HTTPS front for the local test server in the iOS Simulator check (.github/workflows/ios-simulator-ui.yml).
// The app only speaks HTTPS; the simulator trusts this test CA (added with `simctl keychain add-root-cert`)
// and nothing else changes: TLS stays on. Forwards requests and WebSocket upgrades to the plain local
// server. Usage: node tools/sim-tls-proxy.mjs <cert.pem> <key.pem> <listenPort> <targetPort>
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const [cert, key, listen = '8443', target = '3999'] = process.argv.slice(2);
// One line per request (method, path without the query, status, time to the server's answer and to the end):
// in CI the server itself does not log requests, and a slow answer could not be told from a lost one.
const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const started = Date.now(), path = (req.url || '').split('?')[0];
  const upstream = http.request({ host: '127.0.0.1', port: Number(target), method: req.method, path: req.url, headers: req.headers }, reply => {
    log(req.method, path, reply.statusCode, `${Date.now() - started}ms`);
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', error => { log(req.method, path, 'upstream error', error.code || error.message, `${Date.now() - started}ms`); if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('aborted', () => log(req.method, path, 'client aborted', `${Date.now() - started}ms`));
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(Number(target), '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`), '', ''];
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
});
server.listen(Number(listen), '127.0.0.1', () => console.log(`sim-tls-proxy https://localhost:${listen} -> http://127.0.0.1:${target}`));
