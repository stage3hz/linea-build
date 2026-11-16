import { fromByteArray, toByteArray } from 'base64-js';
import type { TransportBNetworkModule, TransportBSocketEvent } from '../../../modules/linea-transport-b';

const abortError = () => Object.assign(new Error('Connection attempt cancelled'), {name:'AbortError'});
const failure = () => new Error('Reserve connection unavailable');
const deliver = (listener: ((event: any) => void) | null, event: unknown) => { try { listener?.(event); } catch { /* application callbacks cannot break teardown */ } };

/** Text message socket. No global WebSocket override, hidden retry or binary/media transport. */
export class TransportBMessageSocket {
  readonly url: string;
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  private writes = Promise.resolve();
  private closeTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly id: string, address: string, private readonly native: TransportBNetworkModule,
    private readonly sessionId: string, private readonly remove: () => void) {
    this.url = address;
    void Promise.resolve().then(() => { if (this.readyState === 0) return native.socketOpen(sessionId,id,address); }).catch(() => this.finish(1006,true));
  }
  event(event: TransportBSocketEvent) {
    if (this.readyState === 3) return;
    if (event.kind === 'open' && this.readyState === 0) { this.readyState = 1; deliver(this.onopen, {}); }
    else if (event.kind === 'message' && this.readyState === 1 && typeof event.text === 'string') deliver(this.onmessage, {data:event.text});
    else if (event.kind === 'close' || event.kind === 'error') this.finish(event.code ?? 1006, event.kind === 'error');
  }
  send(text: string) {
    if (this.readyState !== 1 || typeof text !== 'string') throw failure();
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > 256 * 1024 || this.bufferedAmount + bytes > 1024 * 1024) { this.finish(1009,true); return; }
    this.bufferedAmount += bytes;
    this.writes = this.writes.then(async () => {
      if (this.readyState !== 1) return;
      await this.native.socketSend(this.sessionId, this.id, text);
    }).catch(() => this.finish(1006,true)).finally(() => { this.bufferedAmount -= bytes; });
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.native.socketClose(this.sessionId,this.id).catch(() => this.finish(1006,true));
    this.closeTimer = setTimeout(() => this.finish(1000,false),2000);
  }
  finish(code = 1001, error = false) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.remove();
    void this.native.socketClose(this.sessionId,this.id).catch(() => {});
    if (error) deliver(this.onerror, {});
    deliver(this.onclose, {code,reason:'',wasClean:!error});
  }
}

export type MessageSocketLike = {readyState:number;onopen:((event:any)=>void)|null;onmessage:((event:any)=>void)|null;onerror:((event:any)=>void)|null;onclose:((event:any)=>void)|null;send(text:string):void;close():void};
export type ServiceRoute = {origin:string;fetch(address:string,options?:RequestInit):Promise<Response>;openSocket(address:string):MessageSocketLike};
export type RouteVerifier = (route: ServiceRoute, signal: AbortSignal) => Promise<void>;

