// Several Invizent servers in different data centres, one primary at a time.
//
// Every server runs this supervisor on the public port. The supervisors elect the primary by
// majority vote with numbered epochs (the leader-election half of Raft):
//   • the primary runs the real app and streams its database to storage with Litestream
//     (a new folder per epoch, so an old primary can never overwrite the new one's copy);
//   • a standby keeps a live read-only copy (litestream restore -f), mirrors uploaded files,
//     and forwards every request to the primary;
//   • a primary that cannot hear a majority for CLUSTER_LEASE_MS stops accepting writes,
//     and a standby asks for votes only after twice that long, so two primaries never write.
// Peers talk over HTTPS with a shared token (CLUSTER_TOKEN). See deploy/cluster.md.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createWriteStream, statSync, readdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const log = (...a) => console.log(new Date().toISOString(), '[cluster]', ...a);

export function clusterConfig(env = process.env) {
  const self = env.CLUSTER_SELF;
  const peers = JSON.parse(env.CLUSTER_PEERS || '[]');
  if (!/^[a-z0-9-]{1,32}$/.test(self || '')) throw new Error('CLUSTER_SELF: short id like "msk"');
  if (!Array.isArray(peers) || !peers.length || peers.some(p => !/^[a-z0-9-]{1,32}$/.test(p.id) || !/^https?:\/\//.test(p.url))) throw new Error('CLUSTER_PEERS: [{"id":"spb","url":"https://api2.invizent.com"}]');
  const token = env.CLUSTER_TOKEN || '';
  if (token.length < 32) throw new Error('CLUSTER_TOKEN: at least 32 random characters, the same on every server');
  const replicas = (env.CLUSTER_REPLICA || '').split(/\s+/).filter(Boolean);
  const witness = env.CLUSTER_WITNESS === '1';
  if (!replicas.length && !witness) throw new Error('CLUSTER_REPLICA: storage for the database copy, e.g. s3://bucket/invizent');
  return {
    self, selfUrl: env.CLUSTER_SELF_URL || '', peers, token, replicas, witness,
    leaseMs: Number(env.CLUSTER_LEASE_MS || 8000), bootstrap: env.CLUSTER_BOOTSTRAP === '1',
    litestream: env.LITESTREAM_BIN || 'litestream', dataDir: resolve(env.DATA_DIR || 'data'),
  };
}

/** Majority of the whole cluster (this server + peers). */
export const majority = size => Math.floor(size / 2) + 1;

/**
 * The client's address as the supervisor sees it (unit-tested). A request another supervisor
 * forwarded (`peer`: its cluster token checked) names the client in X-Cluster-Client-Ip, because
 * the web front in between rewrites X-Forwarded-For to the peer's own address. Behind the trusted
 * web front (`front`) the client is the last address the front appended to X-Forwarded-For. Any
 * other connection is the client itself: headers it sent are never believed.
 */
export function forwardedClientIp({ headers = {}, remoteAddress = '', front = false, peer = false }) {
  const from = String(remoteAddress || '').replace(/^::ffff:/, '');
  const given = String(headers['x-cluster-client-ip'] || '').trim();
  if (peer && net.isIP(given)) return given;
  if (front) {
    const chain = String(headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const last = chain[chain.length - 1];
    if (last && net.isIP(last)) return last;
  }
  return from;
}

/**
 * Pure vote rule (unit-tested): grant only a newer epoch, once per epoch, only if this server
 * has not heard a live primary recently, and only to a candidate whose copy is at least as fresh.
 */
export function shouldGrantVote({ myEpoch, votedEpoch, heardLeaderAgoMs, leaseMs, myPosition }, { epoch, position }) {
  if (!(epoch > myEpoch) || votedEpoch >= epoch) return false;
  if (heardLeaderAgoMs < leaseMs) return false;
  return position >= myPosition;
}

/**
 * Vote rule of a witness (unit-tested). A witness keeps no database, so it cannot compare copies;
 * instead it remembers the epoch of the last primary it heard and votes only for a server that was
 * following that very primary. A server that was switched off while the primary ran (an old copy)
 * never wins with the witness's vote.
 */
export function witnessGrantsVote({ myEpoch, votedEpoch, heardLeaderAgoMs, leaseMs, lastLeaderEpoch }, { epoch, followEpoch }) {
  if (!(epoch > myEpoch) || votedEpoch >= epoch) return false;
  if (heardLeaderAgoMs < leaseMs) return false;
  return Number.isSafeInteger(followEpoch) && followEpoch >= lastLeaderEpoch;
}

/**
 * Witness: the cheapest third server. It only votes (2 servers with data + 1 witness = a majority
 * survives the loss of any one), never becomes primary, keeps no data and serves no app.
 */
export async function startWitness({ port, host, cfg = clusterConfig() }) {
  const statePath = join(cfg.dataDir, 'witness.json');
  mkdirSync(cfg.dataDir, { recursive: true });
  let saved = { epoch: 0, votedEpoch: 0, lastLeaderEpoch: 0, leaderId: null };
  try { saved = { ...saved, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* first start */ }
  const persist = () => { writeFileSync(statePath + '.tmp', JSON.stringify(saved)); renameSync(statePath + '.tmp', statePath); };
  let heardLeaderAt = Date.now(), heartbeatAt = 0;
  const authOk = req => { const got = String(req.headers['x-cluster-token'] || ''); return timingSafeEqual(createHash('sha256').update(got).digest(), createHash('sha256').update(cfg.token).digest()); };
  const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 65536) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    // Apps must never pick a witness as their server: it always answers 503 to them, so they move
    // on to a real one. The body still says whether the witness hears a primary (for monitoring).
    // Docker's own health check asks /health?local=1 from inside the container.
    if (path === '/health' && /[?&]local=1(&|$)/.test(req.url || '') && !req.headers['x-forwarded-for']) return json(res, 200, { status: 'ok', role: 'witness' });
    if (path === '/health') return json(res, 503, { status: 'witness', role: 'witness', hearsPrimary: Date.now() - heartbeatAt < 2 * cfg.leaseMs, epoch: saved.epoch, leader: saved.leaderId });
    if (!path.startsWith('/cluster/')) { res.writeHead(503, { 'retry-after': '1', 'content-type': 'application/json' }); return res.end('{"error":"witness"}'); }
    if (!authOk(req)) return json(res, 403, { error: 'forbidden' });
    if (path === '/cluster/heartbeat') {
      const b = await body(req);
      if (!(b.epoch >= saved.epoch)) return json(res, 200, { ok: false, epoch: saved.epoch });
      if (b.epoch > saved.epoch || saved.leaderId !== b.id || saved.lastLeaderEpoch !== b.epoch) { saved.epoch = b.epoch; saved.lastLeaderEpoch = b.epoch; saved.leaderId = b.id; persist(); log(`witness: primary ${b.id} in epoch ${b.epoch}`); }
      heardLeaderAt = heartbeatAt = Date.now();
      return json(res, 200, { ok: true, epoch: saved.epoch });
    }
    if (path === '/cluster/vote') {
      const b = await body(req);
      const grant = witnessGrantsVote({ myEpoch: saved.epoch, votedEpoch: saved.votedEpoch, heardLeaderAgoMs: Date.now() - heardLeaderAt, leaseMs: cfg.leaseMs, lastLeaderEpoch: saved.lastLeaderEpoch }, b);
      if (grant) { saved.votedEpoch = b.epoch; persist(); heardLeaderAt = Date.now(); log(`witness: vote for ${b.id} in epoch ${b.epoch}`); }
      return json(res, 200, { granted: grant, epoch: saved.epoch });
    }
    if (path === '/cluster/state') return json(res, 200, { self: cfg.self, role: 'witness', epoch: saved.epoch, leader: saved.leaderId, lastLeaderEpoch: saved.lastLeaderEpoch });
    return json(res, 404, {});
  });
  await new Promise(r => server.listen(port, host, r));
  log(`witness ${cfg.self} on ${host}:${port}, lease ${cfg.leaseMs} ms`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); process.exit(0); });
  return server;
}

