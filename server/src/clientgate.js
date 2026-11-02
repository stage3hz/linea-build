// Client version gate. Real INVIZENT builds announce themselves in the
// `X-Linea-Client` header: `invizent; v=<version>; p=<platform>`. This lets the
// server ask old builds to update and, more importantly, turn away builds whose
// version the owner has decided to retire (for example a forged or broken fork
// pretending to be an ancient version). It is NOT a tamper check on its own: a
// forged client can send any header it likes. Its value is operational — the
// owner can draw a line ("no client below X") and move it without a new server
// release, and every request carries a platform/version label for the logs.
//
// Safe by default: with no minimum configured, every request passes, including
// browsers and clients that send no header at all.

/** Parse "1.2.3" into comparable parts; returns null for anything malformed. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,5})$/.exec(value.trim());
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** a < b (both are [major,minor,patch]). */
export function versionLessThan(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}

/** Read the self-reported client from `X-Linea-Client`; all fields optional. */
export function parseClientInfo(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length > 120) return { product: null, version: null, platform: null, raw: null };
  const fields = {};
  for (const part of headerValue.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const eq = segment.indexOf('=');
    if (eq < 0) { fields.product = fields.product ?? segment.slice(0, 40); continue; }
    const key = segment.slice(0, eq).trim().toLowerCase();
    const val = segment.slice(eq + 1).trim().slice(0, 40);
    if (key === 'v') fields.version = val;
    else if (key === 'p') fields.platform = /^[a-z0-9 /_.-]{1,24}$/i.test(val) ? val : null;
  }
  return { product: fields.product ?? null, version: parseVersion(fields.version) ? fields.version : null, platform: fields.platform ?? null, raw: headerValue.slice(0, 120) };
}

/**
 * Decide whether a request should be refused for being too old.
 *   minVersion   — "x.y.z" the owner requires, or null to allow everything.
 *   requireHeader — when true, a request with no/garbled client header is also
 *                   refused (use only once every real client is known to send it).
 * Returns null to allow, or { code, message } to refuse with 426.
 */
export function clientGateDecision(clientInfo, { minVersion = null, requireHeader = false } = {}) {
  const min = parseVersion(minVersion);
  if (!min && !requireHeader) return null;
  const reported = parseVersion(clientInfo.version);
  if (!reported) {
    if (requireHeader) return { code: 'CLIENT_UNKNOWN', message: 'Обновите приложение INVIZENT до последней версии.' };
    return null;
  }
  if (min && versionLessThan(reported, min)) return { code: 'CLIENT_TOO_OLD', message: 'Эта версия приложения больше не поддерживается. Обновите INVIZENT.' };
  return null;
}
