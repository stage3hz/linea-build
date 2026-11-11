import { UntrustedDeviceError, type HistoryItem } from './e2ee/core';
import { reportFailure } from './servers/pool';
import { networkTier } from './network/quality';
import { meshActive, useMeshActive } from './nearby/meshState';
import { onMesh, packetIdOf, publishMessage, publishReceipt, startMesh, stopMesh } from './nearby/meshRuntime';
import { forwardLabel, visibleText } from './safeText';
/** What the other side wrote is shown without hidden characters (file names like «фото‮gpj.exe»). */
const cleanShown=(message:Message):Message=>{let next=message;if(next.attachment?.name&&visibleText(next.attachment.name)!==next.attachment.name)next={...next,attachment:{...next.attachment,name:visibleText(next.attachment.name)||'файл'}};if(next.meta?.forward){const from=forwardLabel(next.meta.forward.from);next={...next,meta:{...next.meta,forward:{from:from??''}}};}return next;};
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSaved } from './saved/useSaved';
import { useAIHistory } from './ai/history';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Api, ApiError, NetworkError } from './api';
import type { Attachment, Chat, LocalFile, Message, PendingMessage, Presence, RecoveryRequest, User } from './types';
import { CryptoRuntime } from './e2ee/runtime';
import { cancelLargeUpload, clearDecryptedAttachmentCache, encryptAndUpload, encryptAndUploadLarge } from './e2ee/attachments';
import type { TrustSnapshot } from './e2ee/types';
import { ALBUM_SIZE, appendAttachments, messageAttachmentBatch } from './messageAttachments';
import { stabilizeById } from './stable';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getChatPreferences } from './chatPreferences';
import { useDesktopNotifications } from './notifications/desktopNotify';
import { actionFallback, chatListText, isQuietAction, listPreviewMessage, messageKey, pollFallback, skippedInList, type MessageAction, type MessageMeta, type Poll } from './messageMeta';
import { packEntities, sliceEntities, type Entity } from './format/entities';
import { mediaPreviewKind } from './media/formats';
import { isVideoNote, isVoice } from './voice/voice';
const isAlbumMedia=(file:Attachment)=>{const kind=mediaPreviewKind(file);return (kind==='photo'||kind==='video')&&!isVoice(file)&&!isVideoNote(file);};
import { decryptAttachment } from './e2ee/attachments';
import { resetMediaCache } from './media/mediaCache';
import { applyPage, mergeMessages } from './messagePages';
import { countsAsUnread, coversUnread, readUpTo, readWatermark, reconcileUnread } from './chatUnread';
import { MessageIndex, type SearchGroup, type SearchOptions } from './search/messageIndex';
import { awaitsInbox, catchUpTargets, CATCH_UP_DEEP, CATCH_UP_PAGES, keepOpened, recentlyTried, settled, syncForList, afterSync, type Tried } from './listCatchUp';
import { connectionHeld, holdConnection, socketTick } from './connectionHold';
import { useVoice } from './communities/voice';
import { attachChannelOutbox, resetChannelOutbox } from './communities/channelOutbox';
import { clearLogins, noteSocketEvent } from './sessionAlerts';
import { canResend, pushKind, scheduledIntentKey, withSendOptions, type ScheduledItem, type SendOptions } from './scheduled/model';
import { afterRefresh, isConnectivityError, listStillLoading } from './network/offline';
import { onOnlineChange } from './network/netChange';
import { CHAT_LIST_CACHE, chatPageCacheKey, decodeChatList, decodeChatPage, encodeChatList, encodeChatPage, restoreChats } from './chatListCache';

const HIDDEN_LIMIT = 5000;

const sortedChats = (chats: readonly Chat[]) => [...chats].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
/** A successful list refresh over the one on screen: lines already opened here stay opened (listCatchUp.ts). */
export const mergeRefreshed = (previous: readonly Chat[], next: readonly Chat[]) => sortedChats(keepOpened(next, previous));
const MESH_ID_BASE = 9e15; // local ids for messages that came over Mesh, after every server id
export type Connection = 'connecting'|'connected'|'offline';

