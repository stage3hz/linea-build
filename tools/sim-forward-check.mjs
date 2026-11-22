// The forward check of the native apps' live run: after the app forwarded the seeded attachments (a file, a photo,
// a voice message, a small video, a long video in chunks and a round video) from one chat to the chat of the first
// seeded person (`-chataction forwardsend -forwardto simpeer0` / `--es chataction forwardsend --es forwardto
// simpeer0`), this opens that person's side — with the session and device keys tools/sim-seed.mjs kept for this
// run (SIM_SEED_FORWARD) — decrypts what arrived with the reference app's own code (mobile/src/e2ee/core.ts) and
// checks that every attachment came as a forwarded message, under a new file id and a new key, and opens to
// exactly the bytes that were seeded. Never talks to anything but the address given.
//   node tools/sim-forward-check.mjs http://127.0.0.1:<port> <state file> [seconds to wait]
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [base, stateFile, waitText] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '') || !stateFile) { console.error('usage: sim-forward-check.mjs http://127.0.0.1:<port> <state file> [seconds]'); process.exit(2); }
const root = new URL('../', import.meta.url);
process.env.LINEA_SIGNAL_TEST_TOOLS ||= new URL('desktop', root).pathname;
const support = new URL('mobile/test/support/', root);
const { loadTs } = await import(new URL('load-ts.mjs', support));
const { CryptoService, MemoryVault, sha256 } = await import(new URL('crypto-harness.mjs', support));
const { nodeSignalBridge } = await import(new URL('signal-node.mjs', support));
const { openAttachment, sha256hex } = await import(new URL('sim-files.mjs', import.meta.url));
const { Api } = loadTs(new URL('mobile/src/api.ts', root).pathname, {
  'react-native': { Platform: { OS: 'android' } }, 'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } get size() { return 0; } } }, 'expo-file-system/legacy': {}, 'expo-sharing': {},
});

const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const wanted = Object.entries(state.wanted || {});
if (!wanted.length) { console.error('forward check: nothing was seeded to look for'); process.exit(1); }
const api = new Api(base, state.token);
const service = new CryptoService(state.userId, api, nodeSignalBridge, new MemoryVault(new Map(state.vault)), randomUUID, sha256, { autoTrust: true });
await service.initialize();

// The app may still be sending when this starts: look again for a while.
const deadline = Date.now() + Number(waitText || 90) * 1000;
let arrived = new Map();
for (;;) {
  await service.syncChat(state.chatId, 50);
  const items = await service.history(state.chatId);
  arrived = new Map(items.filter(item => item.attachment && item.meta?.forward).map(item => [item.attachment.name, item]));
  if (wanted.every(([name]) => arrived.has(name)) || Date.now() > deadline) break;
  await new Promise(resolve => setTimeout(resolve, 3000));
}

let failed = 0;
for (const [name, seeded] of wanted) {
  const item = arrived.get(name);
  if (!item) { console.log(`MISSING  ${name}: no forwarded message with it reached @${state.username}`); failed++; continue; }
  const attachment = item.attachment;
  const problems = [];
  if (attachment.id === seeded.id) problems.push('the same file id as the original (the server must refuse that)');
  if (attachment.encryption?.key === seeded.key) problems.push('the same key as the original');
  let bytes = null;
  try { bytes = await openAttachment(nodeSignalBridge, base, api.authHeaders, attachment); }
  catch (error) { problems.push(`does not open: ${error.message}`); }
  if (bytes && sha256hex(bytes) !== seeded.sha256) problems.push('opens to other bytes');
  if (!item.meta.forward.from) problems.push('no «Переслано от …» author');
  console.log(`${problems.length ? 'BAD     ' : 'OK      '} ${name} (${attachment.encryption?.scheme}, ${attachment.size} bytes, from «${item.meta.forward.from}»)${problems.length ? ': ' + problems.join('; ') : ''}`);
  if (problems.length) failed++;
}
await service.close();
console.log(failed ? `forward check FAILED: ${failed} of ${wanted.length}` : `forward check passed: ${wanted.length} of ${wanted.length}`);
process.exit(failed ? 1 : 0);