/** One signed-lease attempt. Ready requires the concrete authenticated service verifier. */
export class TransportBSessionRoute {
  private stage: 'idle' | 'connecting' | 'validating' | 'ready' | 'stopped' = 'idle';
  private lifetime = new AbortController();
  private stateSubscription?: {remove():void};
  private socketSubscription?: {remove():void};
  private sockets = new Map<string,TransportBMessageSocket>();
  private serial = 0;
  private started = false;
  private lost = new Set<() => void>();
  constructor(private readonly native: TransportBNetworkModule, readonly sessionId: string, readonly origin: string,
    private readonly verify: RouteVerifier) {
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(sessionId) || new URL(origin).origin !== origin || !origin.startsWith('https://') || typeof verify !== 'function') throw failure();
  }
  get ready() { return this.stage === 'ready'; }
  onLost(listener: () => void) { this.lost.add(listener); return () => {this.lost.delete(listener);}; }
  private nextId() { return `${this.sessionId}_${++this.serial}`; }
  private address(value: string, socket = false) {
    const url = new URL(value);
    const origin = socket ? url.origin.replace(/^wss:/,'https:') : url.origin;
    if (origin !== this.origin || url.protocol !== (socket?'wss:':'https:') || url.username || url.password || url.hash) throw failure();
    return url.href;
  }
  async start(joinLink: string, signal: AbortSignal): Promise<void> {
    if (this.started || signal.aborted) throw abortError();
    this.started = true; this.stage = 'connecting';
    const stop = () => { void this.stop(); };
    signal.addEventListener('abort',stop,{once:true});
    const timeout = setTimeout(stop,60_000);
    let rejectState: (error: Error) => void = () => {};
    try {
      const connected = new Promise<void>((resolve,reject) => {
        rejectState = reject;
        this.stateSubscription = this.native.addListener('transportState',event => {
          if (event.sessionId !== this.sessionId) return;
          if (event.state === 'sessionConnected') resolve();
          else if (event.state === 'failed' || event.state === 'idle') { reject(failure()); void this.stop(); }
        });
        this.lifetime.signal.addEventListener('abort',()=>reject(abortError()),{once:true});
      });
      this.socketSubscription = this.native.addListener('transportSocket',event => {
        if (event.sessionId === this.sessionId) this.sockets.get(event.socketId)?.event(event);
      });
      await Promise.all([this.native.startSession(this.sessionId,joinLink),connected]);
      if (this.lifetime.signal.aborted) throw abortError();
      this.stage = 'validating';
      let cancelValidation: () => void = () => {};
      const cancelled = new Promise<never>((_resolve,reject)=>{
        cancelValidation=()=>reject(abortError());
        this.lifetime.signal.addEventListener('abort',cancelValidation,{once:true});
      });
      try { await Promise.race([this.verify(this,this.lifetime.signal),cancelled]); }
      finally { this.lifetime.signal.removeEventListener('abort',cancelValidation); }
      if (this.lifetime.signal.aborted || signal.aborted) throw abortError();
      this.stage = 'ready';
    } catch (error) { rejectState(failure()); await this.stop(); throw error; }
    finally { clearTimeout(timeout); signal.removeEventListener('abort',stop); }
  }
  async stop(): Promise<void> {
    if (this.stage === 'stopped') return;
    this.stage = 'stopped'; this.lifetime.abort();
    this.stateSubscription?.remove(); this.socketSubscription?.remove();
    for (const socket of [...this.sockets.values()]) socket.finish();
    for (const listener of this.lost) { try { listener(); } catch { /* teardown continues */ } }
    this.lost.clear();
    await this.native.stopSession(this.sessionId).catch(() => {});
  }
  async fetch(address: string, options: RequestInit = {}): Promise<Response> {
    if (!['validating','ready'].includes(this.stage) || this.lifetime.signal.aborted) throw failure();
    const url = this.address(address), id = this.nextId();
    const headers: Record<string,string> = {};new Headers(options.headers).forEach((value,key)=>{headers[key]=value;});
    let body: Uint8Array | null = null;
    if (typeof options.body === 'string') body = new TextEncoder().encode(options.body);
    else if (options.body instanceof ArrayBuffer) body = new Uint8Array(options.body);
    else if (options.body instanceof Uint8Array) body = options.body;
    else if (options.body != null) throw Object.assign(new Error('Передача этого файла через резерв пока недоступна.'),{name:'ReserveTransferError'});
    if ((body?.byteLength ?? 0) > 1024 * 1024) throw Object.assign(new Error('Этот файл слишком большой для резервного подключения.'),{name:'ReserveTransferError'});
    const caller = options.signal;
    if (caller?.aborted) throw abortError();
    let rejectAbort: (error: Error) => void = () => {};
    const cancel = () => { void this.native.cancelRequest(this.sessionId,id).catch(()=>{}); rejectAbort(abortError()); };
    const cancelled = new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    caller?.addEventListener('abort',cancel,{once:true});this.lifetime.signal.addEventListener('abort',cancel,{once:true});
    try {
      if (caller?.aborted || this.lifetime.signal.aborted) throw abortError();
      const reply = await Promise.race([this.native.request(this.sessionId,id,url,(options.method||'GET').toUpperCase(),headers,body?fromByteArray(body):null,340),cancelled]);
      if (caller?.aborted || this.lifetime.signal.aborted) throw abortError();
      if (!reply || !Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || typeof reply.body !== 'string' || reply.body.length > 11_184_812) throw failure();
      const bytes = new Uint8Array(toByteArray(reply.body));
      if (bytes.byteLength > 8 * 1024 * 1024) throw failure();
      return new Response([204,205,304].includes(reply.status) ? null : bytes.buffer, {status:reply.status,headers:reply.headers});
    } finally { caller?.removeEventListener('abort',cancel);this.lifetime.signal.removeEventListener('abort',cancel); }
  }
  openSocket(address: string): TransportBMessageSocket {
    if (!['validating','ready'].includes(this.stage) || this.lifetime.signal.aborted) throw failure();
    const url = this.address(address,true), id = this.nextId();
    const socket = new TransportBMessageSocket(id,url,this.native,this.sessionId,()=>{this.sockets.delete(id);});
    this.sockets.set(id,socket);return socket;
  }
}

/** TLS health alone is insufficient: verify the signed-in identity and an authenticated WSS ready frame. */
export function verifyMessageService(expectedUserId: string, credentials: () => Promise<{headers:Record<string,string>; auth:object}>): RouteVerifier {
  return async (route,signal) => {
    const health = await route.fetch(route.origin+'/health',{signal});
    const answer = await health.json();if (health.status !== 200 || answer?.status !== 'ok') throw failure();
    const auth = await credentials();
    const response = await route.fetch(route.origin+'/me',{headers:auth.headers,signal});
    const body = await response.json();if (response.status !== 200 || body?.user?.id !== expectedUserId) throw failure();
    await new Promise<void>((resolve,reject)=>{
      const socket = route.openSocket(route.origin.replace(/^https:/,'wss:')+'/ws');
      const finish = (error?: Error) => {signal.removeEventListener('abort',cancel);socket.onclose=null;socket.onerror=null;socket.onmessage=null;socket.onopen=null;socket.close();error?reject(error):resolve();};
      const cancel = () => finish(abortError());
      signal.addEventListener('abort',cancel,{once:true});
      socket.onopen=()=>{try{socket.send(JSON.stringify(auth.auth));}catch{finish(failure());}};
      socket.onmessage=event=>{try{if(JSON.parse(String(event.data))?.type==='ready')finish();}catch{/* an unrelated frame is not ready */}};
      socket.onclose=()=>finish(failure());socket.onerror=()=>finish(failure());
      if(signal.aborted)cancel();
    });
  };
}
