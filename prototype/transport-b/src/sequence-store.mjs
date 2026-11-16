/**
 * SQLite-backed, per-device monotonic offer sequence numbers.
 * Reuses node:sqlite as the INVIZENT server does. This is separate from the
 * primary user database and is not mounted inside the mobile application.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const DEVICE = /^[A-Za-z0-9_-]{8,96}$/;

export function openSequenceStore(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename)) {
    throw new TypeError('sequence database filename must be absolute');
  }
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    db.exec('PRAGMA busy_timeout=5000;');
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS lease_sequences (device_id TEXT PRIMARY KEY NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0))');
    const advance = db.prepare('INSERT INTO lease_sequences (device_id, sequence) VALUES (?, 1) ON CONFLICT(device_id) DO UPDATE SET sequence=sequence+1 RETURNING sequence');
    return {
      /** A new value is committed before an offer is signed; skipped values are fine. */
      async nextSequence(deviceId) {
        if (typeof deviceId !== 'string' || !DEVICE.test(deviceId)) throw new TypeError('invalid device ID');
        const value = advance.get(deviceId)?.sequence;
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('invalid sequence');
        return value;
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
