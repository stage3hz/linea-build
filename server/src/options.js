import { resolve } from 'node:path';
import { createApns, createFcm, createPush, loadApnsCredentials, loadServiceAccount } from './push.js';
import { createSoundCloud, loadSoundCloudCredentials } from './soundcloud.js';

// Server settings from the environment (shared by the single server and the cluster supervisor).
export function integerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}: invalid integer`);
  return value;
}

const ttlDays = integerEnv('SESSION_TTL_DAYS', 30, 1, 90);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
for (const origin of allowedOrigins) {
  if (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) throw new Error('ALLOWED_ORIGINS: use exact http(s) origins without paths');
}
const trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
if (trustedProxies.some(value => ['*', 'true', 'false'].includes(value))) throw new Error('TRUSTED_PROXIES: list only trusted proxy IPs or CIDRs');

// Push. Android through Firebase: FCM_SERVICE_ACCOUNT = path to the service account JSON.
// iPhone straight through Apple: APNS_CREDENTIALS = path to the JSON deploy/apns.sh writes from the .p8 key.
const push = createPush({
  android: createFcm(loadServiceAccount(process.env.FCM_SERVICE_ACCOUNT || '')),
  ios: createApns(loadApnsCredentials(process.env.APNS_CREDENTIALS || '')),
});

// SoundCloud (official API): SOUNDCLOUD_CREDENTIALS = path to {client_id, client_secret} on this server.
const soundcloud = createSoundCloud(loadSoundCloudCredentials(process.env.SOUNDCLOUD_CREDENTIALS || ''), { dailyLimit: integerEnv('SOUNDCLOUD_DAILY_PLAYS', 1500, 1, 1000000) });

export function appOptions(overrides = {}) {
  return {
  push,
  soundcloud,
  dataDir: resolve(process.env.DATA_DIR || 'data'),
  logger: { level: process.env.LOG_LEVEL || 'info' },
  allowedOrigins,
  trustProxy: trustedProxies.length ? trustedProxies : false,
  // Shared secret of the Cloudflare reserve entrance (deploy/edge.sh); empty = no edge.
  edgeSecret: process.env.EDGE_SECRET || '',
  sessionTtlMs: ttlDays * 24 * 60 * 60 * 1000,
  authRateLimit: integerEnv('AUTH_RATE_LIMIT', 20, 1, 1000),
  // Storage: 2 GB per account, 15 GB with Platina (src/bigfiles.js). USER_STORAGE_MIB only adds a lower cap.
  maxStoredBytesPerUser: process.env.USER_STORAGE_MIB ? integerEnv('USER_STORAGE_MIB', 512, 20, 102400) * 1024 * 1024 : null,
  diskReserveBytes: integerEnv('DISK_RESERVE_MIB', 5120, 0, 1048576) * 1024 * 1024,
  // AI_PROVIDER=freellmapi uses a self-hosted FreeLLMAPI router; default stays OpenRouter.
  aiApiKey: (process.env.AI_PROVIDER === 'freellmapi' ? process.env.AI_API_KEY : process.env.OPENROUTER_API_KEY) || '',
  turn: process.env.TURN_SECRET ? { secret: process.env.TURN_SECRET, host: process.env.TURN_HOST || '' } : null,
  aiProviderConfig: { provider: process.env.AI_PROVIDER || 'openrouter', baseUrl: process.env.AI_BASE_URL || '', model: process.env.AI_MODEL || '' },
  // Refuse clients older than MIN_CLIENT_VERSION (x.y.z). Unset = allow all.
  minClientVersion: process.env.MIN_CLIENT_VERSION || null,
  requireClientHeader: process.env.REQUIRE_CLIENT_HEADER === '1',
  // Request signing: ATTEST_KEY (same as the one baked into builds) + ATTEST_MODE=warn|enforce.
  attestKey: process.env.ATTEST_KEY || '',
  attestModeSetting: process.env.ATTEST_MODE || 'off',
  // Written by deploy/release.sh; the app offers this version for download.
  releaseManifest: process.env.RELEASE_MANIFEST || null,
  serverList: process.env.SERVER_LIST || null,
  ...overrides,
  };
}

