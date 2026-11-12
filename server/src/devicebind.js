// A session bound to a device key.
//
// The session token lives on the device's disk (protected by the OS, but readable by any program that runs as the
// same user — a «stealer»). Bound sessions make that token useless on its own: the device also holds a P-256 key
// that cannot be copied off it (TPM / Secure Enclave / Android Keystore, or the OS vault where there is no such
// chip), and every request must carry a short-lived proof that only the holder of that key can obtain.
//
//   1. POST /auth/device/challenge            → { challenge, sessionId, bound }
//   2. POST /auth/device/bind  (first time)   → the session takes the public key; the signature proves possession
//      POST /auth/device/proof (afterwards)   → a signature of the challenge by the bound key
//      both answer { proof, expiresIn }: a random value valid for PROOF_TTL_MS, kept in memory by the app
//   3. every other request of a bound session carries it in X-Linea-Proof (the socket: in its `auth` frame)
//
// A session without a key (an older app) works as before; once bound, a session is never unbound or re-bound.
// Several devices work side by side: each has its own session and its own key.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { fail, objectBody } from './security.js';

export const PROOF_TTL_MS = 10 * 60_000;
/** The previous proof stays good this long after a new one is issued (requests already on their way). */
export const PROOF_GRACE_MS = 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;
export const PROOF_HEADER = 'x-linea-proof';
export const PROOF_REQUIRED = { code: 'device_proof' };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KINDS = new Set(['hardware', 'software']);

/** The public key as the app sends it: base64url of the 65-byte uncompressed P-256 point (04 ‖ X ‖ Y). */
export function devicePublicKey(value) {
  if (typeof value !== 'string' || value.length !== 87 || !BASE64URL.test(value)) return null;
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) return null;
  try {
    return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  } catch { return null; } // not a point of the curve
}

/** What the device signs. The purpose and the session are part of it: a signature made to bind one session
 *  cannot be replayed as a proof, nor for another session. */
export const deviceMessage = (purpose, sessionId, challenge) => Buffer.from(`invizent-device-${purpose}-v1\n${sessionId}\n${challenge}`, 'utf8');

/** ECDSA P-256 / SHA-256, as the platforms produce it: DER (iOS, Android, Node) or raw r‖s (Windows CNG). */
export function deviceSignatureValid(key, message, signature) {
  if (!key || typeof signature !== 'string' || signature.length < 80 || signature.length > 100 || !BASE64URL.test(signature)) return false;
  const bytes = Buffer.from(signature, 'base64url');
  for (const dsaEncoding of bytes.length === 64 ? ['ieee-p1363', 'der'] : ['der']) {
    try { if (verify('sha256', message, { key, dsaEncoding }, bytes)) return true; } catch { /* not this encoding */ }
  }
  return false;
}

const proofHash = proof => createHash('sha256').update(proof, 'utf8').digest('hex');
const sameHash = (a, b) => typeof a === 'string' && a.length === 64 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Whether a bound session's request carries a proof that is still good. `session`: the row with its proof columns. */
export function proofAccepted(session, proof, now) {
  if (typeof proof !== 'string' || proof.length !== 43 || !BASE64URL.test(proof)) return false;
  const hash = proofHash(proof);
  return (Number(session.proof_expires_at) > now && sameHash(session.proof_hash, hash))
    || (Number(session.proof_prev_expires_at) > now && sameHash(session.proof_prev_hash, hash));
}

/** The columns a bound session needs; added to an existing database on start. */
export function migrateDeviceBinding(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name));
  for (const [column, type] of [['bind_key', 'TEXT'], ['bind_kind', 'TEXT'], ['bind_challenge', 'TEXT'], ['bind_challenge_expires_at', 'INTEGER'],
    ['proof_hash', 'TEXT'], ['proof_expires_at', 'INTEGER'], ['proof_prev_hash', 'TEXT'], ['proof_prev_expires_at', 'INTEGER']]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${type}`);
  }
}

export function installDeviceBinding({ app, db, now, authOptions, limiter }) {
  const row = request => db.prepare('SELECT id,token_hash,bind_key,bind_kind,bind_challenge,bind_challenge_expires_at,proof_hash,proof_expires_at FROM sessions WHERE token_hash=? AND expires_at>?')
    .get(request.auth.token_hash, now()) || fail(401, 'Войдите в аккаунт заново.');
  const throttle = session => { if (!limiter.allow(`device-proof:${session.id}`, 30, 60_000)) fail(429, 'Слишком много запросов. Попробуйте через минуту.'); };
  const stale = () => fail(409, 'Запрос подтверждения устарел. Повторите.', { code: 'device_challenge' });
  const challengeOf = session => (session.bind_challenge && Number(session.bind_challenge_expires_at) > now() ? session.bind_challenge : stale());
  /** A new proof; the current one stays good for PROOF_GRACE_MS. The challenge is used up by the same write (its
   *  value is in the WHERE: of two answers to one challenge only the first is taken). */
  const issue = (session, extra = '', values = [], condition = '') => {
    const proof = randomBytes(32).toString('base64url');
    const current = Number(session.proof_expires_at) > now() && session.proof_hash ? session.proof_hash : null;
    const changed = db.prepare(`UPDATE sessions SET bind_challenge=NULL,bind_challenge_expires_at=NULL,proof_prev_hash=?,proof_prev_expires_at=?,proof_hash=?,proof_expires_at=?${extra} WHERE token_hash=? AND bind_challenge=?${condition}`)
      .run(current, current ? Math.min(Number(session.proof_expires_at), now() + PROOF_GRACE_MS) : null, proofHash(proof), now() + PROOF_TTL_MS, ...values, session.token_hash, session.bind_challenge).changes;
    if (!changed) stale();
    return { proof, expiresIn: PROOF_TTL_MS / 1000 };
  };

  app.post('/auth/device/challenge', authOptions, async request => {
    const session = row(request);
    throttle(session);
    const challenge = randomBytes(32).toString('base64url');
    db.prepare('UPDATE sessions SET bind_challenge=?,bind_challenge_expires_at=? WHERE token_hash=?').run(challenge, now() + CHALLENGE_TTL_MS, session.token_hash);
    return { challenge, sessionId: session.id, bound: !!session.bind_key };
  });

  app.post('/auth/device/bind', authOptions, async request => {
    const session = row(request);
    throttle(session);
    const body = objectBody(request.body, ['publicKey', 'kind', 'signature']);
    if (session.bind_key) fail(409, 'Это устройство уже привязано.', { code: 'device_bound' });
    const key = devicePublicKey(body.publicKey);
    if (!key || !KINDS.has(body.kind)) fail(400, 'Некорректный ключ устройства.');
    if (!deviceSignatureValid(key, deviceMessage('bind', session.id, challengeOf(session)), body.signature)) fail(403, 'Подпись устройства не подтверждена.', { code: 'device_signature' });
    // Never re-bound: the key is written only while the session has none.
    return issue(session, ',bind_key=?,bind_kind=?', [body.publicKey, body.kind], ' AND bind_key IS NULL');
  });

  app.post('/auth/device/proof', authOptions, async request => {
    const session = row(request);
    throttle(session);
    const body = objectBody(request.body, ['signature']);
    if (!session.bind_key) fail(409, 'Устройство не привязано.', { code: 'device_unbound' });
    if (!deviceSignatureValid(devicePublicKey(session.bind_key), deviceMessage('proof', session.id, challengeOf(session)), body.signature)) fail(403, 'Подпись устройства не подтверждена.', { code: 'device_signature' });
    return issue(session);
  });
}
