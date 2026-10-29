import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT_V1 = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// OWASP's N=2^15/r=8/p=3 configuration keeps one job below 64 MiB.
// The application also bounds the number of concurrent password jobs.
const SCRYPT_V2 = { ...SCRYPT_V1, p: 3 };
const COMMON_SECRETS = new Set([
  'passwordpassword', 'passwordpasswordpassword', 'thisisapassword',
  'thisismypassword', 'correcthorsebatterystaple', 'qwertyuiopasdfgh',
  '123456789012345', '1234567890123456', '12345678901234567890',
  'моесекретноеслово', 'моёсекретноеслово', 'секретноесловопароль',
  'восстановлениепароля', 'passwordrecovery', 'mysecretpassword',
  'thisismysecretword', 'secretwordsecretword',
  'password', 'secret', 'qwerty', 'пароль', 'секрет',
]);

export class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function fail(statusCode, message, details) { throw new HttpError(statusCode, message, details); }

export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password.normalize('NFC'), salt, 64, SCRYPT_V2);
  const encoded = `scrypt-v2$${salt}$${derived.toString('hex')}`;
  derived.fill(0);
  return encoded;
}

export async function passwordMatches(password, encoded) {
  if (typeof encoded !== 'string' || typeof password !== 'string') return false;
  const [version, salt, expected, extra] = encoded.split('$');
  if (!['scrypt-v1', 'scrypt-v2'].includes(version) || extra !== undefined || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(expected)) return false;
  // Preserve exact legacy password semantics. New secrets consistently use NFC.
  const value = version === 'scrypt-v1' ? password : password.normalize('NFC');
  const actual = await scryptAsync(value, salt, 64, version === 'scrypt-v1' ? SCRYPT_V1 : SCRYPT_V2);
  const matches = timingSafeEqual(actual, Buffer.from(expected, 'hex'));
  actual.fill(0);
  if (version === 'scrypt-v1') {
    // Keep the legacy rejection path at comparable KDF work to modern/unknown accounts.
    const padding = await scryptAsync(value, salt, 64, { ...SCRYPT_V1, p: 2 });
    padding.fill(0);
  }
  return matches;
}

export function passwordValue(value, { existing = false, username = '' } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail(400, 'Пароль: требуется корректная строка.');
  const password = existing ? value : value.normalize('NFC');
  const length = Array.from(password).length;
  const invalidControl = existing ? password.includes('\0') : /[\u0000-\u001f\u007f]/.test(password);
  if (length < (existing ? 1 : 15) || length > 128 || invalidControl) {
    fail(400, existing ? 'Пароль: допустимо от 1 до 128 символов.' : 'Пароль: от 15 до 128 символов. Можно использовать длинную фразу.');
  }
  const normalized = normalizeRecoveryWord(password);
  if (!existing && (!normalized || COMMON_SECRETS.has(normalized) || /^(.)\1+$/u.test(normalized) || (username && normalized === username.toLowerCase()))) {
    fail(400, 'Этот пароль слишком предсказуем. Выберите другую длинную фразу.');
  }
  return password;
}

export function normalizeRecoveryWord(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value.isWellFormed()) fail(400, 'Секретное слово: требуется корректная строка.');
  return value.normalize('NFC').trim().toLowerCase();
}

export function recoveryWordValue(value, { password = '', username = '' } = {}) {
  const word = normalizeRecoveryWord(value);
  if (!/^[a-zа-яё]{4,64}$/u.test(word)) fail(400, 'Секретное слово: от 4 до 64 русских или английских букв без пробелов.');
  if (COMMON_SECRETS.has(word) || /^(.)\1+$/u.test(word) || word === username.toLowerCase() || (password && word === normalizeRecoveryWord(password))) {
    fail(400, 'Выберите непредсказуемое секретное слово, отличающееся от ника и пароля.');
  }
  return word;
}

export function deviceNameValue(value) {
  if (value === undefined) return 'Неизвестное устройство';
  const name = boundedText(value, 'Название устройства', 1, 80);
  if (/[\u0000-\u001f\u007f]/.test(name)) fail(400, 'Название устройства содержит недопустимые символы.');
  return name;
}

export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

export function objectBody(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Ожидается объект JSON.');
  if (Object.keys(body).some(key => !allowedKeys.includes(key))) fail(400, 'Запрос содержит неизвестные поля.');
  return body;
}

export function boundedText(value, label, min, max, { trim = true } = {}) {
  if (typeof value !== 'string') fail(400, `${label}: требуется строка.`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) fail(400, `${label}: допустимо от ${min} до ${max} символов.`);
  if (result.includes('\0')) fail(400, `${label}: недопустимый символ.`);
  return result;
}

export function usernameValue(value) {
  const username = boundedText(value, 'Имя пользователя', 3, 24).toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400, 'Имя пользователя: латинские буквы, цифры и подчёркивание.');
  return username;
}

export function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(400, `${label}: требуется положительное целое число.`);
  return value;
}

export function imageMime(header) {
  if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && header.subarray(12, 16).toString() === 'IHDR') return 'image/png';
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.length >= 10 && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString())) return 'image/gif';
  if (header.length >= 16 && header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function safeFilename(name) {
  const basename = (String(name || 'file').replaceAll('\\', '/').split('/').pop() || 'file')
    .toWellFormed().replace(/[\x00-\x1f\x7f]/g, '');
  return Array.from(basename).slice(0, 180).join('') || 'file';
}

// Fixed windows are intentionally process-local; multi-instance deployments need a shared limiter.
export function createLimiter(now, maxEntries = 10000) {
  const windows = new Map();
  return {
    allow(key, limit, periodMs) {
      if (limit === false || limit === 0) return true;
      const time = now();
      let bucket = windows.get(key);
      if (!bucket || bucket.expires <= time) {
        if (windows.size >= maxEntries) {
          for (const [k, value] of windows) if (value.expires <= time) windows.delete(k);
          if (windows.size >= maxEntries) return false;
        }
        bucket = { count: 0, expires: time + periodMs };
        windows.set(key, bucket);
      }
      bucket.count++;
      return bucket.count <= limit;
    },
    sweep() {
      for (const [key, value] of windows) if (value.expires <= now()) windows.delete(key);
    },
  };
}
