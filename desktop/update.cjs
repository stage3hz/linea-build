// Windows self-update: download this project's GitHub release installer, verify it
// against the SHA-256 the INVIZENT server published, and only then hand it to the OS.
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');

const UPDATE_PREFIX = 'https://github.com/stage3hz/linea-build/releases/download/';
const UPDATE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** The update must be a release asset of this project: the address is parsed, not compared as text — «…/download/
 *  ../../../other/repo/…» passed a plain prefix check and normalised to another repository. */
function releaseAsset(url, prefix) {
  if (typeof url !== 'string' || /[\s"'<>\\%]/.test(url) || url.includes('..')) return false;
  let parsed, base;
  try { parsed = new URL(url); base = new URL(prefix); } catch { return false; }
  // The prefix is https in the app (UPDATE_PREFIX); tests use a local http server.
  return parsed.href === url && parsed.protocol === base.protocol && parsed.host === base.host && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.pathname.startsWith(base.pathname) && parsed.pathname.endsWith('-Windows-x64.exe');
}

/** Follows redirects by hand: every hop, not only the last one, must stay on the same scheme (https in the app) and
 *  on an allowed host. */
async function fetchAllowed(fetchImpl, url, hosts, signal) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetchImpl(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      // A fetch that followed redirects anyway (a test double, an older runtime) is still held to the allowlist.
      if (response.url && !hosts.has(new URL(response.url).host)) throw new Error('Unexpected download host');
      return response;
    }
    const next = new URL(response.headers.get('location') || '', current);
    if (next.protocol !== new URL(url).protocol || !hosts.has(next.host)) throw new Error('Unexpected download host');
    current = next.href;
  }
  throw new Error('Too many redirects');
}

function createUpdater({ tempDir, fetchImpl = globalThis.fetch, prefix = UPDATE_PREFIX, hosts = UPDATE_HOSTS }) {
  const state = { received: 0, total: 0, file: null, sha256: null, busy: false, controller: null };
  async function download(url, sha256, size) {
    if (!releaseAsset(url, prefix)) throw new Error('Invalid update URL');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw new Error('Invalid update checksum');
    if (state.busy) throw new Error('Update is already downloading');
    state.busy = true; state.received = 0; state.total = size; state.file = null; state.sha256 = null;
    // A folder of its own (owner-only), not the shared temp root.
    const folder = await fs.mkdtemp(path.join(tempDir(), 'INVIZENT-update-'));
    const target = path.join(folder, `INVIZENT-${randomUUID()}-Windows-x64.exe`);
    const controller = new AbortController(); state.controller = controller;
    try {
      const response = await fetchAllowed(fetchImpl, url, hosts, controller.signal);
      if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
      const hash = createHash('sha256'), out = createWriteStream(target, { mode: 0o600 });
      try {
        for await (const chunk of response.body) {
          state.received += chunk.length;
          if (state.received > size) throw new Error('File is larger than published');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        }
      } finally { await new Promise(resolve => out.end(resolve)); }
      if (state.received !== size || hash.digest('hex') !== sha256) throw new Error('Checksum mismatch: the file was damaged or replaced');
      state.file = target; state.sha256 = sha256;
      return true;
    } catch (error) { await fs.rm(folder, { recursive: true, force: true }).catch(() => {}); throw error; }
    finally { state.busy = false; state.controller = null; }
  }
  return {
    download,
    progress: () => ({ received: state.received, total: state.total, ready: !!state.file }),
    cancel: () => state.controller?.abort(),
    verifiedFile: () => state.file,
    /** The file to launch, hashed again right before the launch (it has been lying on disk since the download). */
    async fileForLaunch() {
      if (!state.file || !state.sha256) return null;
      const hash = createHash('sha256');
      try { hash.update(await fs.readFile(state.file)); } catch { state.file = null; return null; }
      if (hash.digest('hex') !== state.sha256) { const gone = state.file; state.file = null; await fs.rm(path.dirname(gone), { recursive: true, force: true }).catch(() => {}); return null; }
      return state.file;
    },
  };
}

module.exports = { createUpdater, UPDATE_PREFIX, releaseAsset };
