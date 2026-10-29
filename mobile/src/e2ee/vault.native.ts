import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { PrivateVault } from './types';

// The SQLCipher key is unrelated to the password and the two account words.
// A missing/corrupt key never silently creates a replacement identity.
export async function openVault(server: string, userId: string): Promise<PrivateVault> {
  const scope = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${server}\u0000${userId}`);
  const keyName = `linea.e2ee.v1.${scope}`;
  let key = await SecureStore.getItemAsync(keyName);
  const db = await SQLite.openDatabaseAsync(`linea-e2ee-${scope}.db`, { useNewConnection: true });
  try {
    const cipher = await db.getFirstAsync<Record<string, string>>('PRAGMA cipher_version');
    if (!cipher || !Object.values(cipher).some(value => typeof value === 'string' && value.length > 0)) {
      throw new Error('Сборка не поддерживает SQLCipher. Незашифрованное хранение ключей отключено.');
    }
    if (!key) {
      key = Array.from(await Crypto.getRandomBytesAsync(32), byte => byte.toString(16).padStart(2, '0')).join('');
      // If an existing encrypted database has lost its key, the following read
      // fails, leaving the database intact rather than overwriting its contents.
      await db.execAsync(`PRAGMA key = "x'${key}'";`);
      await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
      await SecureStore.setItemAsync(keyName, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } else {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Повреждён ключ локального хранилища.');
      await db.execAsync(`PRAGMA key = "x'${key}'";`);
    }
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS private_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  } catch (error) {
    await db.closeAsync().catch(() => {});
    if (error instanceof Error && error.message.includes('SQLCipher')) throw error;
    throw new Error('Не удалось открыть зашифрованное хранилище. Ключи и сообщения сохранены без изменений.');
  }
  let closed = false;
  let writes: Promise<void> = Promise.resolve();
  return {
    async get(name) {
      if (closed) throw new Error('Хранилище закрыто.');
      return (await db.getFirstAsync<{ value: string }>('SELECT value FROM private_values WHERE key = ?', name))?.value ?? null;
    },
    // Writes run on THIS keyed connection. expo-sqlite's withExclusiveTransactionAsync
    // opens a second connection that never receives PRAGMA key, so SQLCipher
    // rejects it with "file is not a database". Commits are queued so two
    // transactions never interleave on the shared connection.
    commit(values) {
      if (closed) return Promise.reject(new Error('Хранилище закрыто.'));
      const run = writes.then(async () => {
        if (closed) throw new Error('Хранилище закрыто.');
        await db.execAsync('BEGIN IMMEDIATE');
        try {
          for (const [name, value] of Object.entries(values)) {
            if (value === null) await db.runAsync('DELETE FROM private_values WHERE key = ?', name);
            else await db.runAsync('INSERT INTO private_values (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', name, value);
          }
          await db.execAsync('COMMIT');
        } catch (error) {
          await db.execAsync('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      writes = run.catch(() => {});
      return run;
    },
    async close() { if (!closed) { closed = true; await writes; await db.closeAsync(); } },
  };
}
