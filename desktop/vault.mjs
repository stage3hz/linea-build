import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
/** Windows protects the random vault key with DPAPI. There is no plaintext fallback. */
export async function openDesktopVault(root, scope, storage) {
  if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Защищённое хранилище ОС недоступно.');
  const folder = path.join(root, createHash('sha256').update(scope).digest('hex'));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const dataFile = path.join(folder, 'vault.bin'), keyFile = path.join(folder, 'key.bin');
  let key;
  try { key = Buffer.from(storage.decryptString(await readFile(keyFile)), 'base64'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await readFile(dataFile); throw new Error('Потерян ключ хранилища; существующие данные сохранены.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    key = randomBytes(32);
    const handle = await open(keyFile, 'wx', 0o600);
    try { await handle.writeFile(storage.encryptString(key.toString('base64'))); await handle.sync(); } finally { await handle.close(); }
  }
  if (key.length !== 32) throw new Error('Повреждён ключ хранилища.');
  let values = Object.create(null);
  try {
    const bytes = await readFile(dataFile);
    if (bytes.subarray(0, 4).toString() !== 'IVZ1' || bytes.length < 32) throw new Error('Повреждено хранилище.');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4,16)); cipher.setAuthTag(bytes.subarray(16,32));
    cipher.setAAD(Buffer.from(scope));
    values = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]).toString());
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let writes = Promise.resolve(), closed = false;
  return {
    async get(name) { await writes; if (closed) throw new Error('Vault closed'); return Object.hasOwn(values, name) ? values[name] : null; },
    commit(changes) {
      if (closed) return Promise.reject(new Error('Vault closed'));
      const run = writes.then(async () => {
        const next = Object.assign(Object.create(null), values);
        for (const [name, value] of Object.entries(changes)) { if (value === null) delete next[name]; else if (typeof value === 'string') next[name] = value; else throw new Error('Invalid vault value'); }
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(scope));
        const data = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
        const temp = `${dataFile}.${randomBytes(8).toString('hex')}.tmp`;
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(Buffer.concat([Buffer.from('IVZ1'), nonce, cipher.getAuthTag(), data])); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, dataFile); values = next;
      });
      writes = run.catch(() => {}); return run;
    },
    async close() { closed = true; await writes; key.fill(0); values = Object.create(null); },
  };
}