export async function startCluster({ port, host, cfg = clusterConfig() }) {
  if (cfg.witness) return startWitness({ port, host, cfg });
  const size = cfg.peers.length + 1;
  const dbPath = join(cfg.dataDir, 'linea.sqlite');
  const statePath = join(cfg.dataDir, 'cluster.json');
  mkdirSync(cfg.dataDir, { recursive: true });
  let saved = { epoch: 0, votedEpoch: 0, leaderId: null };
  try { saved = { ...saved, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* first start */ }
  const persist = () => { writeFileSync(statePath + '.tmp', JSON.stringify(saved)); renameSync(statePath + '.tmp', statePath); };

  let role = 'follower', leader = null /* {id,url,epoch} */, heardLeaderAt = 0, leaseUntil = 0;
  let app = null, appPort = port + 1000, child = null, childRole = null, electing = false, followFails = 0, restartAt = 0;
  // The web front (Caddy) in front of this supervisor; its X-Forwarded-For is kept.
  const frontProxies = new net.BlockList();
  for (const v of ['127.0.0.1', ...(process.env.TRUSTED_PROXIES || '').split(',').map(x => x.trim()).filter(Boolean)]) {
    const [addr, bits] = v.split('/'); const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (net.isIP(addr)) bits ? frontProxies.addSubnet(addr, Number(bits), type) : frontProxies.addAddress(addr, type);
  }
  frontProxies.addAddress('::1', 'ipv6');
  const isFront = ip => { const a = String(ip || '').replace(/^::ffff:/, ''); try { return frontProxies.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4'); } catch { return false; } };
  const peerUrl = id => cfg.peers.find(p => p.id === id)?.url;

  // ---- database position (how fresh a copy is) ----
  const position = () => {
    if (!existsSync(dbPath)) return 0;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const max = t => { try { return db.prepare(`SELECT COALESCE(MAX(rowid),0) n FROM "${t}"`).get().n; } catch { return 0; } };
        return max('messages') + max('users') + max('community_messages') + max('uploads');
      } finally { db.close(); }
    } catch { return 0; }
  };

  // ---- Litestream child: primary streams, standby follows ----
  const replicaFor = epoch => cfg.replicas.map(r => `${r.replace(/\/+$/, '')}/e${epoch}`);
  const stopChild = () => new Promise(done => {
    if (!child) return done();
    const c = child; child = null; childRole = null;
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    c.once('exit', () => { clearTimeout(t); done(); });
    try { c.kill('SIGTERM'); } catch { clearTimeout(t); done(); }
  });
  const runChild = (kind, args) => {
    const c = spawn(cfg.litestream, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', d => process.stdout.write(`[litestream ${kind}] ${d}`)); c.stderr.on('data', d => process.stdout.write(`[litestream ${kind}] ${d}`));
    const started = Date.now();
    c.on('exit', code => {
      if (child !== c) return;
      log(`litestream ${kind} exited`, code); child = null; childRole = null;
      // A follow that keeps failing (e.g. its saved position no longer matches the copy)
      // starts over from a clean restore; the watchdog in tick() restarts it.
      if (kind === 'follow') followFails = Date.now() - started < 20000 ? followFails + 1 : 1;
    });
    child = c; childRole = kind;
  };
  const setAside = tag => {
    for (const suffix of ['', '-wal', '-shm', '-txid']) if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, `${dbPath}.stale-${tag}-${Date.now()}${suffix}`);
  };
  // Storage for the copy: CLUSTER_REPLICA (s3://bucket/path or file:///dir, several separated by spaces);
  // S3-compatible providers (Timeweb, Yandex, Selectel) also need CLUSTER_S3_ENDPOINT (and CLUSTER_S3_REGION).
  // Keys come from LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY in the environment, never the file.
  const writeConfig = (name, urls) => {
    const extra = url => !url.startsWith('s3://') ? '' : (process.env.CLUSTER_S3_ENDPOINT ? `        endpoint: ${process.env.CLUSTER_S3_ENDPOINT}\n` : '') + (process.env.CLUSTER_S3_REGION ? `        region: ${process.env.CLUSTER_S3_REGION}\n` : '');
    const yml = join(cfg.dataDir, name);
    writeFileSync(yml, `dbs:\n  - path: ${dbPath}\n    replicas:\n${urls.map((url, i) => `      - name: r${i}\n        url: ${url}\n        sync-interval: 1s\n${extra(url)}`).join('')}`);
    return yml;
  };
  const startReplicate = epoch => runChild('replicate', ['replicate', '-config', writeConfig('litestream.yml', replicaFor(epoch))]);
  const startFollow = async epoch => {
    await stopChild();
    // A copy from an older epoch (or a former primary's own) is set aside, never merged.
    if (saved.followEpoch !== epoch) setAside(`e${saved.followEpoch ?? 'x'}`);
    else if (followFails >= 3) { setAside(`retry-e${epoch}`); followFails = 0; }
    saved.followEpoch = epoch; persist();
    // After repeated failures the next storage in the list is tried.
    runChild('follow', ['restore', '-f', '-follow-interval', '1s', '-config', writeConfig('litestream-follow.yml', [replicaFor(epoch)[Math.floor(followFails / 2) % cfg.replicas.length]]), '-o', dbPath, dbPath]);
  };

  // ---- the app (primary only) ----
  const startApp = async () => {
    const [{ buildApp }, { appOptions }] = await Promise.all([import('./app.js'), import('./options.js')]);
    // The app's own timed writes (scheduled messages) run only while this process holds the lease.
    app = await buildApp(appOptions({ trustProxy: ['127.0.0.1'], writable: () => role === 'leader' && Date.now() < leaseUntil }));
    await app.listen({ host: '127.0.0.1', port: appPort });
  };
  const stopApp = async () => { const a = app; app = null; if (a) await a.close().catch(() => {}); };

  const becomeLeader = async epoch => {
    log(`becoming primary in epoch ${epoch}`);
    role = 'leader'; leader = { id: cfg.self, url: cfg.selfUrl, epoch }; leaseUntil = Date.now() + cfg.leaseMs;
    await stopChild();
    saved.followEpoch = epoch; saved.leaderId = cfg.self; persist();
    await startApp();
    startReplicate(epoch);
  };
  const becomeFollower = async (next) => {
    const wasLeader = role === 'leader';
    role = 'follower'; leader = next; heardLeaderAt = Date.now();
    if (wasLeader) { log(`stepping down: primary is now ${next.id} (epoch ${next.epoch})`); await stopApp(); }
    if (childRole !== 'follow' || saved.followEpoch !== next.epoch) await startFollow(next.epoch);
  };

  // ---- peer RPC ----
  const authOk = req => { const got = String(req.headers['x-cluster-token'] || ''); const a = createHash('sha256').update(got).digest(), b = createHash('sha256').update(cfg.token).digest(); return timingSafeEqual(a, b); };
  const call = (url, path, body, timeoutMs = 1500) => new Promise(resolveCall => {
    const u = new URL(path, url); const data = JSON.stringify(body || {});
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-cluster-token': cfg.token } }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolveCall(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolveCall(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolveCall(null)); req.end(data);
  });

  // ---- election timer ----
  let electionAfter = 2 * cfg.leaseMs + Math.random() * cfg.leaseMs;
  const tick = async () => {
    const now = Date.now();
    // Watchdog: Litestream must always run (stream on the primary, follow on a standby).
    if (!child && now >= restartAt) {
      if (role === 'leader' && app) { restartAt = now + 2000; startReplicate(leader.epoch); }
      else if (role === 'follower' && leader) { restartAt = now + 2000; await startFollow(leader.epoch); }
    }
    if (role === 'leader') {
      const replies = await Promise.all(cfg.peers.map(p => call(p.url, '/cluster/heartbeat', { epoch: leader.epoch, id: cfg.self, url: cfg.selfUrl })));
      const higher = replies.find(r => r && r.epoch > leader.epoch);
      if (higher) { saved.epoch = higher.epoch; persist(); role = 'follower'; leader = null; await stopApp(); await stopChild(); return; }
      const acks = 1 + replies.filter(r => r?.ok).length;
      if (acks >= majority(size)) leaseUntil = Date.now() + cfg.leaseMs;
      return;
    }
    if (electing || now - heardLeaderAt < electionAfter) return;
    electing = true;
    try {
      const epoch = Math.max(saved.epoch, saved.votedEpoch) + 1;
      saved.votedEpoch = epoch; persist();
      const pos = position();
      log(`no primary for ${Math.round((now - heardLeaderAt) / 1000)}s, asking for votes in epoch ${epoch} (position ${pos})`);
      const votes = await Promise.all(cfg.peers.map(p => call(p.url, '/cluster/vote', { epoch, id: cfg.self, url: cfg.selfUrl, position: pos, followEpoch: saved.followEpoch ?? 0 })));
      const higher = votes.find(v => v && v.epoch > epoch);
      if (higher) { saved.epoch = higher.epoch; persist(); }
      else if (1 + votes.filter(v => v?.granted).length >= majority(size) && Date.now() - heardLeaderAt >= cfg.leaseMs) { saved.epoch = epoch; persist(); await becomeLeader(epoch); }
      electionAfter = 2 * cfg.leaseMs + Math.random() * cfg.leaseMs;
      heardLeaderAt = Math.max(heardLeaderAt, Date.now() - cfg.leaseMs); // back off before the next try
    } finally { electing = false; }
  };

  // ---- uploaded files: a standby mirrors the primary's ----
  const filesRoot = cfg.dataDir;
  const listFiles = () => {
    const out = [];
    const walk = dir => { for (const name of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, name.name); const rel = relative(filesRoot, full);
      if (name.isDirectory()) { if (!rel.startsWith('.') && !rel.startsWith('litestream') && !/^linea\.sqlite/.test(rel)) walk(full); }
      // Unfinished chunked uploads (`<id>.part`) change every few seconds and become real files only on completion.
      else if ((/^(uploads|files|bigfiles|avatars)\//.test(rel) || rel.startsWith('uploads')) && !rel.endsWith('.part')) out.push([rel, statSync(full).size]); } };
    try { walk(filesRoot); } catch { /* empty */ }
    return out;
  };
  let mirroring = false;
  const mirror = async () => {
    if (role !== 'follower' || !leader?.url || mirroring) return; mirroring = true;
    try {
      const list = await call(leader.url, '/cluster/files', {}, 5000);
      for (const [rel, size] of list?.files || []) {
        if (!/^[A-Za-z0-9._\/-]+$/.test(rel) || rel.includes('..')) continue;
        const target = join(filesRoot, rel); if (existsSync(target) && statSync(target).size === size) continue;
        mkdirSync(dirname(target), { recursive: true });
        await new Promise(done => {
          const u = new URL(`/cluster/file?path=${encodeURIComponent(rel)}`, leader.url); const lib = u.protocol === 'https:' ? https : http;
          lib.get(u, { headers: { 'x-cluster-token': cfg.token }, timeout: 30000 }, res => { if (res.statusCode !== 200) { res.resume(); return done(); }
            pipeline(res, createWriteStream(target + '.part')).then(() => { renameSync(target + '.part', target); done(); }).catch(() => { rmSync(target + '.part', { force: true }); done(); }); }).on('error', done);
        });
      }
    } finally { mirroring = false; }
  };

  // ---- public front: answers cluster RPC itself, everything else goes to the app or the primary ----
  const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 65536) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const writable = () => role === 'leader' && Date.now() < leaseUntil && !!app;
  const target = () => (role === 'leader' ? (app ? { url: `http://127.0.0.1:${appPort}`, local: true } : null) : leader?.url ? { url: leader.url, local: false } : null);
  // Headers for the app (trusts only this supervisor at 127.0.0.1, so X-Forwarded-For is exactly
  // the client) or for the primary's supervisor (the client travels in X-Cluster-Client-Ip next
  // to the token). Same for plain requests and WebSocket upgrades.
  const proxyHeaders = (req, t) => {
    const from = req.socket.remoteAddress || '';
    const ip = forwardedClientIp({ headers: req.headers, remoteAddress: from, front: isFront(from), peer: authOk(req) });
    const headers = { ...req.headers, 'x-forwarded-for': ip };
    if (t.local) { delete headers['x-cluster-token']; delete headers['x-cluster-client-ip']; }
    else { headers['x-cluster-token'] = cfg.token; headers['x-cluster-client-ip'] = ip; }
    return headers;
  };

  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path.startsWith('/cluster/')) {
      if (!authOk(req)) return json(res, 403, { error: 'forbidden' });
      if (path === '/cluster/heartbeat') {
        const b = await body(req);
        if (b.epoch < saved.epoch) return json(res, 200, { ok: false, epoch: saved.epoch });
        if (b.epoch > saved.epoch) { saved.epoch = b.epoch; persist(); }
        if (role === 'leader' && b.id !== cfg.self) await becomeFollower({ id: b.id, url: b.url, epoch: b.epoch });
        else if (!leader || leader.id !== b.id || leader.epoch !== b.epoch) await becomeFollower({ id: b.id, url: b.url, epoch: b.epoch });
        heardLeaderAt = Date.now(); leader = { id: b.id, url: b.url, epoch: b.epoch };
        return json(res, 200, { ok: true, epoch: saved.epoch });
      }
      if (path === '/cluster/vote') {
        const b = await body(req);
        const grant = role !== 'leader' && shouldGrantVote({ myEpoch: saved.epoch, votedEpoch: saved.votedEpoch, heardLeaderAgoMs: Date.now() - heardLeaderAt, leaseMs: cfg.leaseMs, myPosition: position() }, b);
        if (grant) { saved.votedEpoch = b.epoch; persist(); heardLeaderAt = Date.now(); }
        return json(res, 200, { granted: grant, epoch: Math.max(saved.epoch, role === 'leader' ? leader.epoch : 0) });
      }
      if (path === '/cluster/files' && role === 'leader') return json(res, 200, { files: listFiles() });
      if (path === '/cluster/file' && role === 'leader') {
        const rel = new URL(req.url, 'http://x').searchParams.get('path') || '';
        if (!/^[A-Za-z0-9._\/-]+$/.test(rel) || rel.includes('..') || !listFiles().some(([r]) => r === rel)) return json(res, 404, {});
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); return pipeline((await import('node:fs')).createReadStream(join(filesRoot, rel)), res).catch(() => {});
      }
      if (path === '/cluster/state') return json(res, 200, { self: cfg.self, role, epoch: saved.epoch, leader, writable: writable(), position: position() });
      return json(res, 404, {});
    }
    if (path === '/health') {
      const ok = role === 'leader' ? writable() : !!leader && Date.now() - heardLeaderAt < 2 * cfg.leaseMs;
      // Docker's own health check asks /health?local=1 from inside the container: it only says the
      // process is alive, as on a witness. A standby that hears no primary yet must still count as
      // healthy, or Caddy in front of it never starts and the primary can never reach it.
      if (/[?&]local=1(&|$)/.test(req.url || '') && !req.headers['x-forwarded-for']) return json(res, 200, { status: 'ok', role, epoch: saved.epoch, cluster: ok ? 'ok' : 'unavailable' });
      return json(res, ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable', role, epoch: saved.epoch });
    }
    const method = (req.method || 'GET').toUpperCase();
    const reads = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const ready = () => { const t = target(); return t && (reads || role !== 'leader' || writable()) ? t : null; };
    // During a switch-over (about 10–20 s) small requests wait here for the new primary instead of
    // failing; a request the primary never received is safe to send again.
    const size = Number(req.headers['content-length'] || 0);
    let payload = null;
    if (!reads) {
      if (!(size <= 4 * 1024 * 1024) || req.headers['transfer-encoding']) { if (!ready()) { res.writeHead(503, { 'retry-after': '1' }); return res.end(); } }
      else payload = await new Promise(done => { const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => done(Buffer.concat(parts))); req.on('error', () => done(null)); });
      if (payload === null && size <= 4 * 1024 * 1024 && !req.headers['transfer-encoding']) return;
    }
    const waitReady = async avoid => { for (let i = 0; i < 80; i++) { const t = ready(); if (t && t.url !== avoid) return t; await new Promise(r => setTimeout(r, 250)); } return null; };
    const forward = async (attempt, avoid) => {
      const t = await waitReady(avoid);
      if (!t) { if (!res.headersSent) res.writeHead(503, { 'retry-after': '1' }); return res.end(); }
      const u = new URL(req.url || '/', t.url); const lib = u.protocol === 'https:' ? https : http;
      const headers = proxyHeaders(req, t);
      if (!t.local) headers.host = u.host;
      let connected = false;
      const up = lib.request(u, { method, headers, timeout: 120000 }, r => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
      up.on('socket', sock => sock.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; }));
      up.on('error', () => {
        // Could not even connect: the primary is gone, so this request never reached it — wait and retry.
        if (!connected && attempt < 2 && (payload || reads) && !res.headersSent) return void forward(attempt + 1, t.url);
        if (!res.headersSent) res.writeHead(502); res.end();
      });
      up.on('timeout', () => up.destroy());
      if (payload || reads) up.end(payload || undefined); else req.pipe(up);
    };
    await forward(0, null);
  });
  server.on('upgrade', (req, socket, head) => {
    const t = target(); if (!t || (role === 'leader' && !writable())) return socket.destroy();
    const u = new URL(req.url || '/', t.url); const secure = u.protocol === 'https:';
    const headers = { ...proxyHeaders(req, t), host: u.host };
    const up = secure ? tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname }) : net.connect(Number(u.port), u.hostname);
    up.on(secure ? 'secureConnect' : 'connect', () => {
      up.write(`${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head); up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(port, host, r));
  log(`supervisor ${cfg.self} on ${host}:${port}, ${size} servers, lease ${cfg.leaseMs} ms`);

  // First start of a brand-new cluster: the server that already holds the data starts as primary.
  if (cfg.bootstrap && saved.epoch === 0) { saved.epoch = 1; saved.votedEpoch = 1; persist(); await becomeLeader(1); }
  else heardLeaderAt = Date.now();

  const timers = [setInterval(() => void tick(), 1000), setInterval(() => void mirror(), 5000)];
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await stopApp(); await stopChild(); server.close(); process.exit(0); });
  return { server, close: async () => { for (const t of timers) clearInterval(t); await stopApp(); await stopChild(); server.closeAllConnections(); await new Promise(r => server.close(() => r())); } };
}
