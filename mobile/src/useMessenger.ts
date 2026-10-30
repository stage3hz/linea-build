import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSaved } from './saved/useSaved';
import { useAIHistory } from './ai/history';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Api, ApiError } from './api';
import type { Attachment, Chat, LocalFile, Message, PendingMessage, RecoveryRequest, User } from './types';
import { CryptoRuntime } from './e2ee/runtime';
import { clearDecryptedAttachmentCache, encryptAndUpload } from './e2ee/attachments';
import type { TrustSnapshot } from './e2ee/types';
import { appendAttachments, messageAttachmentBatch } from './messageAttachments';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getChatPreferences } from './chatPreferences';
import { actionFallback, messageKey, type MessageAction, type MessageMeta } from './messageMeta';
import { decryptAttachment } from './e2ee/attachments';

const HIDDEN_LIMIT = 5000;

const sortedChats = (chats: Chat[]) => [...chats].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
const mergeMessages = (a: Message[], b: Message[]) => Array.from(new Map([...a,...b].map(m=>[m.id,m])).values()).sort((x,y)=>x.id-y.id);
export type Connection = 'connecting'|'connected'|'offline';

export function useMessenger(api: Api, user: User, onExpired: ()=>void) {
  const [chats,setChats]=useState<Chat[]>([]);
  const [messages,setMessages]=useState<Record<string,Message[]>>({});
  const [hasMore,setHasMore]=useState<Record<string,boolean>>({});
  const [pending,setPending]=useState<PendingMessage[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [connection,setConnection]=useState<Connection>('connecting');
  const [listLoading,setListLoading]=useState(true);
  const [messageLoading,setMessageLoading]=useState(false);
  const [error,setError]=useState('');
  const [typing,setTyping]=useState<Record<string,number>>({});
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [draftFiles,updateDraftFiles]=useState<Record<string,Attachment[]>>({});
  const draftFilesRef=useRef(draftFiles);draftFilesRef.current=draftFiles;
  const [recoveryRequests,setRecoveryRequests]=useState<RecoveryRequest[]>([]);
  const [recoveryError,setRecoveryError]=useState('');
  const [cryptoError,setCryptoError]=useState('');
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
  const chatsRef=useRef(chats);chatsRef.current=chats;
  const readRef=useRef<Record<string,number>>({});
  const aliveRef=useRef(true);
  const onExpiredRef=useRef(onExpired);onExpiredRef.current=onExpired;
  const checkError=useCallback((e:unknown)=>{
    if(aliveRef.current&&e instanceof ApiError&&e.status===401)onExpiredRef.current();
    return e instanceof Error?e.message:'Произошла ошибка. Попробуй ещё раз.';
  },[]);

  useEffect(()=>{
    let current=true;
    // Publish this installation's public keys even when the account has no chats.
    // Otherwise an online new account would be unable to receive its first message.
    void cryptoRuntime.get().then(service=>service.initialize()).catch(e=>{if(current)setCryptoError(checkError(e));});
    void clearDecryptedAttachmentCache().catch(()=>{});
    return()=>{current=false;void cryptoRuntime.close();void clearDecryptedAttachmentCache().catch(()=>{});};
  },[cryptoRuntime,checkError]);

  const hydrate=useCallback(async(message:Message):Promise<Message>=>{
    try{return await(await cryptoRuntime.get()).preview(message);}
    catch(e){if(aliveRef.current)setCryptoError(checkError(e));return {...message,text:message.legacy?'Сообщение из старой версии без сквозного шифрования.':'Зашифрованное сообщение недоступно на этом устройстве.',attachment:null,cryptoState:message.legacy?'legacy':'no-key'};}
  },[cryptoRuntime,checkError]);

  const refreshRecoveryRequests=useCallback(async()=>{
    const revision=++recoveryFetchRef.current;
    try {
      const result=await api.recoveryRequests();
      if(aliveRef.current&&revision===recoveryFetchRef.current){setRecoveryRequests(result.requests);setRecoveryError('');}
    } catch(e) {
      if(aliveRef.current&&revision===recoveryFetchRef.current)setRecoveryError(checkError(e));
    }
  },[api,checkError]);
  const cancelRecovery=useCallback(async(requestId:string)=>{
    try {
      await api.cancelRecovery(requestId);
      // Ignore a list request that started before the cancellation completed.
      ++recoveryFetchRef.current;
      if(aliveRef.current){setRecoveryRequests(current=>current.filter(request=>request.id!==requestId));setRecoveryError('');}
      await refreshRecoveryRequests();
    }catch(e){throw new Error(checkError(e));}
  },[api,checkError,refreshRecoveryRequests]);

  const refreshChats=useCallback(async()=>{
    try {const result=await api.chats();const next=await Promise.all(result.chats.map(async chat=>({...chat,lastMessage:chat.lastMessage?await hydrate(chat.lastMessage):null})));if(aliveRef.current){setChats(sortedChats(next));setError('');}}
    catch(e){if(aliveRef.current)setError(checkError(e));}
    finally {if(aliveRef.current)setListLoading(false);}
  },[api,checkError,hydrate]);
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
    try {
      try {await(await cryptoRuntime.get()).syncChat(chatId);if(aliveRef.current)setCryptoError('');}
      catch(e){if(aliveRef.current)setCryptoError(checkError(e));}
      const result=await api.messages(chatId,older?current[0].id:undefined);
      result.messages=await Promise.all(result.messages.map(hydrate));
      if(!aliveRef.current)return;
      const maxId=result.messages[result.messages.length-1]?.id||0;
      setMessages(prev=>({...prev,[chatId]:older?mergeMessages(result.messages,prev[chatId]||[]):mergeMessages(result.messages,(prev[chatId]||[]).filter(m=>m.id>maxId))}));
      const confirmed = new Set(result.messages.filter(message=>message.senderId===user.id).map(message=>message.clientId));
      setPending(prev=>prev.filter(item=>item.chatId!==chatId||!confirmed.has(item.clientId)));
      setHasMore(prev=>({...prev,[chatId]:result.hasMore}));
      if(!older&&maxId&&result.messages.every(message=>message.cryptoState==='decrypted'||message.cryptoState==='legacy'))void markRead(chatId,maxId);
      setError('');
    }catch(e){if(aliveRef.current)setError(checkError(e));}
    finally {if(aliveRef.current)setMessageLoading(false);}
  },[api,user.id,checkError,markRead,cryptoRuntime,hydrate]);

  const acceptMessage=useCallback(async(raw:Message)=>{
    try{await(await cryptoRuntime.get()).syncChat(raw.chatId);if(aliveRef.current)setCryptoError('');}catch(e){if(aliveRef.current)setCryptoError(checkError(e));}
    const message=await hydrate(raw);if(!aliveRef.current)return;
    setMessages(prev=>({...prev,[message.chatId]:mergeMessages(prev[message.chatId]||[],[message])}));
    setPending(prev=>prev.filter(p=>!(p.chatId===message.chatId&&p.clientId===message.clientId&&message.senderId===user.id)));
    setChats(prev=>sortedChats(prev.map(c=>{
      if(c.id!==message.chatId||(c.lastMessage&&c.lastMessage.id>=message.id))return c;
      return {...c,lastMessage:message,updatedAt:message.createdAt,unreadCount:message.senderId===user.id||message.meta?.action?c.unreadCount:c.unreadCount+1};
    })));
    if(message.senderId!==user.id&&message.cryptoState==='decrypted')void markRead(message.chatId,message.id);
  },[user.id,markRead,cryptoRuntime,hydrate,checkError]);

  useEffect(()=>{
    aliveRef.current=true;void refreshChats();void refreshRecoveryRequests();
    let stopped=false, retry:ReturnType<typeof setTimeout>|undefined, attempts=0, lastReceive=Date.now();
    const connect=()=>{
      if(stopped)return;
      const current=socketRef.current;
      if(current&&(current.readyState===WebSocket.OPEN||current.readyState===WebSocket.CONNECTING))return;
      setConnection('connecting');
      const socket=new WebSocket(api.socketUrl());socketRef.current=socket;lastReceive=Date.now();
      socket.onopen=()=>{if(!stopped&&socketRef.current===socket)socket.send(JSON.stringify({type:'auth',token:api.token}));};
      socket.onmessage=event=>{
        if(stopped||socketRef.current!==socket)return;
        lastReceive=Date.now();
        let data:any;try{data=JSON.parse(String(event.data));}catch{return;}
        if(data.type==='ready'){
          attempts=0;setConnection('connected');void refreshChats();void refreshRecoveryRequests();
          if(selectedRef.current)void loadMessages(selectedRef.current);
        }else if(data.type==='message'&&data.message){void acceptMessage(data.message);}
        else if(data.type==='chat'&&data.chat){void refreshChats();}
        else if(data.type==='read'){
          setChats(prev=>prev.map(c=>c.id===data.chatId?(data.userId===user.id?{...c,lastReadMessageId:Math.max(c.lastReadMessageId,data.messageId),unreadCount:0}:{...c,peerLastReadMessageId:Math.max(c.peerLastReadMessageId,data.messageId)}):c));
        }else if(data.type==='typing'&&data.userId!==user.id){setTyping(prev=>({...prev,[data.chatId]:data.isTyping?Date.now()+5000:0}));}
        else if(data.type==='profile'&&data.user){setChats(prev=>prev.map(c=>c.peer.id===data.user.id?{...c,peer:data.user}:c));}
        else if(data.type==='recovery.requested'||data.type==='recovery.updated'){void refreshRecoveryRequests();}
        else if(data.type==='e2ee.devices'){if(selectedRef.current)void loadMessages(selectedRef.current);void refreshChats();}
      };
      socket.onclose=event=>{
        if(stopped||socketRef.current!==socket)return;setConnection('offline');
        if(event.code===4001||event.code===4401){onExpiredRef.current();return;}
        retry=setTimeout(connect,Math.min(1000*2**attempts++,15000));
      };
      socket.onerror=()=>{if(!stopped&&socketRef.current===socket)setConnection('offline');};
    };
    const reconnect=()=>{
      const previous=socketRef.current;socketRef.current=null;
      previous?.close();if(retry)clearTimeout(retry);connect();
    };
    connect();
    const heartbeat=setInterval(()=>{
      if(appState.current==='active'){
        if(Date.now()-lastReceive>15000)reconnect();
        else if(socketRef.current?.readyState===WebSocket.OPEN)socketRef.current.send(JSON.stringify({type:'ping'}));
      }
      setTyping(prev=>{const now=Date.now();return Object.values(prev).some(exp=>exp>0&&exp<now)?Object.fromEntries(Object.entries(prev).map(([id,exp])=>[id,exp<now?0:exp])):prev;});
    },3000);
    const subscription=AppState.addEventListener('change',state=>{
      appState.current=state;
      if(state==='active'){void refreshChats();void refreshRecoveryRequests();if(selectedRef.current)void loadMessages(selectedRef.current);reconnect();}
    });
    const recoveryPoll=setInterval(()=>{if(appState.current==='active')void refreshRecoveryRequests();},30000);
    return ()=>{stopped=true;aliveRef.current=false;++recoveryFetchRef.current;if(retry)clearTimeout(retry);clearInterval(heartbeat);clearInterval(recoveryPoll);subscription.remove();socketRef.current?.close();socketRef.current=null;};
  },[api,user.id,refreshChats,loadMessages,acceptMessage,refreshRecoveryRequests]);

  const selectChat=useCallback((chat:Chat|null)=>{
    if(selectedRef.current&&socketRef.current?.readyState===WebSocket.OPEN)socketRef.current.send(JSON.stringify({type:'typing',chatId:selectedRef.current,isTyping:false}));
    selectedRef.current=chat?.id||null;setSelectedId(chat?.id||null);setError('');
    if(chat){setChats(prev=>sortedChats([chat,...prev.filter(c=>c.id!==chat.id)]));void loadMessages(chat.id);}
  },[loadMessages]);

  const performSend=useCallback(async(item:PendingMessage)=>{
    setPending(prev=>[...prev.filter(p=>p.clientId!==item.clientId),{...item,state:'sending',error:undefined}]);
    try {
      const peer=chatsRef.current.find(chat=>chat.id===item.chatId)?.peer;
      if(!peer)throw new Error('Сначала открой разговор.');
      const crypto=await cryptoRuntime.get();const encrypted=await crypto.encrypt(item.chatId,peer.id,item.clientId,item.text,item.attachment,item.meta);
      const result=await api.sendEncrypted(item.chatId,item.clientId,encrypted);
      await crypto.delivered(item.chatId,item.clientId).catch(()=>{});
      if(aliveRef.current){await acceptMessage(result.message);void refreshChats();}
    }
    catch(e){
      if(e instanceof ApiError&&e.code==='E2EE_DEVICES_CHANGED')await cryptoRuntime.get().then(crypto=>crypto.rejectedDeviceSet(item.chatId,item.clientId)).catch(()=>{});
      if(aliveRef.current){const message=checkError(e);setPending(prev=>prev.map(p=>p.clientId===item.clientId?{...p,state:'failed',error:message}:p));}
    }
  },[api,acceptMessage,checkError,refreshChats,cryptoRuntime]);
  const send=useCallback((chatId:string,text:string,attachment:Attachment|null,meta?:MessageMeta)=>{
    const item:PendingMessage={clientId:Crypto.randomUUID(),chatId,text,attachment,state:'sending',createdAt:new Date().toISOString(),...(meta?{meta}:{})};
    void performSend(item);
  },[performSend]);
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
  const forward=useCallback(async(targetChatId:string,message:Pick<Message,'text'|'attachment'|'senderId'>,fromName:string)=>{
    let attachment:Attachment|null=null;
    if(message.attachment){
      const local=await decryptAttachment(api,message.attachment);
      try{const uploaded=await uploadEncryptedRef.current({uri:local.uri,name:message.attachment.name,mimeType:message.attachment.mimeType,size:message.attachment.size});attachment=message.attachment.media&&!uploaded.media?{...uploaded,media:message.attachment.media}:uploaded;}
      finally{await local.dispose().catch(()=>{});}
    }
    const text=message.text||'';
    if(!text.trim()&&!attachment)throw new Error('Пустое сообщение нельзя переслать.');
    send(targetChatId,text,attachment,{forward:{from:fromName.slice(0,80)||'собеседник'}});
  },[api,send]);
  const sendAttachments=useCallback((chatId:string,text:string,attachments:Attachment[])=>{
    const started=Date.now();
    const items:PendingMessage[]=messageAttachmentBatch(text,attachments).map((part,index)=>({...part,clientId:Crypto.randomUUID(),chatId,state:'sending',createdAt:new Date(started+index).toISOString()}));
    setPending(previous=>[...previous,...items]);
    void (async()=>{for(const item of items){if(!aliveRef.current)return;await performSend(item);}})();
  },[performSend]);
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
  const uploadEncrypted=useCallback(async(file:LocalFile)=>{await(await cryptoRuntime.get()).initialize();return encryptAndUpload(api,file);},[api,cryptoRuntime]);
  const uploadEncryptedRef=useRef(uploadEncrypted);uploadEncryptedRef.current=uploadEncrypted;
  const trustSnapshot=useCallback(async(peerId:string)=>(await cryptoRuntime.get()).trustSnapshot(peerId),[cryptoRuntime]);
  const approveDevices=useCallback(async(snapshot:TrustSnapshot)=>{
    await(await cryptoRuntime.get()).approveDevices(snapshot);
    if(selectedRef.current)await loadMessages(selectedRef.current);
    await refreshChats();
  },[cryptoRuntime,loadMessages,refreshChats]);
  const updateChatSettings=useCallback(async(chatId:string,change:Partial<{pinned:boolean;archived:boolean;muted:boolean}>)=>{
    const {chat}=await api.chatSettings(chatId,change);
    setChats(previous=>previous.map(item=>item.id===chat.id?{...item,settings:chat.settings}:item));
    return chat;
  },[api]);
  return {chats,messages,hasMore,pending,selectedId,selectChat,connection,listLoading,messageLoading,error,setError,typing,refreshChats,loadMessages,send,sendAction,hideForMe,hidden,forward,sendAttachments,retry:performSend,sendTyping,drafts,draftFiles,setDraft,setDraftFile,setDraftFiles,appendDraftFiles,removeDraftFile,recoveryRequests,recoveryError,refreshRecoveryRequests,cancelRecovery,cryptoError,trustSnapshot,approveDevices,uploadEncrypted,saved,aiHistory,updateChatSettings};
}
export type MessengerStore = ReturnType<typeof useMessenger>;
