import type { Attachment, Message } from '../types';
import { fromByteArray, toByteArray } from 'base64-js';
import { validMedia, validPreview } from '../media/previewModel';
import { validMeta, type MessageMeta } from '../messageMeta';
import type { ClaimedBundle, CryptoDevice, EncryptedMessage, PrivateVault, PublicBundle, SignalBridge, SignalEnvelope, TrustSnapshot } from './types';

export interface CryptoTransport {
  registerCryptoDevice(deviceId: string, bundle: PublicBundle): Promise<{device: CryptoDevice; preKeyCount: number}>;
  cryptoDevices(userId: string): Promise<{devices: CryptoDevice[]}>;
  claimPreKey(userId: string, deviceId: string): Promise<{device: CryptoDevice; bundle: ClaimedBundle}>;
  cryptoInbox(deviceId: string, chatId: string, after: number): Promise<{messages: Message[]; nextCursor: number; hasMore: boolean}>;
}
type LocalDevice = { id: string; bundle: PublicBundle };
/** `auto`: accepted on first sight / after a key change without a manual code check (WhatsApp-style). */
type TrustRecord = { identityKey: string; registrationId: number; checkedAt: string | null; auto?: boolean };
type PlainBody = { text: string; attachment: Attachment | null; sentAt: string; meta?: MessageMeta };
/** `mesh`: received over Mesh (Bluetooth) before the server copy; the server copy may be a re-encryption of the same text. */
type CachedMessage = { fingerprint: string; plain: PlainBody; mesh?: boolean };
/** A message Signal could not open on this device (session out of step, e.g. after signing in again). */
type FailedMessage = { fingerprint: string; failed: true };
const FAILED_TEXT='Не удалось расшифровать на этом устройстве. Напиши собеседнику — шифрование восстановится — и попроси отправить сообщение ещё раз.';
const FAILED_AFTER=3;
const SYNC_PAGES=100;
const PARTIAL_TEXT='Загружена часть истории. Открой чат ещё раз, чтобы продолжить безопасную расшифровку.';
const rekeyKey=(device:{userId:string;id:string})=>`rekey:${device.userId}:${device.id}`;
const isFailed=(value:unknown):value is FailedMessage=>!!value&&typeof value==='object'&&(value as {failed?:unknown}).failed===true;
export type MeshEnvelope = { chatId: string; clientId: string; senderId: string; encrypted: EncryptedMessage };
type Outbox = { encrypted: EncryptedMessage; plain: PlainBody; peerId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * F4 «Отправить позже»: a scheduled message is encrypted now and delivered later. In the ordinary
 * Double Ratchet session every reply in between is a DH step, and libsignal keeps only the 5 latest
 * receiver chains — after ≥6 exchanges the recipient could not open the old ciphertext any more.
 * So scheduled messages travel in their own Signal session per recipient device («lane»): the same
 * identity and prekey bundle, but a distinct protocol address the recipient never replies to, so
 * that session never ratchets and in-lane ordering is covered by skipped message keys (2000).
 * The envelope carries `lane:'scheduled'` so the recipient decrypts with the lane address; routing
 * stays by the real deviceId. Nobody ever encrypts *to* a lane address except through encrypt(…, deliverAt).
 * «Отправить сейчас» on a lane message is fine (the lane works for immediate delivery too); a
 * message re-encrypted after E2EE_DEVICES_CHANGED goes out at once through the normal session.
 */
export type Lane = 'scheduled';
const LANE_SUFFIX: Record<Lane, string> = { scheduled: '.scheduled' };
/** Native/desktop cores accept `[A-Za-z0-9._:-]{1,160}` as an address name: uuid.uuid.scheduled is 83 chars. */
const address = (userId: string, deviceId: string, lane?: Lane) => `${userId}.${deviceId}${lane ? LANE_SUFFIX[lane] : ''}`;
/**
 * The recipient never answers in the lane, so for libsignal the lane session stays an
 * «unacknowledged pre-key session»; it refuses to encrypt in one older than 30 days. The lane is
 * therefore started afresh (a new prekey bundle, the old chain is archived and still decrypts) once
 * it is this old. Retention check (SignalCore.kt/.swift, desktop/signal.mjs): the signed prekey (id 1)
 * and the last-resort Kyber prekey are never rotated or purged, one-time prekeys are removed only when
 * their PreKey message is opened — so a lane PreKey message still opens after the full year horizon.
 */
const LANE_SESSION_MAX_AGE_MS = 20 * 86_400_000;
/** libsignal's «no usable session» (SessionNotFound / NoSessionException, an expired unacknowledged session), not IDENTITY_CHANGED / TRUST_REQUIRED. */
const laneSessionError = (error: unknown) => {
  const text = `${(error as {name?:unknown})?.name ?? ''} ${(error as {code?:unknown})?.code ?? ''} ${error instanceof Error ? error.message : String(error)}`;
  return /session|unacknowledged/i.test(text) && !/identity|trust/i.test(text);
};
const trustKey = (device: Pick<CryptoDevice,'userId'|'id'>) => `trust:${device.userId}:${device.id}`;
const messageKey = (message: Pick<Message,'chatId'|'senderId'|'clientId'>) => `message:${message.chatId}:${message.senderId}:${message.clientId}`;
const outboxKey = (chatId: string, clientId: string) => `outbox:${chatId}:${clientId}`;
/** The vault cannot list its keys, so the outbox entries still to send are also named in one list (G001). */
const OUTBOX_INDEX = 'outbox:index';
const OUTBOX_LIMIT = 500;
type OutboxRef = { chatId: string; clientId: string };
/** `deliverAt`: a scheduled (lane) message — its committed ciphertext is for the server's «Отправить позже», dated at that time. */
export type OutboxItem = OutboxRef & { peerId: string; text: string; attachment: Attachment | null; sentAt: string; meta?: MessageMeta; deliverAt?: string };
/**
 * Names of the decrypted messages cached per chat, in pages, so the local search index (G029) can
 * be rebuilt from the vault at startup: `history:<chat>` = {first,last} page numbers,
 * `history:<chat>:<n>` = [[senderId, clientId], …]. Oldest pages are dropped past HISTORY_PAGES.
 * Every cached message rewrites the chat's last page, so pages are small (50 names ≈ 5 KB).
 */
const HISTORY_CHATS = 'history:chats';
const HISTORY_PAGE = 50;
const HISTORY_PAGES = 40;
const historyMetaKey = (chatId: string) => `history:${chatId}`;
const historyPageKey = (chatId: string, page: number) => `history:${chatId}:${page}`;
type HistoryMeta = { first: number; last: number };
export type HistoryItem = { chatId: string; senderId: string; clientId: string; text: string; attachment: Attachment | null; sentAt: string; meta?: MessageMeta };
/** One page of a chat's cached history, newest first; `previous` names the older page, null past the oldest kept. */
export type HistoryPage = { items: HistoryItem[]; page: number; previous: number | null };
/** '1' for a normal session; for a lane session the ISO time it was started (see LANE_SESSION_MAX_AGE_MS). */
const sessionKey = (device: Pick<CryptoDevice,'userId'|'id'>, lane?: Lane) => `session:${device.userId}:${device.id}${lane ? `:${lane}` : ''}`;
/** Last device list seen from the server, so messages can still be encrypted without internet (Mesh). */
const devicesKey = (userId: string) => `devices:${userId}`;
const isNetwork = (error: unknown) => error instanceof Error && error.name === 'NetworkError';
const samePlain = (a: PlainBody, b: PlainBody) => a.text === b.text && JSON.stringify(a.attachment) === JSON.stringify(b.attachment) && JSON.stringify(a.meta ?? null) === JSON.stringify(b.meta ?? null);

export class UntrustedDeviceError extends Error {
  constructor() { super('Проверь коды устройств в разделе «Защита чата». Новые ключи не принимаются автоматически.'); this.name='UntrustedDeviceError'; }
}
export function canonicalEncrypted(value: EncryptedMessage): string {
  return JSON.stringify({scheme:value.scheme,senderDeviceId:value.senderDeviceId,envelopes:[...value.envelopes].sort((a,b)=>`${a.userId}:${a.deviceId}`.localeCompare(`${b.userId}:${b.deviceId}`)).map(item=>({userId:item.userId,deviceId:item.deviceId,type:item.type,body:item.body})),attachmentIds:[...(value.attachmentIds||[])].sort(),...(value.lane?{lane:value.lane}:{})});
}
function sameDevice(a: Pick<CryptoDevice,'identityKey'|'registrationId'>, b: Pick<CryptoDevice,'identityKey'|'registrationId'>) {
  return a.identityKey===b.identityKey&&a.registrationId===b.registrationId;
}
function parse<T>(value: string | null): T | null { return value === null ? null : JSON.parse(value) as T; }
function hasOnlyKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function validCiphertextBody(value: unknown): value is string {
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(65536/3)*4)return false;
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return false;
  const bytes=toByteArray(value);
  return bytes.length<=65536&&fromByteArray(bytes)===value;
}
function validEnvelope(value: unknown): value is SignalEnvelope {
  if(!hasOnlyKeys(value,['userId','deviceId','type','body']))return false;
  return typeof value.userId==='string'&&uuid.test(value.userId)&&typeof value.deviceId==='string'&&uuid.test(value.deviceId)&&(value.type===2||value.type===3)&&validCiphertextBody(value.body);
}
function validAttachmentIds(value: unknown): boolean {
  if(!Array.isArray(value)||value.length>10||!value.every(id=>typeof id==='string'&&uuid.test(id)))return false;
  return new Set(value.map(id=>id.toLowerCase())).size===value.length;
}
function validEncrypted(value: unknown): value is EncryptedMessage {
  if(!hasOnlyKeys(value,['scheme','senderDeviceId','envelopes','attachmentIds','lane']))return false;
  if(value.scheme!=='signal-v1'||typeof value.senderDeviceId!=='string'||!uuid.test(value.senderDeviceId)||(value.lane!==undefined&&value.lane!=='scheduled'))return false;
  const envelopes=value.envelopes;
  if(!Array.isArray(envelopes)||envelopes.length<1||envelopes.length>10||!envelopes.every(validEnvelope))return false;
  if(new Set(envelopes.map(envelope=>envelope.deviceId.toLowerCase())).size!==envelopes.length)return false;
  return validAttachmentIds(value.attachmentIds??[]);
}
// Voice waveform travels next to the attachment, not inside attachment.media: apps before 0.14.5
// check media keys strictly and would refuse the whole message, but ignore unknown top-level keys.
const WAVEFORM = /^[A-Za-f]{8,100}$/;
function wireBody(plain: PlainBody): Record<string, unknown> {
  const media = plain.attachment?.media;
  if (!plain.attachment || !media || media.waveform === undefined) return { ...plain };
  const { waveform, ...rest } = media;
  const attachment: Attachment = { ...plain.attachment };
  if (Object.keys(rest).length) attachment.media = rest; else delete attachment.media;
  return { ...plain, attachment, voiceWaveform: waveform };
}
function withWaveform(attachment: Attachment | null, waveform: unknown): Attachment | null {
  if (!attachment || typeof waveform !== 'string' || !WAVEFORM.test(waveform) || attachment.media?.waveform !== undefined) return attachment;
  return { ...attachment, media: { ...(attachment.media || {}), waveform } };
}
export function validAttachment(value: unknown): value is Attachment | null {
  if(value===null)return true;
  if(!hasOnlyKeys(value,['id','name','mimeType','size','encryption','media','preview']))return false;
  const a=value as Attachment;const e=a.encryption;
  // Small files: one AES-256-GCM-SIV block up to 20 MB. Big files (up to 10 GB, a Platina video): the same cipher per 4 MiB chunk.
  const chunked=!!e&&e.scheme==='aes-256-gcm-siv-chunked';
  if(!hasOnlyKeys(e,chunked?['scheme','key','nonce','fileKeyId','chunkSize']:['scheme','key','nonce','fileKeyId']))return false;
  if(chunked&&e.chunkSize!==4*1024*1024)return false;
  return uuid.test(a.id)&&typeof a.name==='string'&&a.name.length>0&&a.name.length<=240&&typeof a.mimeType==='string'&&a.mimeType.length<=150&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size<=(chunked?10*1024*1024*1024:20*1024*1024)&&!!e&&(e.scheme==='aes-256-gcm-siv'||chunked)&&/^[A-Za-z0-9+/]{43}=$/.test(e.key)&&/^[A-Za-z0-9+/]{16}$/.test(e.nonce)&&uuid.test(e.fileKeyId)&&validMedia(a.media)&&validPreview(a.preview);
}

