import { createHmac } from 'node:crypto';

// Short-lived TURN credentials for calls (coturn «use-auth-secret», RFC draft "REST API for TURN").
// Media itself stays end-to-end encrypted (DTLS-SRTP); the relay only forwards ciphertext.
export const TURN_TTL_SECONDS = 6 * 60 * 60;
const PUBLIC_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

export function turnCredentials({ secret, host, userId, nowMs }) {
  const username = `${Math.floor(nowMs / 1000) + TURN_TTL_SECONDS}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return {
    iceServers: [
      { urls: [`stun:${host}:3478`, ...PUBLIC_STUN] },
      { urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential },
    ],
    ttl: TURN_TTL_SECONDS,
  };
}

export function installCallRoutes({ app, authOptions, now, turn }) {
  app.get('/calls/ice', authOptions, async request => {
    if (!turn?.secret || !turn?.host) return { iceServers: [{ urls: PUBLIC_STUN }], ttl: TURN_TTL_SECONDS };
    return turnCredentials({ secret: turn.secret, host: turn.host, userId: request.auth.user_id, nowMs: now() });
  });
}
