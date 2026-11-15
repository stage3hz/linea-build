/**
 * Standalone prototype HTTP adapter for Stage B session allocation.
 *
 * Not wired into INVIZENT production. Run behind a trusted TLS terminator with
 * an authenticated device-session verifier and bind the HTTP listener to loopback.
 * No API can make an unreachable control plane reachable during a network allowlist.
 */
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function respond(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, private',
    'pragma': 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function readEmptyBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 256) throw new RangeError('body too large');
    chunks.push(chunk);
  }
  if (!length) return;
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
    throw new TypeError('session parameters are determined exclusively by the server');
  }
}

/**
 * @param {object} params
 * @param {import('./creator-pool.mjs').CreatorPool} params.pool
 * @param {ReturnType<import('./lease-issuer.mjs').makeLeaseIssuer>} params.issuer
 * @param {(authorization: string, proof: string) => Promise<{deviceId: string,realm: string}|null>} params.authenticate
 */
export function makeSessionHandler({ pool, issuer, authenticate }) {
  if (!pool || typeof pool.acquire !== 'function' || !issuer || typeof issuer.issue !== 'function' || typeof authenticate !== 'function')
    throw new TypeError('pool, issuer and authenticate callback are required');

  return async (req, res) => {
    // Guard against accidentally exposing a bare test HTTP server on a public interface.
    if (!LOCAL.has(req.socket?.remoteAddress)) return respond(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST' || req.url !== '/v1/transport-b/session')
      return respond(res, 404, { error: 'not_found' });

    const token = req.headers.authorization;
    const proof = req.headers['x-linea-proof'];
    if (typeof token !== 'string' || !/^Bearer [A-Za-z0-9._~-]{16,4096}$/.test(token) ||
        typeof proof !== 'string' || proof.length < 8 || proof.length > 4096)
      return respond(res, 401, { error: 'unauthorized' });
    try {
      await readEmptyBody(req);
    } catch {
      return respond(res, 400, { error: 'invalid_request' });
    }

    let identity;
    try {
      identity = await authenticate(token, proof, req.headers['x-linea-client']);
    } catch {
      return respond(res, 503, { error: 'verification_unavailable' });
    }
    if (!identity || typeof identity.deviceId !== 'string' || identity.realm !== issuer.realm)
      return respond(res, 401, { error: 'unauthorized' });

    // Neither a user ID nor a join link is accepted from the network.
    try {
      const session = await pool.acquire(identity.deviceId);
      const signed = await issuer.issue({
        deviceId: identity.deviceId, joinLink: session.joinLink, expiresAt: session.expiresAt,
      });
      return respond(res, 200, signed);
    } catch {
      // Creator stderr and signed room secrets are never written to API errors/logs.
      return respond(res, 503, { error: 'no_capacity_or_route' });
    }
  };
}
