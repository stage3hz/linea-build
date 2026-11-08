import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardedClientIp, startCluster } from '../src/cluster.js';

const TOKEN = 't'.repeat(32);
const listen = (server, host = '127.0.0.1') => new Promise(r => server.listen(0, host, () => r(server.address().port)));
// Connections from 127.0.0.2 are "a client on the internet"; from 127.0.0.1 "the web front (Caddy)".
const get = (port, path, headers = {}, localAddress = '127.0.0.2') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers, localAddress }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});
const post = (port, path, headers, payload) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.end(JSON.stringify(payload));
});

test('client address: peers name it in X-Cluster-Client-Ip, the front in X-Forwarded-For, clients cannot', () => {
  const headers = { 'x-forwarded-for': '9.9.9.9', 'x-cluster-client-ip': '8.8.8.8' };
  assert.equal(forwardedClientIp({ headers, remoteAddress: '::ffff:203.0.113.9' }), '203.0.113.9', 'a client: its headers are ignored');
  assert.equal(forwardedClientIp({ headers, remoteAddress: '172.30.58.2', front: true }), '9.9.9.9', 'behind the front: the address the front saw');
  assert.equal(forwardedClientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, remoteAddress: '172.30.58.2', front: true }), '9.9.9.9', 'last hop the front appended');
  assert.equal(forwardedClientIp({ headers, remoteAddress: '172.30.58.2', front: true, peer: true }), '8.8.8.8', 'a peer through the front: its client');
  assert.equal(forwardedClientIp({ headers: { 'x-cluster-client-ip': 'not an ip' }, remoteAddress: '172.30.58.2', peer: true }), '172.30.58.2', 'a peer without a valid address');
  assert.equal(forwardedClientIp({ headers: { 'x-forwarded-for': 'junk' }, remoteAddress: '172.30.58.2', front: true }), '172.30.58.2');
});

test('supervisor: local health check, client address and token on the way to the primary', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-cluster-'));
  // A fake primary: records what reaches it, for plain requests and WebSocket upgrades.
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push({ kind: 'http', url: req.url, headers: req.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  upstream.on('upgrade', (req, socket) => { seen.push({ kind: 'ws', url: req.url, headers: req.headers }); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  const upstreamPort = await listen(upstream);
  const leaderUrl = `http://127.0.0.1:${upstreamPort}`;
  const cfg = {
    self: 'a', selfUrl: 'http://127.0.0.1:1', peers: [{ id: 'b', url: leaderUrl }], token: TOKEN, replicas: [`file://${dataDir}/replica`], witness: false,
    leaseMs: 600_000, bootstrap: false, litestream: '/bin/true', dataDir,
  };
  const front = http.createServer(() => {}); // only to pick a free port for the supervisor
  const port = await listen(front); await new Promise(r => front.close(r));
  const cluster = await startCluster({ port, host: '127.0.0.1', cfg });
  t.after(async () => { await cluster.close(); await new Promise(r => upstream.close(r)); await rm(dataDir, { recursive: true, force: true }); });

  // B37: the container's own check says the process is alive even before a primary is heard,
  // while the public answer still tells apps to pick another server.
  let r = await get(port, '/health?local=1', {}, '127.0.0.1');
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { status: 'ok', role: 'follower', epoch: 0, cluster: 'unavailable' });
  assert.equal((await get(port, '/health', {}, '127.0.0.1')).status, 503);
  assert.equal((await get(port, '/health?local=1', { 'x-forwarded-for': '203.0.113.1' }, '127.0.0.1')).status, 503, 'through the front it is the public answer');

  // The primary announces itself; the supervisor now forwards to it.
  r = await post(port, '/cluster/heartbeat', { 'x-cluster-token': TOKEN }, { epoch: 1, id: 'b', url: leaderUrl });
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).ok, true);
  assert.equal((await get(port, '/health', {}, '127.0.0.1')).status, 200);

  // B38: a client straight from the internet travels to the primary under its own address, whatever it claims.
  r = await get(port, '/me?x=1', { 'x-forwarded-for': '9.9.9.9', 'x-cluster-client-ip': '8.8.8.8', 'x-cluster-token': 'wrong' });
  assert.equal(r.status, 200);
  let h = seen.pop();
  assert.equal(h.kind, 'http'); assert.equal(h.url, '/me?x=1');
  assert.equal(h.headers['x-cluster-client-ip'], '127.0.0.2'); assert.equal(h.headers['x-forwarded-for'], '127.0.0.2');
  assert.equal(h.headers['x-cluster-token'], TOKEN); assert.equal(h.headers.host, `127.0.0.1:${upstreamPort}`);
  // Behind the web front the client is the address the front recorded.
  await get(port, '/me', { 'x-forwarded-for': '203.0.113.5' }, '127.0.0.1');
  h = seen.pop(); assert.equal(h.headers['x-cluster-client-ip'], '203.0.113.5'); assert.equal(h.headers['x-forwarded-for'], '203.0.113.5');
  // A request another supervisor forwarded (valid token) keeps that supervisor's client.
  await get(port, '/me', { 'x-cluster-token': TOKEN, 'x-cluster-client-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.2' }, '127.0.0.1');
  h = seen.pop(); assert.equal(h.headers['x-cluster-client-ip'], '203.0.113.7'); assert.equal(h.headers['x-forwarded-for'], '203.0.113.7');

  // B68: a WebSocket upgrade gets the same treatment as a plain request.
  const ws = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port, localAddress: '127.0.0.2' }, () => {
      sock.write('GET /ws?token=abc HTTP/1.1\r\nHost: api.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: 9.9.9.9\r\nX-Cluster-Client-Ip: 8.8.8.8\r\n\r\n');
    });
    let b = ''; sock.on('data', d => { b += d; if (b.includes('\r\n\r\n')) resolve({ sock, head: b }); }); sock.on('error', reject);
  });
  t.after(() => ws.sock.destroy());
  assert.match(ws.head, /^HTTP\/1\.1 101/);
  h = seen.pop();
  assert.equal(h.kind, 'ws'); assert.equal(h.url, '/ws?token=abc');
  assert.equal(h.headers['x-forwarded-for'], '127.0.0.2'); assert.equal(h.headers['x-cluster-client-ip'], '127.0.0.2');
  assert.equal(h.headers['x-cluster-token'], TOKEN); assert.equal(h.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(h.headers.upgrade, 'websocket');
});
