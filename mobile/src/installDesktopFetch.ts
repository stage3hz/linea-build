import { desktopBridge } from './desktop';
import { TRUSTED_HOST } from './servers/list';
const desktop = desktopBridge();
if (desktop) {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, globalThis.location?.href);
    // Every one of our servers (the list can grow) goes through the PC app's protected channel.
    if (url.protocol !== 'https:' || !TRUSTED_HOST.test(url.hostname)) return original(input, init);
    const request = new Request(input, init);
    const id = crypto.randomUUID();
    const cancel = () => { void desktop.cancelRequest(id); };
    if (request.signal.aborted) throw new DOMException('Aborted','AbortError');
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      const body = ['GET','HEAD'].includes(request.method) ? null : await request.arrayBuffer();
      if (request.signal.aborted) throw new DOMException('Aborted','AbortError');
      const result = await desktop.request(id, { url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()), body });
      if (request.signal.aborted) throw new DOMException('Aborted','AbortError');
      return new Response([101,204,205,304].includes(result.status) ? null : result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
    } finally { request.signal.removeEventListener('abort', cancel); }
  };
}
