import { createSign } from 'node:crypto';
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
  platform TEXT NOT NULL CHECK(platform IN ('android')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens(user_id);
`;

const base64url = value => Buffer.from(value).toString('base64url');

export function loadServiceAccount(path) {
  if (!path) return null;
  const account = JSON.parse(readFileSync(path, 'utf8'));
  if (!account.client_email || !account.private_key || !account.project_id) throw new Error('FCM_SERVICE_ACCOUNT: не тот файл (нужен ключ сервисного аккаунта Firebase).');
  return account;
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
  };
}

export const PUSH_KINDS = new Set(['message', 'call', 'none']);