export function useMessenger(api: Api, user: User, onExpired: ()=>void) {
  const [chats,setChats]=useState<Chat[]>([]);
  const [messages,setMessages]=useState<Record<string,Message[]>>({});
  const [hasMore,setHasMore]=useState<Record<string,boolean>>({});
  const [pending,setPending]=useState<PendingMessage[]>([]);const retryAtRef=useRef(new Map<string,number>());const pendingRef=useRef(pending);pendingRef.current=pending;
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [connection,setConnection]=useState<Connection>('connecting');
  const [listLoading,setListLoading]=useState(true);
  const [messageLoading,setMessageLoading]=useState(false);
  const [error,setError]=useState('');
  const [typing,setTyping]=useState<Record<string,number>>({});
  const [presence,setPresence]=useState<Record<string,Presence>>({});
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [draftFiles,updateDraftFiles]=useState<Record<string,Attachment[]>>({});
  const draftFilesRef=useRef(draftFiles);draftFilesRef.current=draftFiles;
  const [recoveryRequests,setRecoveryRequests]=useState<RecoveryRequest[]>([]);
  const [recoveryError,setRecoveryError]=useState('');
  const [cryptoError,setCryptoError]=useState('');
  // Telegram offline: «Ожидание сети…» / «Соединение…» / «Обновление…» in the title (network/offline.ts), no error cards.
  const [online,setOnline]=useState<boolean|null>(null);const [updating,setUpdating]=useState(false);
  // The list shown comes from the server once (`serverLoaded`); until then from the vault's cache (chatListCache.ts).
  const serverLoaded=useRef(false);const cacheRead=useRef(false);const [fresh,setFresh]=useState(false);
  // "Delete for me": a local list of message keys, per account, never sent to the server.
  const hiddenKey=`linea.hidden.v1:${user.id}`;
  const [hidden,setHidden]=useState<ReadonlySet<string>>(new Set());
  useEffect(()=>{let live=true;AsyncStorage.getItem(hiddenKey).then(raw=>{if(!live||!raw)return;try{const list=JSON.parse(raw);if(Array.isArray(list))setHidden(new Set(list.filter((x:unknown)=>typeof x==='string')));}catch{}}).catch(()=>{});return()=>{live=false;};},[hiddenKey]);
  const cryptoRuntime=useMemo(()=>new CryptoRuntime(api,user.id),[api,user.id]);
  const saved=useSaved(cryptoRuntime);
  const aiHistory=useAIHistory(cryptoRuntime);
  const recoveryFetchRef=useRef(0);
  const socketRef=useRef<WebSocket|null>(null);
  const selectedRef=useRef(selectedId);selectedRef.current=selectedId;
  const appState=useRef(AppState.currentState);
  const messagesRef=useRef(messages);messagesRef.current=messages;
  const hasMoreRef=useRef(hasMore);hasMoreRef.current=hasMore;
  // Recent pages read quietly for the list preview (chat not opened): used to count unread ourselves.
  const quietPages=useRef<Record<string,{messages:Message[];hasMore:boolean}>>({});
  const chatsRef=useRef(chats);chatsRef.current=chats;
  const readRef=useRef<Record<string,number>>({});
  const aliveRef=useRef(true);
  const onExpiredRef=useRef(onExpired);onExpiredRef.current=onExpired;
  const checkError=useCallback((e:unknown)=>{
    if(aliveRef.current&&e instanceof ApiError&&e.status===401)onExpiredRef.current();
    // Native Signal errors («Call to function 'LineaSignal.decrypt' has been rejected… CRYPTO_FAILED») are
    // not for people: say what happens instead.
    if(e instanceof Error&&/LineaSignal|CRYPTO_FAILED|Signal operation/i.test(e.message))return 'Не удалось расшифровать сообщение. Нажми «Повторить»: если не выйдет, оно будет пропущено, а остальные откроются.';
    return e instanceof Error?e.message:'Произошла ошибка. Попробуй ещё раз.';
  },[]);
  /** checkError, but a connection problem shows nothing: the title says it and everything retries by itself. */
  const quietError=useCallback((e:unknown)=>{const text=checkError(e);return isConnectivityError(e)?'':text;},[checkError]);

  useEffect(()=>{
    let current=true;
    // Publish this installation's public keys even when the account has no chats.
    // Otherwise an online new account would be unable to receive its first message.
    void cryptoRuntime.get().then(service=>service.initialize()).catch(e=>{if(current)setCryptoError(quietError(e));});
    // Decrypted media stays on disk between launches (as in Telegram) for the same account;
    // a different account, sign-out or session end wipes it.
    resetMediaCache();
    void AsyncStorage.getItem('linea.media-cache-owner').then(owner=>{if(owner!==user.id)return clearDecryptedAttachmentCache().then(()=>AsyncStorage.setItem('linea.media-cache-owner',user.id));}).catch(()=>{});
    // The files are NOT wiped here: this cleanup also runs when the screen remounts (session refresh at
    // launch), which deleted every decrypted photo and video so they downloaded again after each restart.
    // Sign-out wipes them explicitly (App.logout); another account wipes them via the owner check above.
    return()=>{current=false;void cryptoRuntime.close();resetMediaCache();};
  },[cryptoRuntime,quietError]);

  // G029: local search over the decrypted history. The index lives in memory only and is fed by every
  // message decrypted here (hydrate) and, at startup, by the vault's cache (CryptoService.history).
  const searchIndex=useRef(new MessageIndex());const [searchVersion,setSearchVersion]=useState(0);const searchBump=useRef<ReturnType<typeof setTimeout>|null>(null);
  const bumpSearch=useCallback(()=>{if(searchBump.current)return;searchBump.current=setTimeout(()=>{searchBump.current=null;if(aliveRef.current)setSearchVersion(v=>v+1);},300);},[]);
  useEffect(()=>()=>{if(searchBump.current)clearTimeout(searchBump.current);},[]);
  // The first chat list is on screen: only then is the index filled from the vault (see the startup effect).
  const listReady=useRef<{promise:Promise<void>;resolve:()=>void}|null>(null);
  if(!listReady.current){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});listReady.current={promise,resolve};}
  const indexMessage=useCallback((message:Pick<Message,'chatId'|'senderId'|'clientId'|'text'|'attachment'|'createdAt'|'cryptoState'|'meta'>)=>{
    if(message.cryptoState!=='decrypted')return;
    const action=message.meta?.action;
    if(action){
      // Only the author edits (same senderId). A delete for both may name either side's message in a
      // one-to-one chat (Telegram), so both participants' keys are tombstoned.
      if(action.type==='delete'){
        const peerId=chatsRef.current.find(chat=>chat.id===message.chatId)?.peer?.id;
        const other=message.senderId===user.id?peerId:user.id;
        let changed=searchIndex.current.tombstone({chatId:message.chatId,senderId:message.senderId,clientId:action.target});
        if(other&&other!==message.senderId&&searchIndex.current.tombstone({chatId:message.chatId,senderId:other,clientId:action.target}))changed=true;
        if(changed)bumpSearch();
      }
      else if(action.type==='edit'){if(searchIndex.current.edit({chatId:message.chatId,senderId:message.senderId,clientId:action.target},action.text,message.createdAt))bumpSearch();}
      return; // reactions, pins, votes, calls: nothing to search in
    }
    if(searchIndex.current.add({chatId:message.chatId,senderId:message.senderId,clientId:message.clientId,text:message.text,sentAt:message.createdAt,...(message.attachment?{attachmentName:message.attachment.name}:{})}))bumpSearch();
  },[bumpSearch,user.id]);
  const searchMessages=useCallback((query:string,options?:SearchOptions):SearchGroup[]=>searchIndex.current.search(query,options),[]);
  // A result tapped in the global search: the chat opens and scrolls to that message (ChatScreen watches `focus`).
  const [focus,setFocus]=useState<{chatId:string;clientId:string;sentAt?:string;at:number}|null>(null);
  /** `sentAt`: when the message was sent, so the chat knows how far back to load before giving up. */
  const focusMessage=useCallback((chatId:string,clientId:string,sentAt?:string)=>setFocus({chatId,clientId,...(sentAt?{sentAt}:{}),at:Date.now()}),[]);
  const clearFocus=useCallback(()=>setFocus(null),[]);
  /** `opened: false` — the vault or Signal threw: the placeholder is not this device's verdict on the message. */
  const hydrateChecked=useCallback(async(message:Message):Promise<{message:Message;opened:boolean}>=>{
    try{const shown=cleanShown(await(await cryptoRuntime.get()).preview(message));indexMessage(shown);return {message:shown,opened:true};}
    catch(e){if(aliveRef.current)setCryptoError(quietError(e));return {message:{...message,text:message.legacy?'Сообщение из старой версии без сквозного шифрования.':'Зашифрованное сообщение недоступно на этом устройстве.',attachment:null,cryptoState:message.legacy?'legacy':'no-key'},opened:false};}
  },[cryptoRuntime,quietError,indexMessage]);
  const hydrate=useCallback(async(message:Message):Promise<Message>=>(await hydrateChecked(message)).message,[hydrateChecked]);

  const refreshRecoveryRequests=useCallback(async()=>{
    const revision=++recoveryFetchRef.current;
    try {
      const result=await api.recoveryRequests();
      if(aliveRef.current&&revision===recoveryFetchRef.current){setRecoveryRequests(result.requests);setRecoveryError('');}
    } catch(e) {
      // Offline is not «не удалось проверить»: the last known requests stay, the next poll / reconnect asks again.
      if(aliveRef.current&&revision===recoveryFetchRef.current)setRecoveryError(quietError(e));
    }
  },[api,quietError]);
  const cancelRecovery=useCallback(async(requestId:string)=>{
    try {
      await api.cancelRecovery(requestId);
      // Ignore a list request that started before the cancellation completed.
      ++recoveryFetchRef.current;
      if(aliveRef.current){setRecoveryRequests(current=>current.filter(request=>request.id!==requestId));setRecoveryError('');}
      await refreshRecoveryRequests();
    }catch(e){throw new Error(checkError(e));}
  },[api,checkError,refreshRecoveryRequests]);

  // The list line of a chat not opened yet: its last message is opened in the background (listCatchUp.ts).
  // `caughtUp`: chat → last message id whose inbox went through (never tried again); `tried`: the last
  // try per chat — a try that did not get through waits RETRY_AFTER_MS for that message (no retry storm).
  const caughtUp=useRef(new Map<string,number>());const tried=useRef(new Map<string,Tried>());
  const catchUpBusy=useRef(false);const catchUpAgain=useRef<Chat[]|null>(null);
  const catchUp=useCallback(async(list:Chat[])=>{
    if(catchUpBusy.current){catchUpAgain.current=list;return;}
    catchUpBusy.current=true;
    try{
      let current:Chat[]|null=list;
      while(current&&aliveRef.current){
        catchUpAgain.current=null;
        const now=Date.now();
        const targets=catchUpTargets(current,(chatId,id)=>caughtUp.current.get(chatId)===id||recentlyTried(tried.current.get(chatId),id,now));
        if(!targets.length)break;
        const crypto=await cryptoRuntime.get();let deep=CATCH_UP_DEEP;
        for(const chatId of targets){
          if(!aliveRef.current)return;
          const last=(chatsRef.current.find(c=>c.id===chatId)??current.find(c=>c.id===chatId))?.lastMessage;
          if(!awaitsInbox(last))continue;
          tried.current.set(chatId,{id:last.id,at:Date.now()});
          // Shared with a sync already running for this chat (socket, opened chat): never decrypted twice.
          // A long queue (PartialSync) goes on from the cursor for a couple of chats per round.
          const outcome=await syncForList(()=>crypto.syncChat(chatId,CATCH_UP_PAGES),deep>0);
          if(outcome==='network')return;
          if(outcome!=='synced'&&deep>0)deep--;
          const {message:opened,opened:ok}=await hydrateChecked(last);
          // Only this device's real verdict (preview without an exception) after a full sync says «недоступно».
          const {line:shown,caughtUp:done}=afterSync(opened,outcome,ok);
          if(done)caughtUp.current.set(chatId,last.id);
          if(!aliveRef.current)return;
          if(shown!==last)setChats(prev=>prev.map(c=>c.id===chatId&&c.lastMessage?.id===last.id?{...c,lastMessage:shown}:c));
        }
        current=catchUpAgain.current;
      }
    }catch{/* no vault here (browser) or the session ended */}
    finally{catchUpBusy.current=false;}
  },[cryptoRuntime,hydrateChecked]);
  const refreshChats=useCallback(async()=>{
    try {
      const result=await api.chats();const next=await Promise.all(result.chats.map(async chat=>{
        if(!chat.lastMessage)return {...chat,lastMessage:null};
        const {message:last,opened}=await hydrateChecked(chat.lastMessage);
        return {...chat,lastMessage:opened&&caughtUp.current.get(chat.id)===last.id?settled(last):last};
      }));
      // The server counts reactions and edits of the peer as unread (it cannot see inside); our count wins where the messages are here.
      // A chat not opened in this session may hold only a socket message or two (a reaction): that set does not cover the watermark, so the quiet page speaks instead.
      const counted=next.map(chat=>{const loaded=messagesRef.current[chat.id];const quiet=quietPages.current[chat.id];return coversUnread(chat,loaded,hasMoreRef.current[chat.id])?reconcileUnread(chat,loaded,user.id,hasMoreRef.current[chat.id]):quiet?reconcileUnread(chat,quiet.messages,user.id,quiet.hasMore):chat;});
      if(aliveRef.current){
        const merged=keepOpened(counted,chatsRef.current);
        // Only a successful answer replaces the list (a failed one below keeps what is on screen).
        serverLoaded.current=true;setFresh(true);
        setChats(prev=>afterRefresh(prev,{ok:true,value:counted},checkError,mergeRefreshed).list as Chat[]);setError('');setListLoading(false);
        void catchUp(merged);
      }
    }
    catch(e){
      // Offline / server out of reach: the chats on screen (memory or the vault's cache) stay, no error card;
      // the skeleton stays only while there is nothing at all to show. A real error ends the wait and is shown.
      if(aliveRef.current){
        const text=afterRefresh(chatsRef.current,{ok:false,error:e},checkError).error;setError(text);
        if(!listStillLoading({chats:chatsRef.current.length,serverLoaded:serverLoaded.current,failure:text?'error':'connectivity'}))setListLoading(false);
      }
    }
    finally {listReady.current?.resolve();}
  },[api,checkError,hydrateChecked,user.id,catchUp]);
  // The vault's copy of the last list: on screen at once, before (or without) the network.
  useEffect(()=>{
    let live=true;
    cryptoRuntime.get().then(crypto=>crypto.loadCache(CHAT_LIST_CACHE)).then(raw=>{
      if(!live||!aliveRef.current)return;
      const cached=decodeChatList(raw);
      if(cached.length&&!serverLoaded.current){setChats(prev=>sortedChats([...restoreChats(prev,cached,serverLoaded.current)]));setListLoading(false);}
    }).catch(()=>{/* no vault here (browser) */}).finally(()=>{if(live)cacheRead.current=true;});
    return()=>{live=false;};
  },[cryptoRuntime,user.id]);
  // …and kept current: written a moment after the list changes (only once the cache was read, so an
  // empty list at start never overwrites it; an empty list is written only when the server said so).
  useEffect(()=>{
    if(!cacheRead.current&&!serverLoaded.current)return;
    if(!chats.length&&!serverLoaded.current)return;
    const timer=setTimeout(()=>{void cryptoRuntime.get().then(crypto=>crypto.storeCache(CHAT_LIST_CACHE,encodeChatList(chats))).catch(()=>{});},1500);
    return()=>clearTimeout(timer);
  },[chats,cryptoRuntime]);
  // ---- F4 «Отправить позже» ----
  // Which pending messages the server is to keep until a time (clientId → ISO). Kept per account outside
  // the vault (no text in it) so a message restored from the vault outbox after a restart is scheduled
  // again instead of going out at once; performSend waits for it to load.
  const intentKey=scheduledIntentKey(user.id);
  const scheduledIntent=useRef(new Map<string,string>());const intentReady=useRef<Promise<void>>(Promise.resolve());
  useEffect(()=>{let live=true;intentReady.current=AsyncStorage.getItem(intentKey).then(raw=>{if(!live||!raw)return;try{const value=JSON.parse(raw);if(value&&typeof value==='object')for(const [key,at] of Object.entries(value))if(typeof at==='string')scheduledIntent.current.set(key,at);}catch{/* a fresh account */}}).catch(()=>{});return()=>{live=false;};},[intentKey]);
  const saveIntent=useCallback(()=>{void AsyncStorage.setItem(intentKey,JSON.stringify(Object.fromEntries(scheduledIntent.current))).catch(()=>{});},[intentKey]);
  const [scheduled,setScheduled]=useState<ScheduledItem[]>([]);
  const [scheduledBusy,setScheduledBusy]=useState<ReadonlySet<string>>(new Set());
  const scheduledFetch=useRef(0);
  /** The server's list (ciphertext + time) opened with this device's vault: a message encrypted here is cached under its clientId, so its text shows; one scheduled from another device stays closed. */
  const refreshScheduled=useCallback(async()=>{
    const revision=++scheduledFetch.current;
    try{
      // lean: no ciphertext over the wire on every refresh — our copy of the text is in the vault under the clientId (preview of a lean message).
      const {items}=await api.scheduled({lean:true});
      const crypto=await cryptoRuntime.get().catch(()=>null);
      const opened:ScheduledItem[]=await Promise.all(items.map(async item=>{
        const probe:Message={id:0,chatId:item.chatId,senderId:user.id,clientId:item.clientId,text:'',attachment:null,createdAt:item.createdAt,...(item.encrypted?{encrypted:item.encrypted}:{lean:true})};
        try{const shown=crypto?cleanShown(await crypto.preview(probe)):probe;const open=shown.cryptoState==='decrypted';return {...item,text:open?shown.text:'',attachment:open?shown.attachment:null,cryptoState:shown.cryptoState,...(open&&shown.meta?{meta:shown.meta}:{})};}
        catch{return {...item,text:'',attachment:null,cryptoState:'no-key' as const};}
      }));
      if(aliveRef.current&&revision===scheduledFetch.current)setScheduled(opened);
    }catch(e){checkError(e);}
  },[api,cryptoRuntime,user.id,checkError]);
  // «Прочитать» from the chat list (swipe or edit mode): no need to have the chat open. The list
  // shows the last real message, so the newest server message (a reaction, an edit) is read from here.
  const readChat=useCallback(async(chatId:string,shownId:number)=>{
    const messageId=readUpTo(chatsRef.current.find(c=>c.id===chatId),shownId);
    if(!messageId||(readRef.current[chatId]||0)>=messageId)return;
    readRef.current[chatId]=messageId;
    try { const result=await api.read(chatId,messageId);if(aliveRef.current)setChats(prev=>prev.map(c=>c.id===chatId?{...c,unreadCount:0,lastReadMessageId:result.lastReadMessageId}:c)); }
    catch(e) {readRef.current[chatId]=0;checkError(e);}
  },[api,checkError]);
  const markRead=useCallback(async(chatId:string,messageId:number)=>{
    if(!messageId||selectedRef.current!==chatId||appState.current!=='active'||(readRef.current[chatId]||0)>=messageId)return;
    readRef.current[chatId]=messageId;
    try { const result=await api.read(chatId,messageId);if(aliveRef.current)setChats(prev=>prev.map(c=>c.id===chatId?{...c,unreadCount:0,lastReadMessageId:result.lastReadMessageId}:c)); }
    catch(e) {readRef.current[chatId]=0;checkError(e);}
  },[api,checkError]);

  const loadMessages=useCallback(async(chatId:string,older=false)=>{
    const current=messagesRef.current[chatId]||[];
    if(older&&!current.length)return;
    setMessageLoading(true);
    // Not loaded in this session: the page shown last time (vault cache) is on screen at once, also offline.
    const pageKey=chatPageCacheKey(chatId);
    if(!older&&!current.length&&pageKey){
      const cached=await cryptoRuntime.get().then(crypto=>crypto.loadCache(pageKey)).then(raw=>decodeChatPage(raw,chatId)).catch(()=>null);
      if(cached&&aliveRef.current&&!(messagesRef.current[chatId]||[]).length){
        messagesRef.current={...messagesRef.current,[chatId]:cached.messages};
        setMessages(prev=>prev[chatId]?.length?prev:{...prev,[chatId]:cached.messages});
        setHasMore(prev=>chatId in prev?prev:{...prev,[chatId]:cached.hasMore});
      }
    }
    try {
      // The page request goes out together with the inbox sync (one network round trip saved before the chat shows);
      // decryption stays sequential: hydrate runs only after the sync has consumed the envelopes.
      const pageRequest=api.messages(chatId,older?current[0].id:undefined);pageRequest.catch(()=>{});
      let deviceId:string|null=null,synced=false;
      try {const crypto=await cryptoRuntime.get();deviceId=crypto.deviceId;await crypto.syncChat(chatId);synced=true;if(aliveRef.current)setCryptoError('');}
      catch(e){if(aliveRef.current)setCryptoError(quietError(e));}
      const result=await pageRequest;
      result.messages=await Promise.all(result.messages.map(hydrate));
      if(!aliveRef.current)return;
      // The latest page replaces only its own range: history scrolled up earlier survives a reconnect.
      const applied=applyPage(messagesRef.current[chatId]||[],result.messages,{older,hasMore:result.hasMore,prevHasMore:hasMoreRef.current[chatId]});
      setMessages(prev=>({...prev,[chatId]:applied.messages}));
      const confirmed = new Set(result.messages.filter(message=>message.senderId===user.id).map(message=>message.clientId));
      setPending(prev=>prev.filter(item=>item.chatId!==chatId||!confirmed.has(item.clientId)));
      setHasMore(prev=>({...prev,[chatId]:applied.hasMore}));
      // Read up to the last message that is not still waiting for keys: a message sent before this
      // device signed in (no envelope for it) or a damaged one never changes and must not keep the chat
      // unread. The page is lean (no envelopes), so a no-key message counts as permanent only once the
      // inbox sync of this chat went through (`synced`).
      const watermark=older?0:readWatermark(result.messages,user.id,deviceId,synced);
      if(watermark)void markRead(chatId,watermark);
      setError('');
    }catch(e){if(aliveRef.current)setError(quietError(e));}
    finally {if(aliveRef.current)setMessageLoading(false);}
  },[api,user.id,quietError,markRead,cryptoRuntime,hydrate]);
  // The open chat's newest messages go to the vault cache a moment after they change (see loadMessages).
  useEffect(()=>{
    const chatId=selectedId;const list=chatId?messages[chatId]:undefined;const key=chatId?chatPageCacheKey(chatId):null;
    if(!chatId||!key||!list?.length)return;
    const more=!!hasMore[chatId];
    const timer=setTimeout(()=>{void cryptoRuntime.get().then(crypto=>crypto.storeCache(key,encodeChatPage(list,more))).catch(()=>{});},2000);
    return()=>clearTimeout(timer);
  },[selectedId,messages,hasMore,cryptoRuntime]);

  // Encrypted call signalling (offer / answer / end) is handed to the call screen, not shown as a message.
  // Raw socket events for features outside private chats (channels, voice rooms).
  const socketListeners=useRef(new Set<(data:any)=>void>());
  const onSocket=useCallback((listener:(data:any)=>void)=>{socketListeners.current.add(listener);return()=>{socketListeners.current.delete(listener);};},[]);
  const sendSocket=useCallback((payload:object)=>{const socket=socketRef.current;if(!socket||socket.readyState!==1)return false;socket.send(JSON.stringify(payload));return true;},[]);
  const callListeners=useRef(new Set<(message:Message)=>void>());
  const onCallSignal=useCallback((listener:(message:Message)=>void)=>{callListeners.current.add(listener);return()=>{callListeners.current.delete(listener);};},[]);
  const acceptMessage=useCallback(async(raw:Message)=>{
    try{await(await cryptoRuntime.get()).syncChat(raw.chatId);if(aliveRef.current)setCryptoError('');}catch(e){if(aliveRef.current)setCryptoError(quietError(e));}
    const message=await hydrate(raw);if(!aliveRef.current)return;
    if(message.meta?.action?.type==='call'&&message.senderId!==user.id&&message.cryptoState==='decrypted')callListeners.current.forEach(listener=>{try{listener(message);}catch{/* a broken listener must not drop the message */}});
    setMessages(prev=>({...prev,[message.chatId]:mergeMessages(prev[message.chatId]||[],[message])}));
    setPending(prev=>prev.filter(p=>!(p.chatId===message.chatId&&p.clientId===message.clientId&&message.senderId===user.id)));
    setChats(prev=>sortedChats(prev.map(c=>{
      if(c.id!==message.chatId)return c;
      // The same message, now opened here, replaces a closed line a list refresh put up in the meantime.
      if(c.lastMessage&&c.lastMessage.id===message.id)return awaitsInbox(c.lastMessage)&&!awaitsInbox(message)?{...c,lastMessage:message}:c;
      if(c.lastMessage&&c.lastMessage.id>message.id)return c;
      return {...c,lastMessage:message,updatedAt:isQuietAction(message)?c.updatedAt:message.createdAt,unreadCount:countsAsUnread(message,user.id)?c.unreadCount+1:c.unreadCount};
    })));
    if(message.senderId!==user.id&&message.cryptoState==='decrypted')void markRead(message.chatId,message.id);
  },[user.id,markRead,cryptoRuntime,hydrate,quietError]);

  useEffect(()=>{
    aliveRef.current=true;void refreshChats();void refreshRecoveryRequests();
    // The channel outbox (messages typed offline) sends through this account whichever screen is open; it is flushed on every «ready».
    attachChannelOutbox({userId:user.id,send:item=>api.sendChannelMessage(item.communityId,item.channelId,{text:item.text,clientKey:item.key,...(item.replyTo?{replyTo:item.replyTo}:{})}).then(r=>r.message),onSocket});
    let stopped=false, paused=false, retry:ReturnType<typeof setTimeout>|undefined, attempts=0, lastReceive=Date.now();
    const connect=()=>{
      if(stopped||paused)return;
      const current=socketRef.current;
      if(current&&(current.readyState===WebSocket.OPEN||current.readyState===WebSocket.CONNECTING))return;
      setConnection('connecting');
      const target=api.endpoint;let opened=false;
      const socket=new WebSocket(api.socketUrl());socketRef.current=socket;lastReceive=Date.now();
      socket.onopen=()=>{opened=true;if(!stopped&&socketRef.current===socket)socket.send(JSON.stringify({type:'auth',token:api.token,lean:true}));};
      socket.onmessage=event=>{
        if(stopped||socketRef.current!==socket)return;
        lastReceive=Date.now();
        let data:any;try{data=JSON.parse(String(event.data));}catch{return;}
        // `story` / `story.view` reach the stories strip above the chat list (StoriesStrip).
        if(typeof data.type==='string'&&(data.type.startsWith('community')||data.type.startsWith('voice')||data.type.startsWith('sfu')||data.type.startsWith('story')||data.type==='friends'||data.type==='ready'||data.type==='error'))socketListeners.current.forEach(listener=>{try{listener(data);}catch{/* keep other listeners */}});
        if(data.type==='ready'){
          // «Обновление…» in the title until the list is fresh again (Telegram).
          attempts=0;setConnection('connected');setUpdating(true);void refreshChats().finally(()=>{if(!stopped)setUpdating(false);});void refreshRecoveryRequests();void refreshScheduled();
          if(selectedRef.current)void loadMessages(selectedRef.current);
        }else if(data.type==='message'&&data.message){void acceptMessage(data.message);}
        else if(data.type==='chat'&&data.chat){void refreshChats();}
        else if(data.type==='chat.deleted'&&typeof data.chatId==='string'){const gone=data.chatId;setChats(prev=>prev.filter(c=>c.id!==gone));setMessages(prev=>{const next={...prev};delete next[gone];return next;});if(selectedRef.current===gone)selectChat(null);}
        else if(data.type==='read'){
          setChats(prev=>prev.map(c=>c.id===data.chatId?(data.userId===user.id?{...c,lastReadMessageId:Math.max(c.lastReadMessageId,data.messageId),unreadCount:0}:{...c,peerLastReadMessageId:Math.max(c.peerLastReadMessageId,data.messageId)}):c));
        }else if(data.type==='typing'&&data.userId!==user.id){setTyping(prev=>({...prev,[data.chatId]:data.isTyping?Date.now()+5000:0}));}
        else if(data.type==='profile'&&data.user){setChats(prev=>prev.map(c=>c.peer.id===data.user.id?{...c,peer:data.user}:c));}
        else if(data.type==='presence.snapshot'&&Array.isArray(data.items)){setPresence(Object.fromEntries(data.items.filter((p:any)=>p&&typeof p.userId==='string').map((p:any)=>[p.userId,p])));}
        else if(data.type==='presence'&&data.presence&&typeof data.presence.userId==='string'){setPresence(prev=>({...prev,[data.presence.userId]:data.presence}));}
        else if(data.type==='recovery.requested'||data.type==='recovery.updated'){void refreshRecoveryRequests();}
        else if(data.type==='session.new'){noteSocketEvent(data);}
        else if(data.type==='e2ee.devices'){if(selectedRef.current)void loadMessages(selectedRef.current);void refreshChats();}
        else if(data.type==='scheduled'){void refreshScheduled();}
      };
      socket.onclose=event=>{
        if(stopped||socketRef.current!==socket)return;setConnection('offline');setUpdating(false);
        // The socket alone never signs anyone out: on a slow link (EDGE) the server may close it before
        // our auth frame arrives. Only the HTTP check «is this session really gone?» (401) does.
        if(event.code===4001||event.code===4401){void api.me().then(()=>{if(!stopped)retry=setTimeout(connect,1000);},e=>{if(e instanceof ApiError&&e.status===401)onExpiredRef.current();else if(!stopped)retry=setTimeout(connect,3000);});return;}
        // The server could not be reached at all: try the next one at once instead of backing off.
        if(!opened&&api.endpoint===target){reportFailure(target);}
        retry=setTimeout(connect,!opened&&api.endpoint!==target?300:Math.min(1000*2**attempts++,15000));
      };
      socket.onerror=()=>{if(!stopped&&socketRef.current===socket)setConnection('offline');};
    };
    const reconnect=()=>{
      const previous=socketRef.current;socketRef.current=null;
      previous?.close();if(retry)clearTimeout(retry);connect();
    };
    connect();
    // In the background the connection is closed, so peers see "был(а) только что" as in Telegram —
    // unless a voice room or a call holds it: the server would otherwise drop us from the room on close.
    const sleep=()=>{paused=true;if(retry)clearTimeout(retry);const previous=socketRef.current;socketRef.current=null;previous?.close();setConnection('offline');};
    const heartbeat=setInterval(()=>{
      const socket=socketRef.current;
      // 'inactive' (iOS app switcher, a system call sheet) is not the background: the socket stays.
      const tick=socketTick({foreground:appState.current!=='background',held:connectionHeld(),open:socket?.readyState===WebSocket.OPEN,sinceReceive:Date.now()-lastReceive});
      if(tick==='sleep')sleep();
      else if(tick==='reconnect'){paused=false;reconnect();}
      else if(tick==='ping')socket!.send(JSON.stringify({type:'ping'}));
      else if(paused&&connectionHeld()){paused=false;connect();}
      setTyping(prev=>{const now=Date.now();return Object.values(prev).some(exp=>exp>0&&exp<now)?Object.fromEntries(Object.entries(prev).map(([id,exp])=>[id,exp<now?0:exp])):prev;});
    },3000);
    const subscription=AppState.addEventListener('change',state=>{
      appState.current=state;
      if(state==='active'){
        paused=false;void refreshChats();void refreshRecoveryRequests();void refreshScheduled();if(selectedRef.current)void loadMessages(selectedRef.current);
        // A socket kept alive through the background (call, voice room) is not torn down: that would leave the room.
        if(socketRef.current?.readyState===WebSocket.OPEN&&Date.now()-lastReceive<=15000)connect();else reconnect();
      }
      else if(state==='background'&&!connectionHeld())sleep();
    });
    const recoveryPoll=setInterval(()=>{if(appState.current==='active')void refreshRecoveryRequests();},30000);
    // The network came back: connect now instead of waiting out the back-off (the «ready» refreshes everything).
    const stopOnline=onOnlineChange(up=>{
      if(stopped)return;setOnline(up);
      if(up&&!paused&&appState.current!=='background'){attempts=0;if(retry)clearTimeout(retry);connect();}
    });
    return ()=>{stopped=true;aliveRef.current=false;++recoveryFetchRef.current;if(retry)clearTimeout(retry);clearInterval(heartbeat);clearInterval(recoveryPoll);stopOnline();subscription.remove();socketRef.current?.close();socketRef.current=null;resetChannelOutbox();clearLogins();};
  },[api,user.id,refreshChats,loadMessages,acceptMessage,refreshRecoveryRequests,onSocket,refreshScheduled]);

  const selectChat=useCallback((chat:Chat|null)=>{
    if(selectedRef.current&&socketRef.current?.readyState===WebSocket.OPEN)socketRef.current.send(JSON.stringify({type:'typing',chatId:selectedRef.current,isTyping:false}));
    selectedRef.current=chat?.id||null;setSelectedId(chat?.id||null);setError('');
    if(chat){setChats(prev=>sortedChats([chat,...prev.filter(c=>c.id!==chat.id)]));void loadMessages(chat.id);}
  },[loadMessages]);

  const uploadsRef=useRef(new Map<string,AbortController>());
  /** Peers of the messages restored from the vault outbox (G001), until each is delivered or forgotten; `reencrypted`: the one automatic retry after a device-list change. */
  const restoredPeers=useRef(new Map<string,string>());const reencrypted=useRef(new Set<string>());
  // After a send the list is already updated locally; a full reload is only a check, so several
  // sends share one, and on a slow link (EDGE) it waits longer so it never competes with messages.
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const softRefresh=useCallback(()=>{
    if(refreshTimer.current)return;
    refreshTimer.current=setTimeout(()=>{refreshTimer.current=null;void refreshChats();},networkTier()==='slow'?15000:networkTier()==='medium'?3000:500);
  },[refreshChats]);
  useEffect(()=>()=>{if(refreshTimer.current)clearTimeout(refreshTimer.current);},[]);
  const performSend=useCallback(async(item:PendingMessage)=>{
    let meshBody:string|null=null;let meshPeer='';
    setPending(prev=>[...prev.filter(p=>p.clientId!==item.clientId),{...item,state:'sending',error:undefined}]);
    try {
      // A message restored from the vault outbox (G001) knows its peer even before the chat list has loaded.
      const peerId=chatsRef.current.find(chat=>chat.id===item.chatId)?.peer.id??restoredPeers.current.get(item.clientId);
      if(!peerId)throw new Error('Сначала открой разговор.');
      if(item.upload&&!item.attachment?.encryption){
        // Big file: upload in chunks first, with progress in the bubble. «Повторить» continues where it stopped.
        const abort=new AbortController();uploadsRef.current.set(item.clientId,abort);
        const patch=(change:Partial<NonNullable<PendingMessage['upload']>>)=>{item={...item,upload:{...item.upload!,...change}};setPending(prev=>prev.map(p=>p.clientId===item.clientId?{...p,upload:item.upload}:p));};
        try{
          await(await cryptoRuntime.get()).initialize();
          const uploaded=await encryptAndUploadLarge(api,item.upload.file,{state:item.upload.state,signal:abort.signal,onState:state=>patch({state}),onProgress:(sent,total)=>patch({sent,total})});
          item={...item,attachment:uploaded,upload:undefined};
          setPending(prev=>prev.map(p=>p.clientId===item.clientId?item:p));
        }finally{uploadsRef.current.delete(item.clientId);}
      }
      // F4 «Отправить позже»: encrypted now, for the devices of now, and dated at the chosen time inside the ciphertext;
      // the server keeps the envelopes (never decrypted) and releases them then. Not for Mesh: a phone nearby would deliver it at once.
      await intentReady.current;let deliverAt=scheduledIntent.current.get(item.clientId);
      const crypto=await cryptoRuntime.get();const encrypted=await crypto.encrypt(item.chatId,peerId,item.clientId,item.text,item.attachment,item.meta,deliverAt);
      meshPeer=peerId;meshBody=!item.attachment&&!item.meta?.action&&!deliverAt?JSON.stringify({chatId:item.chatId,clientId:item.clientId,senderId:user.id,encrypted}):null;
      const kind=pushKind(item.meta);let result:{message:Message}|null=null;
      if(deliverAt){
        // A time that passed while the phone was offline is not an error: the message goes out now (Telegram).
        try{await api.scheduleEncrypted(item.chatId,item.clientId,encrypted,deliverAt,kind==='silent'?'silent':undefined);}
        catch(e){if(e instanceof ApiError&&e.code==='SCHEDULE_IN_PAST')deliverAt=undefined;else throw e;}
      }
      if(!deliverAt)result=await api.sendEncrypted(item.chatId,item.clientId,encrypted,kind);
      await crypto.delivered(item.chatId,item.clientId).catch(()=>{});
      restoredPeers.current.delete(item.clientId);
      if(scheduledIntent.current.delete(item.clientId))saveIntent();
      if(!result){if(aliveRef.current){setPending(prev=>prev.filter(p=>p.clientId!==item.clientId));void refreshScheduled();}return;}
      if(aliveRef.current){await acceptMessage(result.message);softRefresh();}
    }
    catch(e){
      if(e instanceof ApiError&&e.code==='E2EE_DEVICES_CHANGED'){
        // The committed ciphertext is for a device list that is no longer current: the next attempt encrypts afresh.
        await cryptoRuntime.get().then(crypto=>crypto.rejectedDeviceSet(item.chatId,item.clientId)).catch(()=>{});
        // A message restored from the vault (G001) gets that one attempt by itself; a live send shows «Повторить».
        if(restoredPeers.current.has(item.clientId)&&!reencrypted.current.has(item.clientId)&&aliveRef.current){reencrypted.current.add(item.clientId);void performSendRef.current(item);return;}
      }
      // Refused for good (not «try later» 429, not a dead session 401, not a device-list change handled above):
      // the vault forgets the message, or it would come back as «часики» after every restart (G001).
      else if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401&&e.status!==408&&e.status!==429){restoredPeers.current.delete(item.clientId);if(scheduledIntent.current.delete(item.clientId))saveIntent();await cryptoRuntime.get().then(crypto=>crypto.forget(item.chatId,item.clientId)).catch(()=>{});}
      if(e instanceof Error&&e.name==='AbortError')return;
      if(aliveRef.current){const message=checkError(e);if(e instanceof Error&&e.name==='UntrustedDeviceError')setCryptoError(message);setPending(prev=>prev.map(p=>p.clientId===item.clientId?{...p,...(item.upload?{upload:item.upload}:{}),state:'failed',error:message,offline:e instanceof NetworkError?(item.offline||0)+1:undefined,mesh:p.mesh}:p));}
      // No internet but Mesh is on: hand the same encrypted message to phones nearby. The server
      // still gets it when the internet is back (retries below), and drops the duplicate by clientId.
      if(e instanceof NetworkError&&meshBody&&meshActive()){publishMessage(meshPeer,meshBody,item.clientId);setPending(prev=>prev.map(p=>p.clientId===item.clientId&&!p.mesh?{...p,mesh:'queued'}:p));}
    }
  },[api,acceptMessage,checkError,softRefresh,cryptoRuntime,user.id,saveIntent,refreshScheduled]);
  // ---- Mesh (no internet): radio on/off, messages and receipts from phones nearby ----
  const mesh=useMeshActive();
  useEffect(()=>{if(mesh)void startMesh(user.id);else void stopMesh();},[mesh,user.id]);
  const meshSeq=useRef(0);const readSent=useRef(new Set<string>());
  useEffect(()=>onMesh({
    handedOver:id=>setPending(prev=>prev.map(p=>packetIdOf(p.clientId)===id&&(!p.mesh||p.mesh==='queued')?{...p,mesh:'handed'}:p)),
    deliver:packet=>{
      let body:unknown;try{body=JSON.parse(packet.body);}catch{return;}
      if(packet.kind==='ack'||packet.kind==='read'){
        const id=(body as {ack?:unknown;read?:unknown})[packet.kind==='ack'?'ack':'read'];if(typeof id!=='string')return;
        const step=packet.kind==='ack'?'delivered':'read';
        setPending(prev=>prev.map(p=>packetIdOf(p.clientId)===id&&p.mesh!=='read'?{...p,mesh:step}:p));return;
      }
      const input=body as {chatId?:unknown;clientId?:unknown;senderId?:unknown;encrypted?:unknown};
      if(typeof input.chatId!=='string'||typeof input.clientId!=='string'||typeof input.senderId!=='string'||packetIdOf(input.clientId)!==packet.id)return;
      // Only in an existing chat with that very person (the sender is proven by Signal below).
      const chat=chatsRef.current.find(c=>c.id===input.chatId&&c.peer.id===input.senderId);if(!chat)return;
      void cryptoRuntime.get().then(crypto=>crypto.receiveMesh(input as Parameters<typeof crypto.receiveMesh>[0])).then(plain=>{
        if(!plain||!aliveRef.current)return;
        const message=cleanShown({id:MESH_ID_BASE+(++meshSeq.current),chatId:chat.id,senderId:chat.peer.id,clientId:input.clientId as string,text:plain.text,attachment:plain.attachment,createdAt:plain.sentAt,cryptoState:'decrypted',mesh:true,...(plain.meta?{meta:plain.meta}:{})});
        indexMessage(message);
        setMessages(prev=>({...prev,[chat.id]:mergeMessages(prev[chat.id]||[],[message])}));
        publishReceipt('ack',chat.peer.id,packet.id);
      }).catch(()=>{});
    },
  }),[cryptoRuntime,indexMessage]);
  // «Прочитано» over Mesh for messages that came over Mesh, once the chat is open.
  useEffect(()=>{
    if(!selectedId||!meshActive())return;
    for(const m of messages[selectedId]||[])if(m.mesh&&m.senderId!==user.id&&!readSent.current.has(m.clientId)){readSent.current.add(m.clientId);publishReceipt('read',m.senderId,packetIdOf(m.clientId));}
  },[selectedId,messages,user.id]);
  // A message that failed only because the servers were switching over (or the network blinked) is
  // sent again by itself: every 3 s, then slower, for about 10 minutes.
  useEffect(()=>{
    const timer=setInterval(()=>{
      const now=Date.now();
      for(const item of pendingRef.current){
        if(item.state!=='failed'||!item.offline||(item.offline>40&&!item.mesh)||item.upload)continue;
        const wait=Math.min(30000,3000*Math.ceil(item.offline/5));
        const last=retryAtRef.current.get(item.clientId)||0;
        if(now-last<wait)continue;
        retryAtRef.current.set(item.clientId,now);void performSend(item);
      }
    },1000);
    return()=>clearInterval(timer);
  },[performSend]);
  // G001: messages encrypted and committed to the vault but never confirmed by the server (the app was
  // closed or crashed mid-send) come back as «часики» bubbles and go out again through the same path:
  // encrypt() returns the committed ciphertext for the same clientId and the server drops duplicates by
  // clientId, so a message that did reach the server just gets confirmed. Then, once the chat list is on
  // screen, the search index is filled from the vault's decrypted cache: newest chats first, one history
  // page per turn of the crypto queue (sending and decrypting are never kept waiting), until the index is
  // full and what is left is older than everything it keeps. Deletions and edits in the cache are applied
  // the same way as live ones (indexMessage), so deleted text never shows up in results.
  const performSendRef=useRef(performSend);performSendRef.current=performSend;
  useEffect(()=>{
    let live=true;
    void (async()=>{
      const service=await cryptoRuntime.get();
      const items=await service.pendingOutbox();if(!live)return;
      for(const item of items)restoredPeers.current.set(item.clientId,item.peerId);
      // F4: a scheduled message's committed ciphertext (lane) only goes out as «Отправить позже». Its time is in the vault
      // (dated at delivery), so a lost intent (cleared app storage) is rebuilt here instead of ending in «Идентификатор уже использован».
      await intentReady.current;let rebuilt=false;
      for(const item of items)if(item.deliverAt&&!scheduledIntent.current.has(item.clientId)){scheduledIntent.current.set(item.clientId,item.deliverAt);rebuilt=true;}
      if(rebuilt)saveIntent();
      const restored:PendingMessage[]=items.filter(item=>!pendingRef.current.some(p=>p.clientId===item.clientId)).map(item=>({clientId:item.clientId,chatId:item.chatId,text:item.text,attachment:item.attachment,state:'sending' as const,createdAt:item.sentAt,...(item.meta?{meta:item.meta}:{})}));
      if(restored.length)setPending(prev=>[...prev.filter(p=>!restored.some(item=>item.clientId===p.clientId)),...restored]);
      for(const item of restored){if(!live)return;await performSendRef.current(item);}
      await listReady.current?.promise;await new Promise(resolve=>setTimeout(resolve,50));if(!live)return;
      const cached=new Set(await service.historyChats());if(!live)return;
      const order=[...chatsRef.current.map(chat=>chat.id).filter(id=>cached.has(id)),...[...cached].filter(id=>!chatsRef.current.some(chat=>chat.id===id))];
      const index=searchIndex.current;const newest=(list:{sentAt:string}[])=>list.reduce((max,item)=>Math.max(max,Date.parse(item.sentAt)||0),0);
      const feed=(item:HistoryItem)=>indexMessage({chatId:item.chatId,senderId:item.senderId,clientId:item.clientId,text:item.text,attachment:item.attachment,createdAt:item.sentAt,cryptoState:'decrypted',...(item.meta?{meta:item.meta}:{})});
      for(const chatId of order){
        const last=chatsRef.current.find(chat=>chat.id===chatId)?.lastMessage;
        if(index.full&&last&&(Date.parse(last.createdAt)||0)<index.oldestTime)continue; // the whole chat is older than what the index keeps
        let page:number|undefined;
        while(live){
          const result=await service.historyPage(chatId,page);if(!live)return;
          // Newest first within the page: a deletion is seen before the message it deletes, an edit before the original.
          for(const item of result.items)feed(item);
          if(result.previous===null||(index.full&&newest(result.items)<index.oldestTime))break;
          page=result.previous;
          await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
    })().catch(()=>{/* no vault (browser) or the session ended: nothing to restore */});
    return()=>{live=false;};
  },[cryptoRuntime,indexMessage,saveIntent]);
  /** Sends a big file at once as a bubble with upload progress (the draft flow is for small files). */
  const sendLargeFile=useCallback((chatId:string,file:LocalFile,text='')=>{
    const placeholder:Attachment={id:'00000000-0000-4000-8000-000000000000',name:file.name.slice(0,240)||'file',mimeType:(file.mimeType||'application/octet-stream').slice(0,150),size:file.size||0};
    const item:PendingMessage={clientId:Crypto.randomUUID(),chatId,text,attachment:placeholder,state:'sending',createdAt:new Date().toISOString(),upload:{file,sent:0,total:file.size||0}};
    void performSend(item);
  },[performSend]);
  /** Stops a big upload and removes its bubble; the unfinished file is deleted from the server. */
  const cancelPending=useCallback((item:PendingMessage)=>{
    uploadsRef.current.get(item.clientId)?.abort();uploadsRef.current.delete(item.clientId);
    if(scheduledIntent.current.delete(item.clientId))saveIntent();
    setPending(prev=>{const current=prev.find(p=>p.clientId===item.clientId);void cancelLargeUpload(api,current?.upload?.state??item.upload?.state);return prev.filter(p=>p.clientId!==item.clientId);});
  },[api,saveIntent]);
  /** `options` (long-press on Send, F4): `silent` rides inside the ciphertext and makes the push quiet; `deliverAt` hands the envelopes to the server until that time. */
  const send=useCallback((chatId:string,text:string,attachment:Attachment|null,meta?:MessageMeta,options?:SendOptions)=>{
    const clientId=Crypto.randomUUID();const shown=withSendOptions(meta,options);
    if(options?.deliverAt){scheduledIntent.current.set(clientId,options.deliverAt);saveIntent();}
    const item:PendingMessage={clientId,chatId,text,attachment,state:'sending',createdAt:new Date().toISOString(),...(shown?{meta:shown}:{})};
    void performSend(item);
  },[performSend,saveIntent]);
  // F4: a scheduled message the server could not release (the peer's devices changed) is encrypted afresh
  // here — only this device holds the text — and sent through the normal route; the stale row is dropped.
  const resending=useRef(new Set<string>());
  const resendScheduled=useCallback(async(item:ScheduledItem)=>{
    if(resending.current.has(item.id)||item.cryptoState!=='decrypted')return;
    resending.current.add(item.id);
    try{
      await cryptoRuntime.get().then(crypto=>crypto.rejectedDeviceSet(item.chatId,item.clientId)).catch(()=>{});
      await api.deleteScheduled(item.id).catch(e=>{if(!(e instanceof ApiError&&e.status===404))throw e;});
      if(aliveRef.current)setScheduled(prev=>prev.filter(s=>s.id!==item.id));
      await performSend({clientId:item.clientId,chatId:item.chatId,text:item.text,attachment:item.attachment,state:'sending',createdAt:new Date().toISOString(),...(item.meta?{meta:item.meta}:{})});
    }finally{resending.current.delete(item.id);}
  },[api,cryptoRuntime,performSend]);
  useEffect(()=>{for(const item of scheduled)if(canResend(item))void resendScheduled(item).catch(e=>{if(aliveRef.current)setError(checkError(e));});},[scheduled,resendScheduled,checkError]);
  /** «Отправить сейчас»: the server releases the stored envelopes; when they no longer fit the peer's devices (409), this device re-encrypts. */
  const sendScheduledNow=useCallback(async(item:ScheduledItem)=>{
    setScheduledBusy(prev=>new Set(prev).add(item.id));
    try{
      if(item.status==='scheduled'){
        try{const result=await api.sendScheduledNow(item.id);if(aliveRef.current){setScheduled(prev=>prev.filter(s=>s.id!==item.id));await acceptMessage({...result.message,...(item.encrypted?{encrypted:item.encrypted}:{lean:true})});softRefresh();}return;}
        catch(e){if(!(e instanceof ApiError&&e.status===409))throw e;}
      }
      const stale:ScheduledItem={...item,status:'failed',failure:'E2EE_DEVICES_CHANGED'};
      if(!canResend(stale))throw new Error('Отправить заново можно только с устройства, где сообщение написано.');
      await resendScheduled(stale);
    }catch(e){throw new Error(checkError(e));}
    finally{if(aliveRef.current)setScheduledBusy(prev=>{const next=new Set(prev);next.delete(item.id);return next;});}
  },[api,acceptMessage,softRefresh,resendScheduled,checkError]);
  const deleteScheduled=useCallback(async(item:ScheduledItem)=>{
    try{await api.deleteScheduled(item.id);}catch(e){if(!(e instanceof ApiError&&e.status===404))throw new Error(checkError(e));}
    if(aliveRef.current)setScheduled(prev=>prev.filter(s=>s.id!==item.id));
    // The text is going nowhere any more: its copy in this device's vault goes too.
    void cryptoRuntime.get().then(crypto=>crypto.forget(item.chatId,item.clientId)).catch(()=>{});
  },[api,cryptoRuntime,checkError]);
  /** Edit, delete for everyone, react or pin — sent as an ordinary end-to-end encrypted message. */
  const sendAction=useCallback((chatId:string,action:MessageAction,targetText='')=>{
    send(chatId,actionFallback(action,targetText),null,{action});
  },[send]);
  const hideForMe=useCallback((message:Pick<Message,'senderId'|'clientId'>)=>{
    setHidden(previous=>{
      const next=new Set(previous);next.add(messageKey(message));
      const list=[...next].slice(-HIDDEN_LIMIT);void AsyncStorage.setItem(hiddenKey,JSON.stringify(list)).catch(()=>{});
      return new Set(list);
    });
  },[hiddenKey]);
  /** Forwarding re-encrypts for the new chat; a file is decrypted locally and uploaded again as a new encrypted file. */
  const forward=useCallback(async(targetChatId:string,message:Pick<Message,'text'|'attachment'|'senderId'|'meta'>,fromName:string)=>{
    let attachment:Attachment|null=null;
    if(message.attachment){
      const local=await decryptAttachment(api,message.attachment);
      try{const uploaded=await uploadEncryptedRef.current({uri:local.uri,name:message.attachment.name,mimeType:message.attachment.mimeType,size:message.attachment.size});attachment={...uploaded,...(message.attachment.media&&!uploaded.media?{media:message.attachment.media}:{}),...(message.attachment.preview&&!uploaded.preview?{preview:message.attachment.preview}:{})};}
      finally{await local.dispose().catch(()=>{});}
    }
    const text=message.text||'';
    if(!text.trim()&&!attachment)throw new Error('Пустое сообщение нельзя переслать.');
    // The formatting (bold, spoiler, …) travels with the forwarded text; a reply quote, reactions or an album do not.
    const entities=packEntities(message.meta?.entities,text);
    send(targetChatId,text,attachment,{forward:{from:fromName.slice(0,80)||'собеседник'},...(entities?{entities}:{})});
  },[api,send]);
  /** `entities` format the caption (offsets over `text`); they go with the first part, which carries the caption. */
  const sendAttachments=useCallback((chatId:string,text:string,attachments:Attachment[],entities?:readonly Entity[],options?:SendOptions)=>{
    const started=Date.now();
    const parts=messageAttachmentBatch(text,attachments);
    const lead=text.length-text.trimStart().length;
    const captionEntities=entities?.length?packEntities(sliceEntities(entities,text,{start:lead,end:lead+text.trim().length}),text.trim()):undefined;
    // Two or more photos/videos go out as one album (Telegram groups them into a grid).
    // Up to 10 per album (Telegram): 25 photos become albums of 10 + 10 + 5; the caption goes with the first.
    const visual=parts.filter(part=>part.attachment&&isAlbumMedia(part.attachment));
    const ordered=visual.length>=2?[...visual,...parts.filter(part=>!visual.includes(part))]:parts;
    if(visual.length>=2&&text.trim()){ordered.forEach(part=>{part.text='';});ordered[0].text=text.trim();}
    const albumOf=(index:number)=>{
      if(visual.length<2||index>=visual.length)return null;
      const group=Math.floor(index/ALBUM_SIZE),start=group*ALBUM_SIZE,count=Math.min(ALBUM_SIZE,visual.length-start);
      return count>=2?{group,index:index-start,count}:null;
    };
    const albumIds=Array.from({length:Math.ceil(visual.length/ALBUM_SIZE)},()=>Crypto.randomUUID());
    const items:PendingMessage[]=ordered.map((part,index)=>{const album=albumOf(index);const meta:MessageMeta={...(album?{album:{id:albumIds[album.group],index:album.index,count:album.count}}:{}),...(captionEntities&&part.text===text.trim()?{entities:captionEntities}:{}),...(options?.silent?{silent:true as const}:{})};return {...part,clientId:Crypto.randomUUID(),chatId,state:'sending',createdAt:new Date(started+index).toISOString(),...(Object.keys(meta).length?{meta}:{})};});
    if(options?.deliverAt){for(const item of items)scheduledIntent.current.set(item.clientId,options.deliverAt);saveIntent();}
    setPending(previous=>[...previous,...items]);
    void (async()=>{for(const item of items){if(!aliveRef.current)return;await performSend(item);}})();
  },[performSend,saveIntent]);
  const sendPoll=useCallback((chatId:string,poll:Poll)=>{send(chatId,pollFallback(poll),null,{poll});},[send]);
  const sendTyping=useCallback((chatId:string,isTyping:boolean)=>{
    // Privacy: the user may hide "печатает…". A stop signal is still allowed.
    if(isTyping&&!getChatPreferences().sendTyping)return;
    if(socketRef.current?.readyState===WebSocket.OPEN)socketRef.current.send(JSON.stringify({type:'typing',chatId,isTyping}));
  },[]);
  const setDraft=useCallback((chatId:string,text:string)=>setDrafts(prev=>({...prev,[chatId]:text})),[]);
  const setDraftFiles=useCallback((chatId:string,attachments:Attachment[])=>{
    const next={...draftFilesRef.current,[chatId]:appendAttachments([],attachments)};
    draftFilesRef.current=next;updateDraftFiles(next);
  },[]);
  const setDraftFile=useCallback((chatId:string,attachment:Attachment|null)=>setDraftFiles(chatId,attachment?[attachment]:[]),[setDraftFiles]);
  const appendDraftFiles=useCallback((chatId:string,attachments:Attachment[])=>setDraftFiles(chatId,appendAttachments(draftFilesRef.current[chatId]||[],attachments)),[setDraftFiles]);
  const removeDraftFile=useCallback((chatId:string,id:string)=>setDraftFiles(chatId,(draftFilesRef.current[chatId]||[]).filter(file=>file.id!==id)),[setDraftFiles]);
  const uploadEncrypted=useCallback(async(file:LocalFile,onProgress?:(sent:number,total:number)=>void)=>{await(await cryptoRuntime.get()).initialize();return encryptAndUpload(api,file,onProgress);},[api,cryptoRuntime]);
  const uploadEncryptedRef=useRef(uploadEncrypted);uploadEncryptedRef.current=uploadEncrypted;
  const trustSnapshot=useCallback(async(peerId:string)=>(await cryptoRuntime.get()).trustSnapshot(peerId),[cryptoRuntime]);
  const approveDevices=useCallback(async(snapshot:TrustSnapshot)=>{
    await(await cryptoRuntime.get()).approveDevices(snapshot);
    if(selectedRef.current)await loadMessages(selectedRef.current);
    await refreshChats();
    // Messages that stopped only because these keys were not checked yet go out now.
    const chatIds=new Set(chatsRef.current.filter(chat=>chat.peer?.id===snapshot.peerId).map(chat=>chat.id));
    for(const item of pendingRef.current)if(item.state==='failed'&&chatIds.has(item.chatId)&&item.error===new UntrustedDeviceError().message)void performSend(item);
  },[cryptoRuntime,loadMessages,refreshChats,performSend]);
  const updateChatSettings=useCallback(async(chatId:string,change:Partial<{pinned:boolean;archived:boolean;muted:boolean}>)=>{
    const {chat}=await api.chatSettings(chatId,change);
    setChats(previous=>previous.map(item=>item.id===chat.id?{...item,settings:chat.settings}:item));
    return chat;
  },[api]);
  // «Удалить чат» (for me): the chat leaves the list until a newer message arrives; stored on this device.
  const removedKey=`linea.removed-chats.v1:${user.id}`;
  const [removed,setRemoved]=useState<Record<string,number>>({});
  /** What a deleted chat leaves on this device goes too: its search entries, its unsent messages and the vault's history names (G029/G001). */
  const forgetChatLocally=useCallback((chatId:string)=>{
    searchIndex.current.removeChat(chatId);bumpSearch();
    setPending(prev=>prev.some(p=>p.chatId===chatId)?prev.filter(p=>p.chatId!==chatId):prev);
    void cryptoRuntime.get().then(crypto=>crypto.forgetChat(chatId)).catch(()=>{});
  },[bumpSearch,cryptoRuntime]);
  useEffect(()=>{let live=true;AsyncStorage.getItem(removedKey).then(raw=>{if(live&&raw)try{const value=JSON.parse(raw);if(value&&typeof value==='object')setRemoved(value);}catch{/* ignore */}}).catch(()=>{});return()=>{live=false;};},[removedKey]);
  const removeChat=useCallback((chat:Chat)=>{
    setRemoved(previous=>{const next={...previous,[chat.id]:chat.lastMessage?.id||0};void AsyncStorage.setItem(removedKey,JSON.stringify(next)).catch(()=>{});return next;});
    (messages[chat.id]||[]).forEach(message=>hideForMe(message));forgetChatLocally(chat.id);
    if(selectedRef.current===chat.id)selectChat(null);
  },[removedKey,messages,hideForMe,selectChat,forgetChatLocally]);
  const removeChatForEveryone=useCallback(async(chat:Chat)=>{
    await api.deleteChatForEveryone(chat.id);
    setChats(prev=>prev.filter(c=>c.id!==chat.id));setMessages(prev=>{const next={...prev};delete next[chat.id];return next;});forgetChatLocally(chat.id);
    if(selectedRef.current===chat.id)selectChat(null);
  },[api,selectChat,forgetChatLocally]);
  // Chat list preview like Telegram: reactions, unpins, votes, edits and deletions are messages too
  // (the server cannot tell, they are encrypted), but the list shows the last real message. For a
  // chat never opened, its recent page is read quietly (no «read» mark) to find that message.
  const [previewFill,setPreviewFill]=useState<Record<string,Message>>({});
  const previewAsked=useRef(new Set<string>());
  const filtered=useMemo(()=>chats.filter(chat=>removed[chat.id]===undefined||(chat.lastMessage?.id||0)>removed[chat.id]),[chats,removed]);
  useEffect(()=>{
    for(const chat of filtered){
      const last=chat.lastMessage;
      // A chat never opened may still hold a socket message or two (a reaction that just arrived): that set does not cover the watermark, so the page is read anyway.
      if(!last||!skippedInList(last)||coversUnread(chat,messages[chat.id],hasMore[chat.id])||previewAsked.current.has(`${chat.id}:${last.id}`))continue;
      previewAsked.current.add(`${chat.id}:${last.id}`);
      void (async()=>{try{
        const page=await api.messages(chat.id);const hydrated=await Promise.all(page.messages.map(hydrate));if(!aliveRef.current)return;
        quietPages.current[chat.id]={messages:hydrated,hasMore:page.hasMore};
        // A reaction or an edit by the peer is not unread (Telegram): the server's count is corrected here.
        setChats(prev=>{const next=prev.map(c=>c.id===chat.id?reconcileUnread(c,hydrated,user.id,page.hasMore):c);return next.some((c,i)=>c!==prev[i])?next:prev;});
        const shown=listPreviewMessage(hydrated);if(shown)setPreviewFill(prev=>({...prev,[chat.id]:shown}));
      }catch{previewAsked.current.delete(`${chat.id}:${last.id}`);/* the action text stays as a fallback; asked again with the next list (e.g. back online) */}})();
    }
  },[filtered,messages,hasMore,api,hydrate,user.id]);
  // A voice room keeps the socket alive in the background (see connectionHold); a call does the same from CallProvider.
  const inVoice=!!useVoice();
  useEffect(()=>inVoice?holdConnection('voice'):undefined,[inVoice]);
  // Chats keep their identity while nothing in them changed, so memoized list rows skip re-rendering.
  const chatCache=useRef(new Map<string,Chat>());
  const visibleChats=useMemo(()=>stabilizeById(chatCache.current,filtered.map(chat=>{
    const last=chat.lastMessage;if(!last)return chat;
    const loaded=messages[chat.id];
    const shown=loaded?.length?listPreviewMessage([...loaded,last]):skippedInList(last)?previewFill[chat.id]??null:last;
    // The server's lastMessage is shown as is when no page is loaded: a spoiler in it must still be hidden.
    const masked=shown&&shown===last?chatListText(shown):null;
    const final=masked!==null&&masked!==last.text?{...last,text:masked}:shown;
    return final&&final!==last?{...chat,lastMessage:final}:chat;
  }),c=>c.id),[filtered,messages,previewFill]);
  // While it is being re-sent by itself, the bubble shows the clock, not «Не отправлено».
  const shownPending=useMemo(()=>pending.map(p=>p.state==='failed'&&p.offline&&(p.offline<=40||p.mesh)&&!p.upload?{...p,state:'sending' as const,error:undefined}:p),[pending]);
  // F11: system notifications on PC / in the browser when the window is not in front (one hook, decisions in notifications/desktopNotify.ts).
  // `fresh`: the server's list, not the vault's cache — messages that came while the app was closed are not announced.
  useDesktopNotifications({user,chats:visibleChats,selectedId,onCallSignal,ready:fresh});
  return {cryptoRuntime,onSocket,sendSocket,onCallSignal,readChat,presence,chats:visibleChats,removeChat,removeChatForEveryone,messages,hasMore,pending:shownPending,selectedId,selectChat,connection,online,updating,listLoading,messageLoading,error,setError,typing,refreshChats,loadMessages,send,sendAction,hideForMe,hidden,forward,sendAttachments,sendLargeFile,cancelPending,retry:performSend,sendPoll,sendTyping,drafts,draftFiles,setDraft,setDraftFile,setDraftFiles,appendDraftFiles,removeDraftFile,recoveryRequests,recoveryError,refreshRecoveryRequests,cancelRecovery,cryptoError,trustSnapshot,approveDevices,uploadEncrypted,saved,aiHistory,updateChatSettings,searchMessages,searchVersion,focus,focusMessage,clearFocus,scheduled,scheduledBusy,refreshScheduled,sendScheduledNow,deleteScheduled};
}
export type MessengerStore = ReturnType<typeof useMessenger>;