/** Application integration of the official native Signal library, not a new cipher. */
export class CryptoService {
  private tail: Promise<unknown> = Promise.resolve();
  private initializing: Promise<void> | null = null;
  private local: LocalDevice | null = null;
  private closed = false;
  private syncing = new Map<string,{task:Promise<void>;pages:number}>();
  constructor(
    readonly userId: string, private readonly transport: CryptoTransport,
    private readonly bridge: SignalBridge, private readonly vault: PrivateVault,
    private readonly randomUUID: ()=>string, private readonly sha256: (value:string)=>Promise<string>,
    /** autoTrust: new or changed device keys are accepted without a code check; checking stays optional. */
    private readonly options: { autoTrust?: boolean } = {},
  ) {}
  private autoRecord(device:Pick<CryptoDevice,'identityKey'|'registrationId'>):string {
    return JSON.stringify({identityKey:device.identityKey,registrationId:device.registrationId,checkedAt:null,auto:true});
  }
  private exclusive<T>(work:()=>Promise<T>):Promise<T> {
    const next=this.tail.then(async()=>{if(this.closed)throw new Error('Сессия шифрования завершена.');return work();});
    this.tail=next.catch(()=>{});return next;
  }
  async initialize():Promise<void> {
    if(!this.initializing)this.initializing=this.exclusive(async()=>{
      let local=parse<LocalDevice>(await this.vault.get('device'));
      let state=await this.vault.get('protocol');
      if(!local&&!state){
        const id=this.randomUUID();const created=await this.bridge.createState(address(this.userId,id),1);
        local={id,bundle:created.bundle};state=created.state;
        // Persist identity/prekeys before publishing any public material.
        await this.vault.commit({device:JSON.stringify(local),protocol:state});
      }
      if(!local||!state||!uuid.test(local.id))throw new Error('Локальные ключи недоступны. Автоматическая замена ключей отключена.');
      this.local=local;
      const published=await this.transport.registerCryptoDevice(local.id,local.bundle);
      if(published.device.id!==local.id||published.device.userId!==this.userId||!sameDevice(published.device,local.bundle))throw new Error('Сервер вернул другие ключи устройства. Соединение остановлено.');
      if(published.preKeyCount<8){
        const replenished=await this.bridge.replenish(state,20);local={id:local.id,bundle:replenished.bundle};
        await this.vault.commit({device:JSON.stringify(local),protocol:replenished.state});this.local=local;
        await this.transport.registerCryptoDevice(local.id,local.bundle);
      }
    }).catch(error=>{this.initializing=null;throw error;});
    return this.initializing;
  }
  get deviceId():string|null {return this.local?.id??null;}
  /** Without internet: the last lists from the server, only devices we already have a session with. */
  private async cachedTargets(peerId:string):Promise<CryptoDevice[]> {
    const read=async(userId:string)=>{try{const list=JSON.parse((await this.vault.get(devicesKey(userId)))||'[]');return Array.isArray(list)?list as CryptoDevice[]:[];}catch{return [];}};
    const local=this.local!;const out:CryptoDevice[]=[];
    for(const device of [...(await read(this.userId)).filter(d=>d.id!==local.id),...(await read(peerId))]){
      if(device.userId!==this.userId&&device.userId!==peerId)continue;
      if(device.active&&await this.vault.get(sessionKey(device))&&await this.vault.get(trustKey(device)))out.push(device);
    }
    if(!out.some(d=>d.userId===peerId))throw new Error('Без интернета можно писать только тем, с кем уже переписывались.');
    return out;
  }
  private async targets(peerId:string):Promise<CryptoDevice[]> {
    if(!uuid.test(peerId)||peerId===this.userId)throw new Error('Неверный собеседник.');
    const [own,peer]=await Promise.all([this.transport.cryptoDevices(this.userId),this.transport.cryptoDevices(peerId)]);
    const local=this.local!;
    const self=own.devices.find(device=>device.id===local.id);
    if(!self||self.userId!==this.userId||!self.active||!sameDevice(self,local.bundle))throw new Error('Устройство больше не разрешено для переписки. Войди в аккаунт снова.');
    if(!peer.devices.length)throw new Error('У собеседника пока нет активного устройства с шифрованием. Попроси его открыть новую версию приложения.');
    const devices=[...own.devices.filter(device=>device.id!==local.id),...peer.devices];
    const seen=new Set<string>();
    for(const device of devices){
      const key=address(device.userId,device.id);
      if(!uuid.test(device.id)||![this.userId,peerId].includes(device.userId)||!device.active||!Number.isSafeInteger(device.registrationId)||device.registrationId<1||device.registrationId>16383||typeof device.identityKey!=='string'||!/^[A-Za-z0-9+/]{44}$/.test(device.identityKey)||seen.has(key))throw new Error('Сервер вернул некорректный список ключей.');
      seen.add(key);
    }
    if(devices.length>9)throw new Error('Слишком много устройств в разговоре.');
    const result=devices.sort((a,b)=>address(a.userId,a.id).localeCompare(address(b.userId,b.id)));
    // Remember the lists (only when they changed) for encrypting without internet.
    const ownJson=JSON.stringify(own.devices),peerJson=JSON.stringify(peer.devices);
    if(await this.vault.get(devicesKey(this.userId))!==ownJson||await this.vault.get(devicesKey(peerId))!==peerJson)await this.vault.commit({[devicesKey(this.userId)]:ownJson,[devicesKey(peerId)]:peerJson});
    return result;
  }
  private async snapshot(peerId:string):Promise<TrustSnapshot> {
    const targets=await this.targets(peerId);const local=this.local!;
    const selfIdentity=`${address(this.userId,local.id)}:${local.bundle.identityKey}:${local.bundle.registrationId}`;
    const devices=await Promise.all(targets.map(async device=>{
      const trusted=parse<TrustRecord>(await this.vault.get(trustKey(device)));
      const pair=[selfIdentity,`${address(device.userId,device.id)}:${device.identityKey}:${device.registrationId}`].sort();
      const code=await this.sha256(`linea-safety-code-v1\u0000${pair.join('\u0000')}`);
      return {...device,code:code.toUpperCase().match(/.{1,4}/g)!.join(' '),trusted:!!trusted&&!trusted.auto&&sameDevice(trusted,device),self:device.userId===this.userId};
    }));
    return {peerId,ownDeviceId:local.id,devices,fingerprint:await this.sha256(JSON.stringify(devices.map(device=>[device.userId,device.id,device.identityKey,device.registrationId])))};
  }
  private async outboxRefs():Promise<OutboxRef[]> {
    try{const list=parse<unknown>(await this.vault.get(OUTBOX_INDEX));return Array.isArray(list)?list.filter((item):item is OutboxRef=>!!item&&typeof item==='object'&&uuid.test((item as OutboxRef).chatId)&&uuid.test((item as OutboxRef).clientId)):[];}catch{return [];}
  }
  /** Vault changes that add (or drop) one entry of the outbox list; part of the caller's atomic commit. */
  private async outboxIndexChange(ref:OutboxRef,present:boolean):Promise<Record<string,string|null>> {
    const refs=await this.outboxRefs();const rest=refs.filter(item=>item.chatId!==ref.chatId||item.clientId!==ref.clientId);
    if(!present)return rest.length===refs.length?{}:{[OUTBOX_INDEX]:rest.length?JSON.stringify(rest):null};
    if(rest.length!==refs.length)return {};
    return {[OUTBOX_INDEX]:JSON.stringify([...rest,ref].slice(-OUTBOX_LIMIT))};
  }
  /** Vault changes that name a newly cached decrypted message in the chat's history pages; part of the caller's atomic commit. */
  private async historyChange(chatId:string,senderId:string,clientId:string):Promise<Record<string,string|null>> {
    const changes:Record<string,string|null>={};
    let meta=parse<HistoryMeta>(await this.vault.get(historyMetaKey(chatId)));
    if(!meta||!Number.isSafeInteger(meta.first)||!Number.isSafeInteger(meta.last)||meta.first>meta.last){
      meta={first:0,last:0};changes[historyMetaKey(chatId)]=JSON.stringify(meta);
      const chats=await this.historyChats();if(!chats.includes(chatId))changes[HISTORY_CHATS]=JSON.stringify([...chats,chatId]);
    }
    let page:unknown[]=[];try{const raw=parse<unknown>(await this.vault.get(historyPageKey(chatId,meta.last)));if(Array.isArray(raw))page=raw;}catch{page=[];}
    if(page.length>=HISTORY_PAGE){
      const next={first:meta.first,last:meta.last+1};
      if(next.last-next.first>=HISTORY_PAGES){changes[historyPageKey(chatId,next.first)]=null;next.first++;}
      changes[historyMetaKey(chatId)]=JSON.stringify(next);meta=next;page=[];
    }
    changes[historyPageKey(chatId,meta.last)]=JSON.stringify([...page,[senderId,clientId]]);
    return changes;
  }
  /** Messages encrypted and committed but not confirmed by the server yet, oldest first (G001). Safe to send again: the same clientId reuses the same ciphertext. */
  async pendingOutbox():Promise<OutboxItem[]> {
    // Vault only, no initialize(): the list must be readable without internet (initialize publishes keys).
    return this.exclusive(async()=>{
      const refs=await this.outboxRefs();const items:OutboxItem[]=[];const kept:OutboxRef[]=[];
      for(const ref of refs){
        const stored=parse<Outbox>(await this.vault.get(outboxKey(ref.chatId,ref.clientId)));
        if(!stored||!stored.plain||!uuid.test(stored.peerId))continue; // delivered or dropped since: forget the name too
        kept.push(ref);items.push({chatId:ref.chatId,clientId:ref.clientId,peerId:stored.peerId,text:stored.plain.text,attachment:stored.plain.attachment,sentAt:stored.plain.sentAt,...(stored.plain.meta?{meta:stored.plain.meta}:{}),...(stored.encrypted?.lane?{deliverAt:stored.plain.sentAt}:{})});
      }
      if(kept.length!==refs.length)await this.vault.commit({[OUTBOX_INDEX]:kept.length?JSON.stringify(kept):null});
      return items;
    });
  }
  /** Chats with decrypted history cached on this device. */
  async historyChats():Promise<string[]> {
    try{const list=parse<unknown>(await this.vault.get(HISTORY_CHATS));return Array.isArray(list)?list.filter((id):id is string=>typeof id==='string'&&uuid.test(id)):[];}catch{return [];}
  }
  /**
   * One page of the decrypted messages cached for a chat, newest first (G029: the search index is
   * built from these, on the device only). `page` omitted = the newest page. Each page is read
   * under its own turn of the crypto queue, so a startup fill never blocks sending or decrypting.
   */
  async historyPage(chatId:string,page?:number):Promise<HistoryPage> {
    return this.exclusive(async()=>{
      const meta=parse<HistoryMeta>(await this.vault.get(historyMetaKey(chatId)));
      if(!meta||!Number.isSafeInteger(meta.first)||!Number.isSafeInteger(meta.last)||meta.first>meta.last)return {items:[],page:page??0,previous:null};
      const current=page===undefined?meta.last:page;
      const previous=current-1>=meta.first?current-1:null;
      if(current>meta.last||current<meta.first)return {items:[],page:current,previous};
      const items:HistoryItem[]=[];
      let list:unknown[]=[];try{const raw=parse<unknown>(await this.vault.get(historyPageKey(chatId,current)));if(Array.isArray(raw))list=raw;}catch{list=[];}
      for(let index=list.length-1;index>=0;index--){
        const item=list[index];if(!Array.isArray(item)||typeof item[0]!=='string'||typeof item[1]!=='string')continue;
        const [senderId,clientId]=item as [string,string];
        let cached:CachedMessage|FailedMessage|null=null;try{cached=parse<CachedMessage|FailedMessage>(await this.vault.get(messageKey({chatId,senderId,clientId})));}catch{cached=null;}
        if(!cached||isFailed(cached)||!cached.plain)continue;
        items.push({chatId,senderId,clientId,text:cached.plain.text,attachment:cached.plain.attachment,sentAt:cached.plain.sentAt,...(cached.plain.meta?{meta:cached.plain.meta}:{})});
      }
      return {items,page:current,previous};
    });
  }
  /** All cached pages of a chat, newest first, up to `limit`; page by page (see historyPage), starting at `fromPage` when given. */
  async history(chatId:string,limit=HISTORY_PAGE*HISTORY_PAGES,fromPage?:number):Promise<HistoryItem[]> {
    const out:HistoryItem[]=[];let page=fromPage;
    while(out.length<limit){
      const result=await this.historyPage(chatId,page);
      for(const item of result.items){if(out.length>=limit)break;out.push(item);}
      if(result.previous===null)break;
      page=result.previous;
    }
    return out;
  }
  /** Vault changes that drop every history page of a chat and its name in the chat list. */
  private async historyForget(chatId:string):Promise<Record<string,string|null>> {
    const changes:Record<string,string|null>={};
    const meta=parse<HistoryMeta>(await this.vault.get(historyMetaKey(chatId)));
    if(meta&&Number.isSafeInteger(meta.first)&&Number.isSafeInteger(meta.last)&&meta.last-meta.first<HISTORY_PAGES*2)for(let page=meta.first;page<=meta.last;page++)changes[historyPageKey(chatId,page)]=null;
    if(meta)changes[historyMetaKey(chatId)]=null;
    const chats=await this.historyChats();if(chats.includes(chatId))changes[HISTORY_CHATS]=chats.length>1?JSON.stringify(chats.filter(id=>id!==chatId)):null;
    return changes;
  }
  async trustSnapshot(peerId:string):Promise<TrustSnapshot> {await this.initialize();return this.exclusive(()=>this.snapshot(peerId));}
  async approveDevices(snapshot:TrustSnapshot):Promise<void> {
    await this.initialize();return this.exclusive(async()=>{
      const current=await this.snapshot(snapshot.peerId);
      if(current.ownDeviceId!==snapshot.ownDeviceId||current.fingerprint!==snapshot.fingerprint)throw new Error('Список устройств изменился. Сверь обновлённые коды.');
      let state=(await this.vault.get('protocol'))!;const changes:Record<string,string>={};
      for(const device of current.devices){
        const previous=parse<TrustRecord>(await this.vault.get(trustKey(device)));
        if(previous&&!previous.auto&&!sameDevice(previous,device))throw new UntrustedDeviceError();
        state=(await this.bridge.trustIdentity(state,address(device.userId,device.id),1,device.identityKey)).state;
        changes[trustKey(device)]=JSON.stringify({identityKey:device.identityKey,registrationId:device.registrationId,checkedAt:new Date().toISOString()});
      }
      await this.vault.commit({...changes,protocol:state});
    });
  }
  /**
   * `deliverAt` (F4 «Отправить позже»): the message is dated at that time inside the ciphertext and
   * encrypted in the scheduled lane (see Lane) — a session per device that never ratchets, so the
   * envelopes still open whatever is exchanged in the chat before the server releases them. Needs
   * the server (a lane is started from a fresh prekey bundle); without a time the normal session is used.
   */
  async encrypt(chatId:string,peerId:string,clientId:string,text:string,attachment:Attachment|null,meta?:MessageMeta,deliverAt?:string):Promise<EncryptedMessage> {
    await this.initialize();return this.exclusive(async()=>{
      if(!uuid.test(chatId)||!uuid.test(clientId)||typeof text!=='string'||text.length>8000||(!text.trim()&&!attachment)||!validAttachment(attachment)||!validMeta(meta)||(deliverAt!==undefined&&(typeof deliverAt!=='string'||!Number.isFinite(Date.parse(deliverAt)))))throw new Error('Некорректное содержимое сообщения.');
      const lane:Lane|undefined=deliverAt===undefined?undefined:'scheduled';
      const key=outboxKey(chatId,clientId);const previous=parse<Outbox>(await this.vault.get(key));
      if(previous){
        if(previous.peerId!==peerId||previous.plain.text!==text||JSON.stringify(previous.plain.attachment)!==JSON.stringify(attachment)||JSON.stringify(previous.plain.meta)!==JSON.stringify(meta)||previous.encrypted.lane!==lane)throw new Error('Идентификатор сообщения уже использован.');
        return previous.encrypted; // Retries reuse exactly the committed ciphertext.
      }
      let offline=false;let targets:CryptoDevice[];
      // A lane may need a prekey bundle, which only the server has: scheduling waits for the internet.
      try{targets=await this.targets(peerId);}catch(error){if(!isNetwork(error)||lane)throw error;targets=await this.cachedTargets(peerId);offline=true;}
      let state=(await this.vault.get('protocol'))!;
      const now=new Date().toISOString();
      const plain:PlainBody={text,attachment,sentAt:deliverAt??now,...(meta?{meta}:{})};const changes:Record<string,string|null>={};
      const encrypted:EncryptedMessage={scheme:'signal-v1',senderDeviceId:this.local!.id,envelopes:[],attachmentIds:attachment?[attachment.id]:[],...(lane?{lane}:{})};
      for(const device of targets){
        const trusted=parse<TrustRecord>(await this.vault.get(trustKey(device)));
        let rekey=false;
        if(offline&&(!trusted||!sameDevice(trusted,device)))continue; // never accept new keys without the server
        if(!trusted||!sameDevice(trusted,device)){
          if(!this.options.autoTrust)throw new UntrustedDeviceError();
          state=(await this.bridge.trustIdentity(state,address(device.userId,device.id),1,device.identityKey)).state;
          changes[trustKey(device)]=this.autoRecord(device);
          rekey=!!trusted; // a changed key needs a fresh session (in the lane too: the pin below then starts afresh)
        }
        // The lane address is pinned to the same identity (idempotent); the native cores refuse to encrypt to an unpinned address.
        if(lane)state=(await this.bridge.trustIdentity(state,address(device.userId,device.id,lane),1,device.identityKey)).state;
        let bundle:ClaimedBundle|null=null;
        // The rekey mark (our decrypt of their message failed) is about the normal session; the lane is not affected by it.
        if(!lane&&await this.vault.get(rekeyKey(device))){rekey=true;changes[rekeyKey(device)]=null;}
        const session=await this.vault.get(sessionKey(device,lane));
        const stale=!!lane&&!!session&&!(Date.parse(session)>Date.parse(now)-LANE_SESSION_MAX_AGE_MS);
        const claim=async()=>{
          const claimed=await this.transport.claimPreKey(device.userId,device.id);
          if(claimed.device.id!==device.id||claimed.device.userId!==device.userId||!sameDevice(claimed.device,device)||!sameDevice(claimed.bundle,device))throw new UntrustedDeviceError();
          return claimed.bundle;
        };
        if(rekey||!session||stale)bundle=await claim();
        const payload=JSON.stringify({version:1,chatId,clientId,senderId:this.userId,senderDeviceId:this.local!.id,recipientId:device.userId,recipientDeviceId:device.id,...(lane?{lane}:{}),...wireBody(plain)});
        let result;
        try{result=await this.bridge.encrypt(state,address(device.userId,device.id,lane),1,payload,bundle);}
        catch(error){
          // A lane libsignal no longer accepts (an unacknowledged session past its age, a lost session record): start it afresh once.
          // Only for session errors — a trust/identity refusal would just burn the peer's one-time prekeys.
          if(!lane||bundle||isNetwork(error)||!laneSessionError(error))throw error;
          bundle=await claim();result=await this.bridge.encrypt(state,address(device.userId,device.id,lane),1,payload,bundle);
        }
        state=result.state;changes[sessionKey(device,lane)]=lane?(bundle?now:session!):'1';encrypted.envelopes.push({userId:device.userId,deviceId:device.id,type:result.type,body:result.body});
      }
      const fingerprint=await this.sha256(canonicalEncrypted(encrypted));
      changes[key]=JSON.stringify({encrypted,plain,peerId});
      changes[messageKey({chatId,clientId,senderId:this.userId})]=JSON.stringify({fingerprint,plain});
      Object.assign(changes,await this.outboxIndexChange({chatId,clientId},true),await this.historyChange(chatId,this.userId,clientId));
      // Atomic ratchet + outbox + local history commit BEFORE the network send.
      await this.vault.commit({...changes,protocol:state});return encrypted;
    });
  }
  async delivered(chatId:string,clientId:string):Promise<void> {await this.initialize();return this.exclusive(async()=>this.vault.commit({...(await this.outboxIndexChange({chatId,clientId},false)),[outboxKey(chatId,clientId)]:null}));}
  /**
   * A message the server will never take (rejected for good: the device list changed, the chat is
   * gone, the content was refused): its ciphertext, its place in the outbox list and our cached copy
   * go, so it is not sent again after a restart. The next encrypt() with the same clientId starts
   * afresh (new device list, new ciphertext). Vault only: works without internet.
   */
  async forget(chatId:string,clientId:string):Promise<void> {
    return this.exclusive(async()=>this.vault.commit({...(await this.outboxIndexChange({chatId,clientId},false)),[outboxKey(chatId,clientId)]:null,[messageKey({chatId,clientId,senderId:this.userId})]:null}));
  }
  async rejectedDeviceSet(chatId:string,clientId:string):Promise<void> {return this.forget(chatId,clientId);}
  /** A chat deleted here: its history names (G029) and every unsent message of it leave the vault. */
  async forgetChat(chatId:string):Promise<void> {
    return this.exclusive(async()=>{
      const changes=await this.historyForget(chatId);
      const refs=await this.outboxRefs();const rest=refs.filter(ref=>ref.chatId!==chatId);
      if(rest.length!==refs.length){
        for(const ref of refs)if(ref.chatId===chatId){changes[outboxKey(chatId,ref.clientId)]=null;changes[messageKey({chatId,clientId:ref.clientId,senderId:this.userId})]=null;}
        changes[OUTBOX_INDEX]=rest.length?JSON.stringify(rest):null;
      }
      if(Object.keys(changes).length)await this.vault.commit(changes);
    });
  }
  /** Decrypts our envelope of a message (from the server or from Mesh) and checks it is addressed exactly as claimed. */
  private async open(message:Pick<Message,'chatId'|'clientId'|'senderId'>,encrypted:EncryptedMessage):Promise<{plain:PlainBody;protocol:string;sender:{userId:string;id:string}}|null> {
    const envelope=encrypted.envelopes.find(item=>item.userId===this.userId&&item.deviceId===this.local!.id);
    if(!envelope)return null;
    const sender={userId:message.senderId,id:encrypted.senderDeviceId};
    let trusted=parse<TrustRecord>(await this.vault.get(trustKey(sender)));
    if(!trusted&&this.options.autoTrust){
      const device=(await this.targets(message.senderId===this.userId?this.userId:message.senderId)).find(item=>item.userId===sender.userId&&item.id===sender.id);
      if(device){trusted={identityKey:device.identityKey,registrationId:device.registrationId,checkedAt:null,auto:true};await this.vault.commit({[trustKey(sender)]:this.autoRecord(device)});}
    }
    if(!trusted)throw new UntrustedDeviceError();
    let state=(await this.vault.get('protocol'))!;
    // A scheduled message (lane) was encrypted in the sender's separate lane session. It is opened at a
    // receive-only address (`….scheduled.in`): if it were the address we send our own scheduled messages
    // to, an incoming lane PreKey would become our sending session there and the lane would ratchet.
    const from=encrypted.lane?`${address(sender.userId,sender.id,encrypted.lane)}.in`:address(sender.userId,sender.id);
    state=(await this.bridge.trustIdentity(state,from,1,trusted.identityKey)).state;
    const result=await this.bridge.decrypt(state,from,1,envelope.type,envelope.body);
    const body=JSON.parse(result.plaintext);
    // `lane` is also inside the ciphertext: a server that adds or strips the flag is refused here, before any protocol state is committed (the bridges only return a new state; decode() commits it after this check).
    if((body.lane??undefined)!==encrypted.lane||body.version!==1||body.chatId!==message.chatId||body.clientId!==message.clientId||body.senderId!==message.senderId||body.senderDeviceId!==encrypted.senderDeviceId||body.recipientId!==this.userId||body.recipientDeviceId!==this.local!.id||typeof body.text!=='string'||body.text.length>8000||!validAttachment(body.attachment)||typeof body.sentAt!=='string'||!Number.isFinite(Date.parse(body.sentAt))||!validMeta(body.meta))throw new Error('Содержимое не соответствует адресу сообщения.');
    const attachmentIds=body.attachment?[body.attachment.id]:[];
    if(JSON.stringify([...(encrypted.attachmentIds||[])].sort())!==JSON.stringify(attachmentIds))throw new Error('Неверная привязка зашифрованного вложения.');
    const plain:PlainBody={text:body.text,attachment:withWaveform(body.attachment,body.voiceWaveform),sentAt:body.sentAt,...(body.meta?{meta:body.meta}:{})};
    return {plain,protocol:result.state,sender};
  }
  private async decode(message:Message,cursorKey:string):Promise<void> {
    // Our own device's message left out by a lean inbox: nothing to open here (we have no envelope
    // for ourselves, and our copy is already cached at send time) — just move the cursor.
    if(!message.encrypted&&message.lean&&message.senderId===this.userId){await this.vault.commit({[cursorKey]:String(message.id)});return;}
    const encrypted=message.encrypted;
    if(!validEncrypted(encrypted))throw new Error('Некорректный зашифрованный пакет.');
    const fingerprint=await this.sha256(canonicalEncrypted(encrypted));const cached=parse<CachedMessage>(await this.vault.get(messageKey(message)));
    if(cached&&(cached.fingerprint===fingerprint||!cached.mesh)){
      if(cached.fingerprint!==fingerprint)throw new Error('Сервер изменил сохранённое сообщение.');
      await this.vault.commit({[cursorKey]:String(message.id)});return;
    }
    if(isFailed(cached)&&cached.fingerprint===fingerprint){await this.vault.commit({[cursorKey]:String(message.id)});return;}
    let opened;
    try{opened=await this.open(message,encrypted);}
    catch(error){
      if(isNetwork(error)||error instanceof UntrustedDeviceError)throw error;
      // A damaged copy may be a passing glitch, so the chat first stops and retries (the server's
      // next copy may be fine). But one message that never opens must not block the chat forever
      // (before, every later message stayed «Открой чат для расшифровки»): after a few attempts it
      // is marked as failed and skipped, and our next message to the sender's device starts a fresh
      // Signal session (PreKey message), which puts their side back in step too.
      const attemptsKey=`attempts:${messageKey(message)}`,attempts=Number(await this.vault.get(attemptsKey)||0)+1;
      if(attempts<FAILED_AFTER){await this.vault.commit({[attemptsKey]:String(attempts)});throw error;}
      // A broken lane message says nothing about the normal session: no rekey of it (the sender restarts its lane by age).
      await this.vault.commit({[attemptsKey]:null,...(encrypted.lane?{}:{[rekeyKey({userId:message.senderId,id:encrypted.senderDeviceId})]:'1'}),[messageKey(message)]:JSON.stringify({fingerprint,failed:true} satisfies FailedMessage),[cursorKey]:String(message.id)});
      return;
    }
    if(!opened){await this.vault.commit({[cursorKey]:String(message.id)});return;}
    // Already got it over Mesh, then the sender re-encrypted it for the server: the text must match.
    if(cached?.mesh&&!samePlain(cached.plain,opened.plain))throw new Error('Сообщение по Mesh и с сервера не совпадают.');
    const {plain,sender}=opened;
    // First time this message is cached here (a Mesh copy was already named): name it for the local search index.
    const named=cached&&!isFailed(cached)?{}:await this.historyChange(message.chatId,message.senderId,message.clientId);
    // A lane message says nothing about the normal session with that device (we never answer in the lane): only a normal one marks it.
    await this.vault.commit({...named,protocol:opened.protocol,...(encrypted.lane?{}:{[sessionKey(sender)]:'1'}),[messageKey(message)]:JSON.stringify({fingerprint,plain}),[cursorKey]:String(message.id)});
  }
  /**
   * A message that came over Mesh (Bluetooth) instead of the server. Returns the text to show, or
   * null if it is not for this device or was already received. The server copy, when it arrives
   * later, is matched to this one (decode) and not shown twice.
   */
  async receiveMesh(input:MeshEnvelope):Promise<PlainBody|null> {
    await this.initialize();return this.exclusive(async()=>{
      if(!input||!uuid.test(input.chatId)||!uuid.test(input.clientId)||!uuid.test(input.senderId)||input.senderId===this.userId||!validEncrypted(input.encrypted))return null;
      const key=messageKey(input);if(await this.vault.get(key))return null;
      const fingerprint=await this.sha256(canonicalEncrypted(input.encrypted));
      let opened;
      try{opened=await this.open(input,input.encrypted);}catch(error){if(isNetwork(error))return null;throw error;}
      if(!opened)return null;
      await this.vault.commit({...(await this.historyChange(input.chatId,input.senderId,input.clientId)),protocol:opened.protocol,...(input.encrypted.lane?{}:{[sessionKey(opened.sender)]:'1'}),[key]:JSON.stringify({fingerprint,plain:opened.plain,mesh:true})});
      return opened.plain;
    });
  }

