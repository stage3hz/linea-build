import { DeviceProof, type DeviceKey } from '../../deviceProof';
import type { SignedTransportBLease } from './lease';

export type BootstrapOffer = { signed: SignedTransportBLease; deviceId: string; proof: string };
export type BootstrapOptions = {
  origins: readonly string[];
  token: string;
  key: () => DeviceKey | null;
  headers(method: string, path: string): Record<string,string>;
  fetcher?: typeof fetch;
};
const unavailable = () => new Error('Reserve bootstrap unavailable');
export function bootstrapOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.port && url.port !== '443')) return null;
    if (!/^(?:[a-z0-9-]+\.)+invizent\.(?:com|ru)$/.test(url.hostname) || url.hostname === 'api.invizent.com') return null;
    return url.origin;
  } catch { return null; }
}
async function json(response: Response): Promise<any> {
  if (Number(response.headers.get('content-length') || 0) > 16_384) throw unavailable();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];let size=0;
  try {
    while (true) { const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16_384)throw unavailable();chunks.push(value); }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Cold-start bootstrap is independent of the primary API, uses the same device proof,
 * and never persists room links/proofs. A reachable owned deployment is still required. */
export async function acquireBootstrap(options: BootstrapOptions, signal: AbortSignal): Promise<BootstrapOffer> {
  if (!options.token || !options.key() || options.origins.length < 1 || options.origins.length > 4) throw unavailable();
  const origins=options.origins.map(bootstrapOrigin);
  if(origins.some(origin=>!origin)||new Set(origins).size!==origins.length)throw unavailable();
  for (const origin of origins) {
    if(signal.aborted)throw Object.assign(unavailable(),{name:'AbortError'});
    const attempt=new AbortController(),cancel=()=>attempt.abort();signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,12_000);
    try {
      let deviceId='';
      const post=async(path:string,body?:unknown)=>{
        if(attempt.signal.aborted)throw unavailable();
        const response=await (options.fetcher||fetch)(origin+path,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
          signal:attempt.signal,headers:{...options.headers('POST',path),Authorization:`Bearer ${options.token}`,'Content-Type':'application/json'},body:JSON.stringify(body??{})});
        const value=await json(response);
        if(!response.ok)throw Object.assign(unavailable(),{status:response.status,code:typeof value?.code==='string'?value.code:''});
        if(path==='/auth/device/challenge'){
          if(typeof value?.sessionId!=='string'||!/^[A-Za-z0-9_-]{8,96}$/.test(value.sessionId))throw unavailable();
          deviceId=value.sessionId;
        }
        return value;
      };
      const device=new DeviceProof(options.key,post,Date.now,false);
      if(!await device.refresh()||!device.current||!deviceId)throw unavailable();
      const proof=device.current;
      const response=await (options.fetcher||fetch)(origin+'/v1/transport-b/session',{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',signal:attempt.signal,
        headers:{...options.headers('POST','/v1/transport-b/session'),Authorization:`Bearer ${options.token}`,'X-Linea-Proof':proof,'Content-Type':'application/json'},body:'{}'});
      const signed=await json(response);
      if(!response.ok||typeof signed?.payload!=='string'||signed.payload.length>4096||typeof signed.sig!=='string'||signed.sig.length>128)throw unavailable();
      // The controller verifies the signature, realm, identity, expiry and durable
      // sequence before a native session may use this untrusted network payload.
      return {signed:{payload:signed.payload,sig:signed.sig},deviceId,proof};
    } catch { if(signal.aborted)throw Object.assign(unavailable(),{name:'AbortError'}); }
    finally {clearTimeout(timer);signal.removeEventListener('abort',cancel);}
  }
  throw unavailable();
}
