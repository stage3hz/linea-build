import { desktopBridge } from './desktop';
const desktop = desktopBridge();
if (desktop) {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!['api.invizent.com', '141-133-194-51.nip.io'].includes(url.hostname)) return original(input, init);
    const request = new Request(input, init);
    if (!['api.invizent.com', '141-133-194-51.nip.io'].includes(url.hostname)) return original(input, init);
    const id = crypto.randomUUID();
    const cancel = () => { void desktop.cancelRequest(id); };
    if (request.signal.aborted) throw new DOMException('Aborted','AbortError');
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await desktop.request(id, { url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()), body: ['GET','HEAD'].includes(request.method) ? null : await request.arrayBuffer() });
      return new Response([101,204,205,304].includes(result.status) ? null : result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
    } finally { request.signal.removeEventListener('abort', cancel); }
  };
}
