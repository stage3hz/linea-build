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
type TrustRecord = { identityKey: string; registrationId: number; checkedAt: string };
type PlainBody = { text: string; attachment: Attachment | null; sentAt: string; meta?: MessageMeta };
type CachedMessage = { fingerprint: string; plain: PlainBody };
type Outbox = { encrypted: EncryptedMessage; plain: PlainBody; peerId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const address = (userId: string, deviceId: string) => `${userId}.${deviceId}`;
const trustKey = (device: Pick<CryptoDevice,'userId'|'id'>) => `trust:${device.userId}:${device.id}`;
const messageKey = (message: Pick<Message,'chatId'|'senderId'|'clientId'>) => `message:${message.chatId}:${message.senderId}:${message.clientId}`;
const outboxKey = (chatId: string, clientId: string) => `outbox:${chatId}:${clientId}`;
const sessionKey = (device: Pick<CryptoDevice,'userId'|'id'>) => `session:${device.userId}:${device.id}`;

export class UntrustedDeviceError extends Error {
  constructor() { super('Проверь коды устройств в разделе «Защита чата». Новые ключи не принимаются автоматически.'); this.name='UntrustedDeviceError'; }
}
export function canonicalEncrypted(value: EncryptedMessage): string {
  return JSON.stringify({scheme:value.scheme,senderDeviceId:value.senderDeviceId,envelopes:[...value.envelopes].sort((a,b)=>`${a.userId}:${a.deviceId}`.localeCompare(`${b.userId}:${b.deviceId}`)).map(item=>({userId:item.userId,deviceId:item.deviceId,type:item.type,body:item.body})),attachmentIds:[...(value.attachmentIds||[])].sort()});
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
  if(!hasOnlyKeys(value,['scheme','senderDeviceId','envelopes','attachmentIds']))return false;
  if(value.scheme!=='signal-v1'||typeof value.senderDeviceId!=='string'||!uuid.test(value.senderDeviceId))return false;
  const envelopes=value.envelopes;
  if(!Array.isArray(envelopes)||envelopes.length<1||envelopes.length>10||!envelopes.every(validEnvelope))return false;
  if(new Set(envelopes.map(envelope=>envelope.deviceId.toLowerCase())).size!==envelopes.length)return false;
  return validAttachmentIds(value.attachmentIds??[]);
}
function validAttachment(value: unknown): value is Attachment | null {
  if(value===null)return true;
  if(!hasOnlyKeys(value,['id','name','mimeType','size','encryption','media','preview']))return false;
  const a=value as Attachment;const e=a.encryption;
  if(!hasOnlyKeys(e,['scheme','key','nonce','fileKeyId']))return false;
  return uuid.test(a.id)&&typeof a.name==='string'&&a.name.length>0&&a.name.length<=240&&typeof a.mimeType==='string'&&a.mimeType.length<=150&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size<=20*1024*1024&&!!e&&e.scheme==='aes-256-gcm-siv'&&/^[A-Za-z0-9+/]{43}=$/.test(e.key)&&/^[A-Za-z0-9+/]{16}$/.test(e.nonce)&&uuid.test(e.fileKeyId)&&validMedia(a.media)&&validPreview(a.preview);
}

/** Application integration of the official native Signal library, not a new cipher. */
export class CryptoService {
  private tail: Promise<unknown> = Promise.resolve();
  private initializing: Promise<void> | null = null;
  private local: LocalDevice | null = null;
  private closed = false;
  private syncing = new Map<string,Promise<void>>();
  constructor(
    readonly userId: string, private readonly transport: CryptoTransport,
    private readonly bridge: SignalBridge, private readonly vault: PrivateVault,
    private readonly randomUUID: ()=>string, private readonly sha256: (value:string)=>Promise<string>,
  ) {}
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
    return devices.sort((a,b)=>address(a.userId,a.id).localeCompare(address(b.userId,b.id)));
  }
  private async snapshot(peerId:string):Promise<TrustSnapshot> {
    const targets=await this.targets(peerId);const local=this.local!;
    const selfIdentity=`${address(this.userId,local.id)}:${local.bundle.identityKey}:${local.bundle.registrationId}`;
    const devices=await Promise.all(targets.map(async device=>{
      const trusted=parse<TrustRecord>(await this.vault.get(trustKey(device)));
      const pair=[selfIdentity,`${address(device.userId,device.id)}:${device.identityKey}:${device.registrationId}`].sort();
      const code=await this.sha256(`linea-safety-code-v1\u0000${pair.join('\u0000')}`);
      return {...device,code:code.toUpperCase().match(/.{1,4}/g)!.join(' '),trusted:!!trusted&&sameDevice(trusted,device),self:device.userId===this.userId};
    }));
    return {peerId,ownDeviceId:local.id,devices,fingerprint:await this.sha256(JSON.stringify(devices.map(device=>[device.userId,device.id,device.identityKey,device.registrationId])))};
  }
  async trustSnapshot(peerId:string):Promise<TrustSnapshot> {await this.initialize();return this.exclusive(()=>this.snapshot(peerId));}
  async approveDevices(snapshot:TrustSnapshot):Promise<void> {
    await this.initialize();return this.exclusive(async()=>{
      const current=await this.snapshot(snapshot.peerId);
      if(current.ownDeviceId!==snapshot.ownDeviceId||current.fingerprint!==snapshot.fingerprint)throw new Error('Список устройств изменился. Сверь обновлённые коды.');
      let state=(await this.vault.get('protocol'))!;const changes:Record<string,string>={};
      for(const device of current.devices){
        const previous=parse<TrustRecord>(await this.vault.get(trustKey(device)));
        if(previous&&!sameDevice(previous,device))throw new UntrustedDeviceError();
        state=(await this.bridge.trustIdentity(state,address(device.userId,device.id),1,device.identityKey)).state;
        changes[trustKey(device)]=JSON.stringify({identityKey:device.identityKey,registrationId:device.registrationId,checkedAt:new Date().toISOString()});
      }
      await this.vault.commit({...changes,protocol:state});
    });
  }
  async encrypt(chatId:string,peerId:string,clientId:string,text:string,attachment:Attachment|null,meta?:MessageMeta):Promise<EncryptedMessage> {
    await this.initialize();return this.exclusive(async()=>{
      if(!uuid.test(chatId)||!uuid.test(clientId)||typeof text!=='string'||text.length>8000||(!text.trim()&&!attachment)||!validAttachment(attachment)||!validMeta(meta))throw new Error('Некорректное содержимое сообщения.');
      const key=outboxKey(chatId,clientId);const previous=parse<Outbox>(await this.vault.get(key));
      if(previous){
        if(previous.peerId!==peerId||previous.plain.text!==text||JSON.stringify(previous.plain.attachment)!==JSON.stringify(attachment)||JSON.stringify(previous.plain.meta)!==JSON.stringify(meta))throw new Error('Идентификатор сообщения уже использован.');
        return previous.encrypted; // Retries reuse exactly the committed ciphertext.
      }
      const targets=await this.targets(peerId);let state=(await this.vault.get('protocol'))!;
      const plain:PlainBody={text,attachment,sentAt:new Date().toISOString(),...(meta?{meta}:{})};const changes:Record<string,string>={};
      const encrypted:EncryptedMessage={scheme:'signal-v1',senderDeviceId:this.local!.id,envelopes:[],attachmentIds:attachment?[attachment.id]:[]};
      for(const device of targets){
        const trusted=parse<TrustRecord>(await this.vault.get(trustKey(device)));
        if(!trusted||!sameDevice(trusted,device))throw new UntrustedDeviceError();
        let bundle:ClaimedBundle|null=null;
        if(!(await this.vault.get(sessionKey(device)))){
          const claimed=await this.transport.claimPreKey(device.userId,device.id);
          if(claimed.device.id!==device.id||claimed.device.userId!==device.userId||!sameDevice(claimed.device,device)||!sameDevice(claimed.bundle,device))throw new UntrustedDeviceError();
          bundle=claimed.bundle;
        }
        const payload=JSON.stringify({version:1,chatId,clientId,senderId:this.userId,senderDeviceId:this.local!.id,recipientId:device.userId,recipientDeviceId:device.id,...plain});
        const result=await this.bridge.encrypt(state,address(device.userId,device.id),1,payload,bundle);
        state=result.state;changes[sessionKey(device)]='1';encrypted.envelopes.push({userId:device.userId,deviceId:device.id,type:result.type,body:result.body});
      }
      const fingerprint=await this.sha256(canonicalEncrypted(encrypted));
      changes[key]=JSON.stringify({encrypted,plain,peerId});
      changes[messageKey({chatId,clientId,senderId:this.userId})]=JSON.stringify({fingerprint,plain});
      // Atomic ratchet + outbox + local history commit BEFORE the network send.
      await this.vault.commit({...changes,protocol:state});return encrypted;
    });
  }
  async delivered(chatId:string,clientId:string):Promise<void> {await this.initialize();return this.exclusive(()=>this.vault.commit({[outboxKey(chatId,clientId)]:null}));}
  async rejectedDeviceSet(chatId:string,clientId:string):Promise<void> {
    await this.initialize();return this.exclusive(()=>this.vault.commit({[outboxKey(chatId,clientId)]:null,[messageKey({chatId,clientId,senderId:this.userId})]:null}));
  }
  private async decode(message:Message,cursorKey:string):Promise<void> {
    const encrypted=message.encrypted;
    if(!validEncrypted(encrypted))throw new Error('Некорректный зашифрованный пакет.');
    const fingerprint=await this.sha256(canonicalEncrypted(encrypted));const cached=parse<CachedMessage>(await this.vault.get(messageKey(message)));
    if(cached){
      if(cached.fingerprint!==fingerprint)throw new Error('Сервер изменил сохранённое сообщение.');
      await this.vault.commit({[cursorKey]:String(message.id)});return;
    }
    const envelope=encrypted.envelopes.find(item=>item.userId===this.userId&&item.deviceId===this.local!.id);
    if(!envelope) {await this.vault.commit({[cursorKey]:String(message.id)});return;}
    const sender={userId:message.senderId,id:encrypted.senderDeviceId};
    const trusted=parse<TrustRecord>(await this.vault.get(trustKey(sender)));
    if(!trusted)throw new UntrustedDeviceError();
    let state=(await this.vault.get('protocol'))!;
    state=(await this.bridge.trustIdentity(state,address(sender.userId,sender.id),1,trusted.identityKey)).state;
    const result=await this.bridge.decrypt(state,address(sender.userId,sender.id),1,envelope.type,envelope.body);
    const body=JSON.parse(result.plaintext);
    if(body.version!==1||body.chatId!==message.chatId||body.clientId!==message.clientId||body.senderId!==message.senderId||body.senderDeviceId!==encrypted.senderDeviceId||body.recipientId!==this.userId||body.recipientDeviceId!==this.local!.id||typeof body.text!=='string'||body.text.length>8000||!validAttachment(body.attachment)||typeof body.sentAt!=='string'||!Number.isFinite(Date.parse(body.sentAt))||!validMeta(body.meta))throw new Error('Содержимое не соответствует адресу сообщения.');
    const attachmentIds=body.attachment?[body.attachment.id]:[];
    if(JSON.stringify([...(encrypted.attachmentIds||[])].sort())!==JSON.stringify(attachmentIds))throw new Error('Неверная привязка зашифрованного вложения.');
    const plain:PlainBody={text:body.text,attachment:body.attachment,sentAt:body.sentAt,...(body.meta?{meta:body.meta}:{})};
    await this.vault.commit({protocol:result.state,[sessionKey(sender)]:'1',[messageKey(message)]:JSON.stringify({fingerprint,plain}),[cursorKey]:String(message.id)});
  }
  async syncChat(chatId:string):Promise<void> {
    if(this.syncing.has(chatId))return this.syncing.get(chatId)!;
    const task=(async()=>{
      await this.initialize();await this.exclusive(async()=>{
        const cursorKey=`cursor:${chatId}`;let after=Number(await this.vault.get(cursorKey)||0);
        for(let page=0;page<100;page++){
          const result=await this.transport.cryptoInbox(this.local!.id,chatId,after);
          if(this.closed)throw new Error('Сессия шифрования завершена.');
          for(const message of result.messages){
            if(message.chatId!==chatId||!Number.isSafeInteger(message.id)||message.id<=after)throw new Error('Неверный порядок зашифрованных сообщений.');
            await this.decode(message,cursorKey);after=message.id;
          }
          if(!result.hasMore)return;
          if(!result.messages.length||result.nextCursor!==after)throw new Error('Сервер вернул неверную страницу сообщений.');
        }
        throw new Error('Загружена часть истории. Открой чат ещё раз, чтобы продолжить безопасную расшифровку.');
      });
    })();
    this.syncing.set(chatId,task);try{await task;}finally{this.syncing.delete(chatId);}
  }
  async preview(message:Message):Promise<Message> {
    await this.initialize();return this.exclusive(async()=>{
      if(!message.encrypted)return {...message,text:'Сообщение из старой версии без сквозного шифрования.',attachment:null,cryptoState:'legacy'};
      if(!validEncrypted(message.encrypted))return {...message,text:'Проверка сообщения не пройдена.',attachment:null,cryptoState:'invalid'};
      const cached=parse<CachedMessage>(await this.vault.get(messageKey(message)));
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
  async close():Promise<void> {this.closed=true;await this.tail.catch(()=>{});await this.vault.close();this.local=null;}
}
