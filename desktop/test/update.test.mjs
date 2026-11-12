import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { createUpdater } = createRequire(import.meta.url)('../update.cjs');

const body = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
const sha = createHash('sha256').update(body).digest('hex');

async function harness(t) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect-away')) { res.writeHead(302, { location: 'http://127.0.0.2:1/evil' }); return res.end(); }
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inv-update-'));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const updater = createUpdater({ tempDir: () => dir, prefix: base, hosts: new Set([`127.0.0.1:${server.address().port}`]) });
  return { base, dir, updater };
}

test('a file matching the published SHA-256 becomes the verified installer', async t => {
  const { base, updater } = await harness(t);
  assert.equal(await updater.download(`${base}v1/INVIZENT-1.0.0-Windows-x64.exe`, sha, body.length), true);
  assert.ok(existsSync(updater.verifiedFile()));
  assert.deepEqual(updater.progress(), { received: body.length, total: body.length, ready: true });
});

test('a damaged or replaced file is deleted and never offered for install', async t => {
  const { base, dir, updater } = await harness(t);
  await assert.rejects(updater.download(`${base}v1/INVIZENT-1.0.0-Windows-x64.exe`, 'b'.repeat(64), body.length), /Checksum mismatch/);
  assert.equal(updater.verifiedFile(), null);
  assert.deepEqual(await readdir(dir), [], 'no partial file left behind');
  await assert.rejects(updater.download(`${base}v1/INVIZENT-1.0.0-Windows-x64.exe`, sha, body.length - 1), /larger than published/);
});

test('only this project\'s release installers are accepted', async t => {
  const { base, updater } = await harness(t);
  await assert.rejects(updater.download('https://evil.example/INVIZENT-1.0.0-Windows-x64.exe', sha, 10), /Invalid update URL/);
  await assert.rejects(updater.download(`${base}v1/payload.bat`, sha, 10), /Invalid update URL/);
  await assert.rejects(updater.download(`${base}v1/INVIZENT-1.0.0-Windows-x64.exe`, 'nothex', 10), /Invalid update checksum/);
  await assert.rejects(updater.download(`${base}redirect-away/INVIZENT-1.0.0-Windows-x64.exe`, sha, body.length));
});

test('the address is parsed, not compared as text: a path that climbs out of the project is refused', async () => {
  const { releaseAsset, UPDATE_PREFIX: P } = createRequire(import.meta.url)('../update.cjs');
  assert.equal(releaseAsset(`${P}v0.14.14/INVIZENT-0.14.14-Windows-x64.exe`, P), true);
  assert.equal(releaseAsset(`${P}../../../evil/r/releases/download/v/x-Windows-x64.exe`, P), false, 'normalises to another repository');
  assert.equal(releaseAsset('https://github.com/stage3hz/evil/releases/download/v/x-Windows-x64.exe', P), false);
  assert.equal(releaseAsset(`${P}v/%2e%2e/x-Windows-x64.exe`, P), false);
  assert.equal(releaseAsset(`${P.replace('github.com', 'github.com@evil.example')}v/x-Windows-x64.exe`, P), false);
  assert.equal(releaseAsset(`${P.replace('https:', 'http:')}v/x-Windows-x64.exe`, P), false);
  assert.equal(releaseAsset(`${P}v/x-Windows-x64.exe?x=1`, P), false);
});

test('the installer is hashed again right before it is launched', async t => {
  const { base, updater } = await harness(t);
  await updater.download(`${base}v1/INVIZENT-1.0.0-Windows-x64.exe`, sha, body.length);
  const file = updater.verifiedFile();
  assert.equal(await updater.fileForLaunch(), file);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, 'swapped');
  assert.equal(await updater.fileForLaunch(), null, 'a file changed after the download is never launched');
  assert.equal(existsSync(file), false);
});
