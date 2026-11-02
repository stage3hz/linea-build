// "Is there a newer INVIZENT?" — GET /app/update.
// The owner publishes a version with deploy/release.sh, which writes
// deploy/secrets/release.json (in the container: /secrets/release.json) from the
// GitHub release and its SHA256SUMS. The app downloads the file from GitHub and
// checks the SHA-256 it got from HERE, over our own TLS connection, before it
// opens the installer. Only URLs of this project's GitHub releases are accepted,
// so a damaged manifest cannot turn the server into a download redirector.
//
// Grace period: a new version is optional for `graceHours` (default 72) after
// `releasedAt`, then it becomes mandatory on its own. The deadline is decided by
// the SERVER clock, and the version gate starts answering 426 to older builds at
// the same moment, so changing the phone's clock does not skip the update.
import { readFileSync, statSync } from 'node:fs';
import { parseVersion, versionLessThan } from './clientgate.js';

export const RELEASE_URL_PREFIX = 'https://github.com/stage3hz/linea-build/releases/download/';
const PAGE_PREFIX = 'https://github.com/stage3hz/linea-build/releases/';
export const DEFAULT_GRACE_HOURS = 72;

function asset(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new Error('asset must be an object');
  const { url, sha256, size } = value;
  if (typeof url !== 'string' || !url.startsWith(RELEASE_URL_PREFIX) || url.length > 300 || /[\s"'<>\\]/.test(url)) throw new Error('asset url must be a release of this project');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('asset sha256 must be 64 hex chars');
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw new Error('asset size is invalid');
  return { url, sha256, size };
}

/** Validates a release manifest; throws on anything unexpected. */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest must be an object');
  if (!parseVersion(raw.version)) throw new Error('version must be x.y.z');
  if (raw.minVersion !== undefined && raw.minVersion !== null && !parseVersion(raw.minVersion)) throw new Error('minVersion must be x.y.z');
  const releasedAt = raw.releasedAt === undefined || raw.releasedAt === null ? null : Date.parse(raw.releasedAt);
  if (releasedAt !== null && !Number.isFinite(releasedAt)) throw new Error('releasedAt must be an ISO date');
  const graceHours = raw.graceHours === undefined || raw.graceHours === null ? DEFAULT_GRACE_HOURS : raw.graceHours;
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 24 * 60) throw new Error('graceHours must be 0..1440');
  const page = typeof raw.page === 'string' && raw.page.startsWith(PAGE_PREFIX) && raw.page.length < 300 ? raw.page : null;
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 1000) : '';
  return { version: raw.version, minVersion: raw.minVersion || null, releasedAt, graceHours, page, notes, android: asset(raw.android), windows: asset(raw.windows) };
}

/** Highest of two optional versions. */
export function higherVersion(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa) return pb ? b : null;
  if (!pb) return a;
  return versionLessThan(pa, pb) ? b : a;
}

/** When the offered version stops being optional (ms), or null if never. */
export function requiredAt(manifest) {
  if (!manifest || manifest.releasedAt === null) return null;
  return manifest.releasedAt + manifest.graceHours * 3_600_000;
}

/** Version every client must have right now according to this manifest. */
export function manifestMinimum(manifest, nowMs) {
  if (!manifest) return null;
  const deadline = requiredAt(manifest);
  return higherVersion(manifest.minVersion, deadline !== null && nowMs >= deadline ? manifest.version : null);
}

export function createRelease({ manifestPath, minClientVersion = null, now = () => Date.now(), log = () => {} }) {
  let cached = { mtimeMs: -1, value: null };
  const load = () => {
    if (!manifestPath) return null;
    try {
      const { mtimeMs } = statSync(manifestPath);
      if (mtimeMs !== cached.mtimeMs) cached = { mtimeMs, value: validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))) };
      return cached.value;
    } catch (error) {
      if (error?.code !== 'ENOENT') log(error);
      cached = { mtimeMs: -1, value: null };
      return null;
    }
  };
  /** Minimum version for the gate: owner's MIN_CLIENT_VERSION or the expired grace period. */
  const currentMinimum = () => higherVersion(minClientVersion, manifestMinimum(load(), now()));
  const install = app => {
    app.get('/app/update', async () => {
      const manifest = load(), serverTime = new Date(now()).toISOString(), minVersion = currentMinimum();
      if (!manifest) return { version: null, minVersion, releasedAt: null, requiredAt: null, serverTime, android: null, windows: null, page: null, notes: '' };
      const deadline = requiredAt(manifest);
      return {
        version: manifest.version, minVersion, page: manifest.page, notes: manifest.notes,
        releasedAt: manifest.releasedAt === null ? null : new Date(manifest.releasedAt).toISOString(),
        requiredAt: deadline === null ? null : new Date(deadline).toISOString(),
        serverTime, android: manifest.android, windows: manifest.windows,
      };
    });
  };
  return { currentMinimum, install };
}
