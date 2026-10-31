import { createPrivateKey, createSign } from 'node:crypto';
import { connect as http2Connect } from 'node:http2';
import { readFileSync } from 'node:fs';

/**
 * Push notifications through Firebase Cloud Messaging (HTTP v1). The service account key stays
 * on the server (FCM_SERVICE_ACCOUNT = path to its JSON). Message text is end-to-end encrypted and
 * never sent: a notification carries only the sender's name and «Новое сообщение» / «Звонок».
 */
export const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens(user_id);
`;

const base64url = value => Buffer.from(value).toString('base64url');

/** Older databases allowed only Android tokens: rebuild the table once so iPhone tokens fit. */
export function migratePushTokens(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='push_tokens'").get();
  if (!row || row.sql.includes("'ios'")) return;
  db.exec(`BEGIN;
ALTER TABLE push_tokens RENAME TO push_tokens_old;
DROP INDEX IF EXISTS push_tokens_user;
${PUSH_SCHEMA}
INSERT INTO push_tokens(token,user_id,session_hash,platform,updated_at) SELECT token,user_id,session_hash,platform,updated_at FROM push_tokens_old;
DROP TABLE push_tokens_old;
COMMIT;`);
}

export function loadServiceAccount(path) {
  if (!path) return null;
  const account = JSON.parse(readFileSync(path, 'utf8'));
  if (!account.client_email || !account.private_key || !account.project_id) throw new Error('FCM_SERVICE_ACCOUNT: не тот файл (нужен ключ сервисного аккаунта Firebase).');
  return account;
}

/**
 * iPhone push straight through Apple (APNs, token auth). APNS_CREDENTIALS = path to a JSON file
 * {keyId, teamId, bundleId, key} written by deploy/apns.sh from the .p8 key; it never leaves the server.
 */
export function loadApnsCredentials(path) {
  if (!path) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[A-Z0-9]{10}$/.test(value.keyId || '') || !/^[A-Z0-9]{10}$/.test(value.teamId || '') || !value.bundleId || !String(value.key || '').includes('PRIVATE KEY')) throw new Error('APNS_CREDENTIALS: нужен JSON с keyId, teamId, bundleId и ключом .p8.');
  createPrivateKey(value.key);
  return value;
}

const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

/** One HTTP/2 request to APNs; resolves to { status, reason }. */
function apnsRequest(host, path, headers, body, connect) {
  return new Promise((resolve, reject) => {
    const session = connect(host);
    session.on('error', reject);
    const request = session.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0, data = '';
    request.setEncoding('utf8');
    request.on('response', response => { status = Number(response[':status']); });
    request.on('data', chunk => { data += chunk; });
    request.on('end', () => { session.close(); let reason = ''; try { reason = JSON.parse(data || '{}').reason || ''; } catch {} resolve({ status, reason }); });
    request.on('error', error => { session.close(); reject(error); });
    request.setTimeout(15000, () => { request.close(); session.close(); reject(new Error('APNs timeout')); });
    request.end(body);
  });
}

/**
 * Returns send(token, message) for iPhone tokens, or null without credentials. The message is the
 * one chatNotification builds; its `apns` part goes to Apple. A build signed with a development
 * profile only gets pushes from the sandbox gateway, so a token that production rejects is tried
 * there and remembered.
 */
export function createApns(credentials, { connect = http2Connect, now = Date.now } = {}) {
  if (!credentials) return null;
  const key = createPrivateKey(credentials.key);
  let cached = null; const sandboxTokens = new Set();
  const jwt = () => {
    // Apple wants a fresh token at most every 20 minutes and at least every hour.
    if (cached && now() - cached.at < 40 * 60 * 1000) return cached.value;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
    const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(now() / 1000) }));
    const signature = createSign('SHA256').update(`${header}.${claims}`).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { value: `${header}.${claims}.${signature}`, at: now() };
    return cached.value;
  };
  return async (token, message) => {
    const apns = message.apns || {};
    const body = JSON.stringify(apns.payload || {});
    const headers = { authorization: `bearer ${jwt()}`, 'apns-topic': credentials.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10', ...(apns.headers || {}) };
    const send = environment => apnsRequest(APNS_HOSTS[environment], `/3/device/${token}`, headers, body, connect);
    let result = await send(sandboxTokens.has(token) ? 'sandbox' : 'production');
    if (result.status === 400 && result.reason === 'BadDeviceToken' && !sandboxTokens.has(token)) {
      const second = await send('sandbox');
      if (second.status === 200) sandboxTokens.add(token);
      result = second;
    }
    if (result.status === 200) return 'ok';
    if (result.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(result.reason)) return 'gone';
    if (result.status === 403 && result.reason === 'ExpiredProviderToken') cached = null;
    return 'error';
  };
}

/** Routes a token to Firebase (Android) or Apple (iPhone); null when neither is configured. */
export function createPush({ android = null, ios = null } = {}) {
  if (!android && !ios) return null;
  const send = async (token, message, platform = 'android') => {
    const target = platform === 'ios' ? ios : android;
    return target ? target(token, message) : 'error';
  };
  send.platforms = { android: !!android, ios: !!ios };
  return send;
}

/** Returns send(token, message) or null when push is not configured. */
export function createFcm(account, { fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!account) return null;
  let cached = null;
  const accessToken = async () => {
    if (cached && cached.expires > now() + 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: account.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(account.private_key).toString('base64url');
    const response = await fetchImpl(account.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
    });
    if (!response.ok) throw new Error(`FCM auth ${response.status}`);
    const result = await response.json();
    cached = { token: result.access_token, expires: now() + (result.expires_in || 3600) * 1000 };
    return cached.token;
  };
  /** Resolves to 'ok', 'gone' (token no longer valid — delete it) or 'error'. */
  return async (token, message) => {
    const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { ...message, token } }),
    });
    if (response.ok) return 'ok';
    const text = await response.text().catch(() => '');
    if (response.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) return 'gone';
    if (response.status === 400 && /INVALID_ARGUMENT/.test(text) && /token/i.test(text)) return 'gone';
    return 'error';
  };
}

const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

/** The FCM message for a chat notification (no message content — it is end-to-end encrypted). */
export function chatNotification({ chatId, senderName, kind, unread }) {
  const call = kind === 'call';
  const body = call ? '📞 Входящий звонок' : unread > 1 ? `${unread} ${plural(unread, 'новое сообщение', 'новых сообщения', 'новых сообщений')}` : 'Новое сообщение';
  return {
    data: { chatId, kind },
    android: {
      priority: 'high',
      ...(call ? { ttl: '45s' } : { collapse_key: chatId }),
      notification: { title: senderName, body, tag: call ? `call:${chatId}` : chatId, channel_id: call ? 'calls' : 'messages', icon: 'notification_icon', color: '#4C7DFF', sound: 'default' },
    },
    // iPhone: the same shape FCM v1 uses for its `apns` field, sent to Apple directly.
    apns: {
      headers: { ...(call ? { 'apns-expiration': String(Math.floor(Date.now() / 1000) + 45) } : { 'apns-collapse-id': chatId.slice(0, 64) }) },
      payload: { aps: { alert: { title: senderName, body }, sound: 'default', 'thread-id': chatId, ...(call ? { 'interruption-level': 'time-sensitive' } : {}) }, chatId, kind },
    },
  };
}

export const PUSH_KINDS = new Set(['message', 'call', 'none']);