  /**
   * Opens this device's envelopes of a chat in server order, each exactly once: the ratchet, the
   * decrypted copy and the cursor are committed together per message, so a message already opened
   * (or marked failed) is never handed to Signal again. One sync per chat at a time: a second caller
   * shares the running one. `maxPages` (100 messages each) bounds a background catch-up (the chat
   * list at start/resume); it stops with PARTIAL_SYNC and the next sync goes on from the cursor.
   */
  async syncChat(chatId:string,maxPages=SYNC_PAGES):Promise<void> {
    const running=this.syncing.get(chatId);
    if(running){
      if(running.pages>=maxPages)return running.task;
      // A short background catch-up is running and the chat itself is opened: go on after it.
      await running.task.catch(()=>{});return this.syncChat(chatId,maxPages);
    }
    const task=(async()=>{
      await this.initialize();await this.exclusive(async()=>{
        const cursorKey=`cursor:${chatId}`;let after=Number(await this.vault.get(cursorKey)||0);
        for(let page=0;page<maxPages;page++){
          const result=await this.transport.cryptoInbox(this.local!.id,chatId,after);
          if(this.closed)throw new Error('Сессия шифрования завершена.');
          for(const message of result.messages){
            if(message.chatId!==chatId||!Number.isSafeInteger(message.id)||message.id<=after)throw new Error('Неверный порядок зашифрованных сообщений.');
            await this.decode(message,cursorKey);after=message.id;
          }
          if(!result.hasMore)return;
          if(!result.messages.length||result.nextCursor!==after)throw new Error('Сервер вернул неверную страницу сообщений.');
        }
        if(maxPages<SYNC_PAGES){const partial=new Error(PARTIAL_TEXT);partial.name='PartialSync';throw partial;}
        throw new Error(PARTIAL_TEXT);
      });
    })();
    const entry={task,pages:maxPages};this.syncing.set(chatId,entry);try{await task;}finally{if(this.syncing.get(chatId)===entry)this.syncing.delete(chatId);}
  }
  async preview(message:Message):Promise<Message> {
    await this.initialize();return this.exclusive(async()=>{
      if(!message.encrypted&&message.lean){
        // Lean list: our own envelope was already opened from /e2ee/inbox (authenticated by Signal);
        // the text shown is only ever that decrypted copy, never anything from the list itself.
        const stored=parse<CachedMessage|FailedMessage>(await this.vault.get(messageKey(message)));
        if(isFailed(stored))return {...message,text:FAILED_TEXT,attachment:null,cryptoState:'failed'};
        const cached=stored as CachedMessage|null;
        if(cached)return {...message,text:cached.plain.text,attachment:cached.plain.attachment,createdAt:cached.plain.sentAt,cryptoState:'decrypted',...(cached.plain.meta?{meta:cached.plain.meta}:{})};
        return {...message,text:'Зашифрованное сообщение. Открой чат для расшифровки.',attachment:null,cryptoState:'no-key'};
      }
      if(!message.encrypted)return {...message,text:'Сообщение из старой версии без сквозного шифрования.',attachment:null,cryptoState:'legacy'};
      if(!validEncrypted(message.encrypted))return {...message,text:'Проверка сообщения не пройдена.',attachment:null,cryptoState:'invalid'};
      const stored=parse<CachedMessage|FailedMessage>(await this.vault.get(messageKey(message)));
      if(isFailed(stored))return {...message,text:FAILED_TEXT,attachment:null,cryptoState:'failed'};
      const cached=stored as CachedMessage|null;
      if(cached){
        if(cached.fingerprint!==await this.sha256(canonicalEncrypted(message.encrypted)))return {...message,text:'Проверка сообщения не пройдена.',attachment:null,cryptoState:'invalid'};
        return {...message,text:cached.plain.text,attachment:cached.plain.attachment,createdAt:cached.plain.sentAt,cryptoState:'decrypted',...(cached.plain.meta?{meta:cached.plain.meta}:{})};
      }
      const target=message.encrypted.envelopes.some(item=>item.userId===this.userId&&item.deviceId===this.local!.id);
      if(!target)return {...message,text:'Это сообщение недоступно на данном устройстве.',attachment:null,cryptoState:'no-key'};
      const trusted=await this.vault.get(trustKey({userId:message.senderId,id:message.encrypted.senderDeviceId}));
      return {...message,text:trusted?'Зашифрованное сообщение. Открой чат для расшифровки.':'Проверь ключ устройства собеседника в разделе «Защита чата».',attachment:null,cryptoState:trusted?'no-key':'unverified'};
    });
  }
  /** Saved messages («Избранное») live only in this device's SQLCipher vault, never on the server. */
  async loadSaved():Promise<string|null> {return this.loadLocal('saved:v1');}
  async storeSaved(value:string):Promise<void> {return this.storeLocal('saved:v1',value);}
  /** Other device-only data (AI chat history) shares the same encrypted vault under fixed keys. */
  async loadLocal(name:'saved:v1'|'ai:v1'):Promise<string|null> {await this.initialize();return this.exclusive(()=>this.vault.get(name));}
  async storeLocal(name:'saved:v1'|'ai:v1',value:string):Promise<void> {await this.initialize();return this.exclusive(()=>this.vault.commit({[name]:value}));}
  async close():Promise<void> {this.closed=true;await this.tail.catch(()=>{});await this.vault.close();this.local=null;}
}
