// Windows self-update: download this project's GitHub release installer, verify it
// against the SHA-256 the INVIZENT server published, and only then hand it to the OS.
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');

const UPDATE_PREFIX = 'https://github.com/stage3hz/linea-build/releases/download/';
const UPDATE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function createUpdater({ tempDir, fetchImpl = globalThis.fetch, prefix = UPDATE_PREFIX, hosts = UPDATE_HOSTS }) {
  const state = { received: 0, total: 0, file: null, busy: false, controller: null };
  async function download(url, sha256, size) {
    if (typeof url !== 'string' || !url.startsWith(prefix) || !url.endsWith('-Windows-x64.exe') || /[\s"'<>\\]/.test(url)) throw new Error('Invalid update URL');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw new Error('Invalid update checksum');
    if (state.busy) throw new Error('Update is already downloading');
    state.busy = true; state.received = 0; state.total = size; state.file = null;
    const target = path.join(tempDir(), `INVIZENT-update-${randomUUID()}.exe`);
    const controller = new AbortController(); state.controller = controller;
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
      if (!hosts.has(new URL(response.url).host)) throw new Error('Unexpected download host');
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
      state.file = target;
      return true;
    } catch (error) { await fs.rm(target, { force: true }).catch(() => {}); throw error; }
    finally { state.busy = false; state.controller = null; }
  }
  return {
    download,
    progress: () => ({ received: state.received, total: state.total, ready: !!state.file }),
    cancel: () => state.controller?.abort(),
    verifiedFile: () => state.file,
  };
}

module.exports = { createUpdater, UPDATE_PREFIX };
