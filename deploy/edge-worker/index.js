// Invizent reserve entrance through Cloudflare (deploy/edge.sh). Some VPNs and networks cannot
// reach the server's own address but do reach Cloudflare; the app switches here only when the
// direct address is unreachable. Messages stay end-to-end encrypted: this only forwards bytes.
// It passes HTTP and WebSocket through unchanged, except for:
//  - the client's own copies of our edge headers are dropped (they cannot be forged through here);
//  - the real client IP and a shared secret are added, so the server's per-IP limits still work;
//  - an Origin equal to this address (Android's WebSocket) becomes the server's own origin.
const ORIGIN = 'https://api.invizent.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ORIGIN);
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      const key = name.toLowerCase();
      if (key.startsWith('x-invizent-edge') || key.startsWith('cf-') || key === 'x-forwarded-for' || key === 'x-real-ip' || key === 'host') continue;
      headers.set(name, value);
    }
    if (headers.get('origin') === url.origin) headers.set('origin', ORIGIN);
    headers.set('x-invizent-edge-key', env.EDGE_SECRET);
    headers.set('x-invizent-edge-ip', request.headers.get('cf-connecting-ip') || '');
    const init = { method: request.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
    // WebSocket upgrades come back as a 101 response carrying the socket; returning it hands
    // the connection to the client as is.
    return fetch(target, init);
  },
};
