import { resolve } from 'node:path';
import { buildApp } from './app.js';

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}: invalid integer`);
  return value;
}

const port = integerEnv('PORT', 3001, 1, 65535);
const ttlDays = integerEnv('SESSION_TTL_DAYS', 30, 1, 90);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
for (const origin of allowedOrigins) {
  if (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) throw new Error('ALLOWED_ORIGINS: use exact http(s) origins without paths');
}
const trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
if (trustedProxies.some(value => ['*', 'true', 'false'].includes(value))) throw new Error('TRUSTED_PROXIES: list only trusted proxy IPs or CIDRs');

const app = await buildApp({
  dataDir: resolve(process.env.DATA_DIR || 'data'),
  logger: { level: process.env.LOG_LEVEL || 'info' },
  allowedOrigins,
  trustProxy: trustedProxies.length ? trustedProxies : false,
  sessionTtlMs: ttlDays * 24 * 60 * 60 * 1000,
  authRateLimit: integerEnv('AUTH_RATE_LIMIT', 20, 1, 1000),
  maxStoredBytesPerUser: integerEnv('USER_STORAGE_MIB', 512, 20, 102400) * 1024 * 1024,
  // AI_PROVIDER=freellmapi uses a self-hosted FreeLLMAPI router; default stays OpenRouter.
  aiApiKey: (process.env.AI_PROVIDER === 'freellmapi' ? process.env.AI_API_KEY : process.env.OPENROUTER_API_KEY) || '',
  turn: process.env.TURN_SECRET ? { secret: process.env.TURN_SECRET, host: process.env.TURN_HOST || '' } : null,
  aiProviderConfig: { provider: process.env.AI_PROVIDER || 'openrouter', baseUrl: process.env.AI_BASE_URL || '', model: process.env.AI_MODEL || '' },
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (stopping) return;
  stopping = true;
  try { await app.close(); } catch { process.exitCode = 1; }
});

try {
  await app.listen({ host: process.env.HOST || '0.0.0.0', port });
} catch (error) {
  app.log.error({ code: error.code || 'START_FAILED' }, 'Server did not start');
  await app.close();
  process.exitCode = 1;
}
