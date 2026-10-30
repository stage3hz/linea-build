import { StatusEmoji } from './StatusEmoji';
import { ComposerInput } from './ComposerInput';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from './typography';
import { KeyboardSafeView } from './keyboard';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from './api';
import { AttachmentCard, Avatar, Empty, Icon, IconButton, Notice, Sheet, SheetAction } from './components';
import { formatDay, formatSize, formatTime, useTheme } from './theme';
import { GlassSurface } from './glass';
import type { Attachment, Chat, LocalFile, Message, PendingMessage, User } from './types';
import type { MessengerStore } from './useMessenger';
import { shareEncryptedAttachment } from './e2ee/attachments';
import { TrustSheet } from './e2ee/TrustSheet';
import { signalAvailable } from './e2ee/signal';
import { AttachmentPanel } from './attachments/AttachmentPanel';
import { MAX_DRAFT_ATTACHMENTS } from './messageAttachments';
import { mediaPreviewKind } from './media/formats';
import { AttachmentViewer } from './media/AttachmentViewer';
import { openDocument } from './media/documentPreview';
import { textMetrics, useChatPreferences } from './chatPreferences';
import { REACTIONS, foldChat, groupAlbums, replyPreview, type Reaction, type ViewMessage } from './messageMeta';
import { MediaGallery } from './media/AttachmentViewer';
import { PollComposer } from './PollBubble';
import { StickerPanel } from './StickerPanel';
import { Share } from 'react-native';
import { presenceText } from './presence';
import { VoicePlaybackProvider, VoiceRecordingBar, useVoiceRecorder } from './voice/VoiceMessage';
import { MessageRow, type AlbumPart, type Row, type RowHandlers } from './MessageRow';
import { ContextMenu, MenuItem } from './ContextMenu';
import { TopPlayerBar } from './music/PlayerControls';
import { useCalls } from './calls/CallProvider';
import { UserProfile } from './UserProfile';
import { impactFeedback, lightFeedback } from './haptics';
import { VideoNoteRecorder, type VideoNoteTake } from './videonote/VideoNote';
import { useCallback } from 'react';
import { attachmentLabel, isVideoNote, isVoice } from './voice/voice';
import { VOICE_MIME, VOICE_MIN_MS, videoNoteFileName, voiceFileName } from './voice/voice';


export function ChatScreen({api,user,chat,store,onBack,wide=false,onOpenMusic}: {api:Api;user:User;chat:Chat;store:MessengerStore;onBack:()=>void;wide?:boolean;onOpenMusic?:()=>void}) {
  const calls=useCalls();
  const t=useTheme();const [attachMenu,setAttachMenu]=useState(false);const [uploading,setUploading]=useState(false);const [downloadId,setDownloadId]=useState<string|null>(null);const [localError,setLocalError]=useState('');const [preview,setPreview]=useState<Attachment|null>(null);const [peerInfo,setPeerInfo]=useState(false);const [actions,setActions]=useState<Row|null>(null);const [menuY,setMenuY]=useState(0);const [copied,setCopied]=useState(false);
  const [securityOpen,setSecurityOpen]=useState(false);
  const photoContext=`${user.id}:${chat.id}`;const currentPhotoContext=useRef(photoContext);currentPhotoContext.current=photoContext;
  const text=store.drafts[chat.id]||'';const attachments=store.draftFiles[chat.id]||[];
  const uploadingRef=useRef(false),draftCount=useRef(attachments.length);draftCount.current=attachments.length;
  const listRef=useRef<FlatList<Row>>(null);const typingAt=useRef(0);const typingTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);const alive=useRef(true);
  const messages=store.messages[chat.id]||[];
  const pendingAll=store.pending.filter(p=>p.chatId===chat.id);
  // Actions (edit, delete, react, pin) are encrypted messages too; they are applied, not shown.
  const pending=useMemo(()=>pendingAll.filter(p=>!p.meta?.action),[pendingAll]);
  const failedActions=pendingAll.filter(p=>p.meta?.action&&p.state==='failed');
  const view=useMemo(()=>foldChat(messages,user.id,store.hidden),[messages,user.id,store.hidden]);
  const [replyTo,setReplyTo]=useState<ViewMessage|null>(null);
  const [editing,setEditing]=useState<ViewMessage|null>(null);
  const [forwarding,setForwarding]=useState<ViewMessage|null>(null);
  const [searchOpen,setSearchOpen]=useState(false);const [query,setQuery]=useState('');
  const [notice,setNotice]=useState('');
  const [selection,setSelection]=useState<Set<string>|null>(null);
  // Rows present when the chat opened do not animate; new ones slide in.
  const seen=useRef<Set<string>|null>(null);
  const [forwardMany,setForwardMany]=useState<ViewMessage[]|null>(null);
  const [gallery,setGallery]=useState<{items:Attachment[];index:number}|null>(null);
  const [headerHeight,setHeaderHeight]=useState(76);const [showDown,setShowDown]=useState(false);const [recordMode,setRecordMode]=useState<'voice'|'video'>('voice');
  const [pollOpen,setPollOpen]=useState(false);const [deleteAsk,setDeleteAsk]=useState(false);const [stickers,setStickers]=useState(false);
  useEffect(()=>{setReplyTo(null);setEditing(null);setForwarding(null);setSearchOpen(false);setQuery('');setSelection(null);setGallery(null);seen.current=null;},[chat.id]);

  const needle=query.trim().toLocaleLowerCase('ru');
  const rows=useMemo<Row[]>(()=>{
    type Item={senderId:string;meta?:ViewMessage['meta'];row:Row};
    const items:Item[]=[
      ...view.messages.map(message=>({senderId:message.senderId,meta:message.meta,row:{key:`m${message.id}`,message,createdAt:message.createdAt} as Row})),
      ...pending.map(p=>({senderId:user.id,meta:p.meta,row:{key:`p${p.clientId}`,pending:p,createdAt:p.createdAt} as Row})),
    ];
    const all:Row[]=groupAlbums(items).map(group=>{
      if(group.length<2)return group[0].row;
      const first=group[0].row;
      const album:AlbumPart[]=group.map(item=>({attachment:(item.row.message?.attachment||item.row.pending?.attachment)!,message:item.row.message,pending:item.row.pending})).filter(part=>!!part.attachment);
      const caption=group.find(item=>item.row.message?.text||item.row.pending?.text)?.row;
      const head=caption||first;
      return {key:`a${first.key}`,message:head.message,pending:head.pending,createdAt:group[group.length-1].row.createdAt,album};
    });
    const visible=searchOpen&&needle?all.filter(row=>(row.message?.text||row.pending?.text||'').toLocaleLowerCase('ru').includes(needle)||(row.message?.attachment?.name||'').toLocaleLowerCase('ru').includes(needle)):all;
    return visible.reverse();
  },[view,pending,searchOpen,needle,user.id]);
  const preferences=useChatPreferences();const metrics=textMetrics(preferences.textSize);
  const nameOf=(senderId:string)=>senderId===user.id?'Ты':chat.peer.displayName;
  // A forwarded message keeps its first author through further forwards.
  const originalAuthor=(message:ViewMessage)=>message.meta?.forward?.from||(message.senderId===user.id?user.displayName:chat.peer.displayName);
  const jumpTo=(clientId:string)=>{
    if(searchOpen){setSearchOpen(false);setQuery('');}
    setTimeout(()=>{const index=rows.findIndex(row=>row.message?.clientId===clientId);if(index>=0)listRef.current?.scrollToIndex({index,animated:true,viewPosition:.5});else setNotice('Сообщение выше в истории. Загрузи более ранние сообщения.');},searchOpen?60:0);
  };
  const react=(message:ViewMessage,emoji:Reaction)=>{
    const mine=message.reactions.find(item=>item.mine);
    store.sendAction(chat.id,{type:'react',target:message.clientId,emoji:mine?.emoji===emoji?null:emoji},message.text);
  };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(typingTimer.current)clearTimeout(typingTimer.current);store.sendTyping(chat.id,false);};},[chat.id,store.sendTyping]);
  useEffect(()=>{setAttachMenu(false);setPreview(null);},[photoContext]);
  const changeText=(value:string)=>{
    store.setDraft(chat.id,value);
    if(Date.now()-typingAt.current>1500){store.sendTyping(chat.id,!!value);typingAt.current=Date.now();}
    if(typingTimer.current)clearTimeout(typingTimer.current);
    typingTimer.current=setTimeout(()=>store.sendTyping(chat.id,false),1800);
  };
  const send=()=>{
    if(signalAvailable&&!uploadingRef.current&&(text.trim()||attachments.length))lightFeedback();
    if(!signalAvailable||uploadingRef.current||(!text.trim()&&!attachments.length))return;
    if(editing){
      const next=text.trim();
      if(next&&next!==editing.text)store.sendAction(chat.id,{type:'edit',target:editing.clientId,text:next});
      setEditing(null);store.setDraft(chat.id,'');store.sendTyping(chat.id,false);return;
    }
    if(replyTo){
      const reply={clientId:replyTo.clientId,senderId:replyTo.senderId,preview:replyPreview(replyTo)};
      if(text.trim())store.send(chat.id,text.trim(),null,{reply});
      if(attachments.length)store.sendAttachments(chat.id,'',attachments);
      setReplyTo(null);
    }else store.sendAttachments(chat.id,text.trim(),attachments);store.setDraft(chat.id,'');store.setDraftFiles(chat.id,[]);draftCount.current=0;store.sendTyping(chat.id,false);setLocalError('');listRef.current?.scrollToOffset({offset:0,animated:true});
  };
  const upload=async(file:LocalFile)=>{
    const selectedFor=photoContext;
    const current=()=>alive.current&&currentPhotoContext.current===selectedFor;
    if(!current())throw new Error('Чат сменился. Выбери вложение в нужном разговоре.');
    if(!signalAvailable)throw new Error('Отправка со сквозным шифрованием доступна в приложении Android или iPhone.');
    if(uploadingRef.current)throw new Error('Дождись завершения текущего вложения.');
    if(draftCount.current>=MAX_DRAFT_ATTACHMENTS)throw new Error(`В сообщении уже ${MAX_DRAFT_ATTACHMENTS} вложений. Сначала отправь или убери часть файлов.`);
    uploadingRef.current=true;setUploading(true);setLocalError('');
    try{
      const uploaded=await store.uploadEncrypted(file);
      if(!current())throw new Error('Чат сменился во время загрузки. Вложение не добавлено в другой разговор.');
      store.appendDraftFiles(chat.id,[uploaded]);draftCount.current+=1;
    }catch(e){if(current())setLocalError(e instanceof Error?e.message:'Не удалось зашифровать и загрузить файл.');throw e;}
    finally{uploadingRef.current=false;if(alive.current)setUploading(false);}
  };
  const finishVoice=async(keep:boolean)=>{
    const take=await voice.finish(keep).catch(e=>{setLocalError(e instanceof Error?e.message:'Не удалось остановить запись.');return null;});
    if(!take)return;
    if(take.durationMs<VOICE_MIN_MS){await FileSystem.deleteAsync(take.uri,{idempotent:true}).catch(()=>{});setNotice('Слишком короткое голосовое — держи запись хотя бы секунду.');return;}
    const chatId=chat.id,reply=replyTo?{clientId:replyTo.clientId,senderId:replyTo.senderId,preview:replyPreview(replyTo)}:undefined;
    uploadingRef.current=true;setUploading(true);setLocalError('');
    try{
      const name=voiceFileName();
      const uploaded=await store.uploadEncrypted({uri:take.uri,name,mimeType:VOICE_MIME});
      store.send(chatId,'',{...uploaded,name,mimeType:VOICE_MIME,media:{durationMs:Math.round(take.durationMs)}},reply?{reply}:undefined);
      if(reply)setReplyTo(null);
      listRef.current?.scrollToOffset({offset:0,animated:true});
    }catch(e){if(alive.current)setLocalError(e instanceof Error?e.message:'Не удалось отправить голосовое.');}
    finally{uploadingRef.current=false;if(alive.current)setUploading(false);await FileSystem.deleteAsync(take.uri,{idempotent:true}).catch(()=>{});}
  };
  const voice=useVoiceRecorder(()=>void finishVoice(true));
  const startVoice=()=>{impactFeedback();Keyboard.dismiss();setLocalError('');voice.start().catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось начать запись.'));};
  const canSend=!!text.trim()||attachments.length>0||!!editing;
  const saveToFavorites=(m:ViewMessage)=>{
    store.saved.save(m.text,m.attachment,{chatId:chat.id,clientId:m.clientId,author:originalAuthor(m).slice(0,80)||'собеседник',sentAt:m.createdAt})
      .then(added=>setNotice(added?'Сохранено в Избранное':'Уже в Избранном')).catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось сохранить.'));
  };
  const download=async(file:Attachment)=>{setDownloadId(file.id);setLocalError('');try{await shareEncryptedAttachment(api,file);}catch(e){if(alive.current)setLocalError(e instanceof Error?e.message:'Не удалось открыть файл.');}finally{if(alive.current)setDownloadId(null);}};
  const mediaItems=useMemo(()=>view.messages.map(m=>m.attachment).filter((a):a is Attachment=>!!a&&!isVoice(a)&&!isVideoNote(a)&&['photo','video'].includes(mediaPreviewKind(a))),[view.messages]);
  const openAttachment=(file:Attachment)=>{
    const kind=mediaPreviewKind(file);
    if(kind==='photo'||kind==='video'){const index=mediaItems.findIndex(a=>a.id===file.id);setGallery(index>=0?{items:mediaItems,index}:{items:[file],index:0});return;}
    if(kind==='file'){setDownloadId(file.id);void openDocument(api,file).then(shown=>{if(!shown&&alive.current)setPreview(file);}).catch(e=>{if(alive.current)setLocalError(e instanceof Error?e.message:'Не удалось открыть файл.');}).finally(()=>{if(alive.current)setDownloadId(null);});return;}
    setPreview(file);
  };
  const copy=async(value:string)=>{await Clipboard.setStringAsync(value);setActions(null);setCopied(true);setTimeout(()=>setCopied(false),2000);};
  const isTyping=(store.typing[chat.id]||0)>Date.now();
  const otherUnread=store.chats.reduce((sum,c)=>c.id===chat.id||c.settings?.muted||c.settings?.archived?sum:sum+c.unreadCount,0);
  const [clock,setClock]=useState(0);useEffect(()=>{const timer=setInterval(()=>setClock(v=>v+1),30000);return()=>clearInterval(timer);},[]);
  const headerStatus=useMemo(()=>{
    if(store.connection==='connecting')return {text:'соединение…',accent:false};
    if(store.connection==='offline')return {text:'ожидание сети…',accent:false};
    if(isTyping)return {text:'печатает…',accent:true};
    const text=presenceText(store.presence[chat.peer.id]);
    return text?{text,accent:text==='в сети'}:{text:`@${chat.peer.username}`,accent:false};
  },[store.connection,isTyping,store.presence,chat.peer.id,chat.peer.username,clock]);
  const rowMessages=(row:Row):ViewMessage[]=>row.album?row.album.map(part=>part.message).filter((m):m is ViewMessage=>!!m):row.message?[row.message]:[];
  const selectedRows=selection?rows.filter(row=>selection.has(row.key)):[];
  const selectedMessages=selectedRows.flatMap(rowMessages).sort((a,b)=>a.id-b.id);
  const toggleSelect=(row:Row)=>{if(!rowMessages(row).length)return;setSelection(current=>{const next=new Set(current||[]);if(next.has(row.key))next.delete(row.key);else next.add(row.key);return next.size?next:null;});};
  const startSelect=(row:Row)=>{setActions(null);impactFeedback();if(rowMessages(row).length)setSelection(new Set([row.key]));};
  const shareMessages=async(list:ViewMessage[])=>{
    const files=list.map(m=>m.attachment).filter((a):a is Attachment=>!!a);
    const text=list.map(m=>m.meta?.poll?replyPreview(m):m.text).filter(Boolean).join('\n\n');
    try{
      if(files.length===1&&!text)await download(files[0]);
      else if(text)await Share.share({message:text});
      else if(files.length)await download(files[0]);
    }catch(e){setLocalError(e instanceof Error?e.message:'Не удалось поделиться.');}
  };
  const deleteSelected=(everyone:boolean)=>{
    for(const m of selectedMessages){if(everyone&&m.senderId===user.id)store.sendAction(chat.id,{type:'delete',target:m.clientId});else store.hideForMe(m);}
    setSelection(null);lightFeedback();
  };

  const handlers=useRef<RowHandlers>(null as unknown as RowHandlers);
  handlers.current={actions:(row,y)=>{setMenuY(y);setActions(row);},jumpTo,open:openAttachment,react,retry:pending=>void store.retry(pending),reply:message=>{setEditing(null);setReplyTo(message);},vote:(message,options)=>store.sendAction(chat.id,{type:'vote',target:message.clientId,options},replyPreview(message)),toggleSelect};
  if(seen.current===null&&rows.length)seen.current=new Set(rows.map(row=>row.key));
  const fresh=(key:string)=>{if(!seen.current)return false;if(seen.current.has(key))return false;seen.current.add(key);return true;};
  const peerLastRead=chat.peerLastReadMessageId,peerName=chat.peer.displayName;
  const renderRow=useCallback(({item,index}:{item:Row;index:number})=>{
    const message=item.message,p=item.pending,mine=!!p||message?.senderId===user.id;
    const file=message?.attachment||p?.attachment,reply=message?.meta?.reply||p?.meta?.reply;
    const original=reply?view.byClientId.get(reply.clientId):undefined;
    return <MessageRow row={item} selecting={!!selection} selected={!!selection?.has(item.key)} fresh={fresh(item.key)} olderCreatedAt={rows[index+1]?.createdAt} mine={mine} author={mine?'Ты':peerName} peerLastRead={peerLastRead} wide={wide} fontSize={metrics.fontSize} lineHeight={metrics.lineHeight} downloading={!!downloadId&&file?.id===downloadId} replyAuthor={reply?(reply.senderId===user.id?'Ты':peerName):undefined} replyText={reply?(original?replyPreview(original):reply.preview||'Сообщение удалено'):undefined} api={api} handlers={handlers}/>;
  },[rows,user.id,peerName,peerLastRead,wide,metrics,downloadId,view.byClientId,api,selection]);
  const [circleOpen,setCircleOpen]=useState(false);
  const sendVideoNote=async(take:VideoNoteTake)=>{
    setCircleOpen(false);
    const chatId=chat.id,reply=replyTo?{clientId:replyTo.clientId,senderId:replyTo.senderId,preview:replyPreview(replyTo)}:undefined;
    uploadingRef.current=true;setUploading(true);setLocalError('');
    try{
      const name=videoNoteFileName();
      const uploaded=await store.uploadEncrypted({uri:take.uri,name:'video.mp4',mimeType:'video/mp4'});
      store.send(chatId,'',{...uploaded,name,mimeType:'video/mp4',media:{...(uploaded.media||{}),durationMs:uploaded.media?.durationMs||Math.round(take.durationMs)}},reply?{reply}:undefined);
      if(reply)setReplyTo(null);
      listRef.current?.scrollToOffset({offset:0,animated:true});
    }catch(e){if(alive.current)setLocalError(e instanceof Error?e.message:'Не удалось отправить видеосообщение.');}
    finally{uploadingRef.current=false;if(alive.current)setUploading(false);await FileSystem.deleteAsync(take.uri,{idempotent:true}).catch(()=>{});}
  };
  return <VoicePlaybackProvider api={api}><KeyboardSafeView style={{flex:1,backgroundColor:'transparent'}}>
    <View pointerEvents="box-none" onLayout={e=>setHeaderHeight(e.nativeEvent.layout.height)} style={{position:'absolute',top:0,left:0,right:0,zIndex:5,paddingTop:8,gap:6}}>
    {/* Messages fade out under the status bar instead of ending at a hard edge. */}
    <LinearGradient pointerEvents="none" colors={[t.bgGradient[0],'transparent']} style={{position:'absolute',top:0,left:0,right:0,height:34}}/>
    {selection?<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12}}>
      <GlassSurface material="regular" radius={24} interactive contentStyle={{height:48,justifyContent:'center',paddingHorizontal:16}}><Pressable onPress={()=>setSelection(null)} accessibilityRole="button" hitSlop={8}><Text style={{color:t.accent,fontSize:16,fontWeight:'600'}}>Отмена</Text></Pressable></GlassSurface>
      <View style={{flex:1,alignItems:'center'}}><GlassSurface material="regular" radius={24} contentStyle={{height:48,justifyContent:'center',paddingHorizontal:18}}><Text style={{color:t.text,fontSize:16,fontWeight:'700'}}>Выбрано: {selectedMessages.length}</Text></GlassSurface></View>
      <GlassSurface material="regular" radius={24} interactive contentStyle={{height:48,width:48,alignItems:'center',justifyContent:'center'}}><Pressable onPress={()=>void copy(selectedMessages.map(m=>m.meta?.poll?replyPreview(m):m.text).filter(Boolean).join('\n\n')).then(()=>setSelection(null))} disabled={!selectedMessages.some(m=>m.text)} accessibilityRole="button" accessibilityLabel="Скопировать выбранные" style={{opacity:selectedMessages.some(m=>m.text)?1:.4}}><Icon name="copy-outline" size={21} color={t.accent}/></Pressable></GlassSurface>
    </View>:<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12}}>
      {!wide?<GlassSurface material="regular" radius={26} interactive contentStyle={{height:52,minWidth:52,flexDirection:'row',alignItems:'center',justifyContent:'center',paddingHorizontal:otherUnread?10:0,gap:4}}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={`Назад к чатам${otherUnread?`, непрочитанных ${otherUnread}`:''}`} hitSlop={6} style={{flexDirection:'row',alignItems:'center',gap:4}}><Icon name="chevron-back" size={26} color={t.text}/>{otherUnread?<View style={{minWidth:22,height:22,borderRadius:11,paddingHorizontal:6,backgroundColor:t.text,alignItems:'center',justifyContent:'center'}}><Text style={{color:t.dark?'#000':'#FFF',fontSize:12,fontWeight:'700'}}>{otherUnread>99?'99+':otherUnread}</Text></View>:null}</Pressable></GlassSurface>:null}
      <View style={{flex:1,alignItems:'center'}}>
        <GlassSurface material="regular" radius={26} interactive contentStyle={{minHeight:52,justifyContent:'center',paddingHorizontal:20,paddingVertical:5}}>
          <Pressable onPress={()=>setPeerInfo(true)} accessibilityRole="button" accessibilityLabel={`Профиль ${chat.peer.displayName}`} style={{alignItems:'center',gap:1}}>
            <View style={{flexDirection:'row',gap:5,alignItems:'center'}}><Text numberOfLines={1} style={{flexShrink:1,color:t.text,fontSize:16,fontWeight:'700',letterSpacing:-.25}}>{chat.peer.displayName}</Text><StatusEmoji user={chat.peer} size={16}/></View>
            <Text numberOfLines={1} style={{color:headerStatus.accent?t.accent:t.muted,fontSize:12}}>{headerStatus.text}</Text>
          </Pressable>
        </GlassSurface>
      </View>
      {calls.available?<GlassSurface material="regular" radius={26} interactive contentStyle={{width:52,height:52,alignItems:'center',justifyContent:'center'}}><Pressable onPress={()=>calls.start(chat,false)} onLongPress={()=>calls.start(chat,true)} disabled={calls.busy} accessibilityRole="button" accessibilityLabel="Позвонить. Удерживай — видеозвонок" hitSlop={6}><Icon name="call" size={22} color={t.text}/></Pressable></GlassSurface>:null}
      <Pressable onPress={()=>setPeerInfo(true)} accessibilityRole="button" accessibilityLabel="Открыть профиль" style={({pressed})=>({opacity:pressed?.75:1,borderRadius:28,borderWidth:1.5,borderColor:t.glassBorder})}><Avatar user={chat.peer} api={api} size={52}/></Pressable>
    </View>}
    {onOpenMusic&&!selection?<TopPlayerBar onOpen={onOpenMusic}/>:null}
    {searchOpen?<GlassSurface material="regular" radius={22} shadow={false} style={{marginHorizontal:12}} contentStyle={{flexDirection:'row',alignItems:'center',gap:9,paddingHorizontal:14,minHeight:46}}>
      <Icon name="search-outline" size={18} color={t.muted}/>
      <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Поиск в этом чате" placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} accessibilityLabel="Поиск в этом чате" style={{flex:1,color:t.text,fontSize:15,paddingVertical:10}}/>
      {needle?<Text style={{color:t.muted,fontSize:11}}>{rows.length?`Найдено: ${rows.length}`:'Ничего'}</Text>:null}
      <IconButton name="close" label="Закрыть поиск" size={18} color={t.muted} onPress={()=>{setSearchOpen(false);setQuery('');}} style={{width:34,height:38}}/>
    </GlassSurface>:null}
    {view.pinned&&!searchOpen?<GlassSurface material="regular" radius={18} shadow={false} style={{marginHorizontal:12}} contentStyle={{flexDirection:'row',alignItems:'center',gap:8,paddingLeft:12,paddingRight:4,minHeight:44}}>
      <Pressable accessibilityRole="button" accessibilityLabel="Перейти к закреплённому сообщению" onPress={()=>jumpTo(view.pinned!.clientId)} style={{flex:1,flexDirection:'row',alignItems:'center',gap:9}}>
        <View style={{width:3,alignSelf:'stretch',marginVertical:8,borderRadius:2,backgroundColor:t.accent}}/>
        <View style={{flex:1,gap:2,paddingVertical:6}}><Text style={{color:t.accent,fontSize:11,fontWeight:'700'}}>Закреплённое сообщение</Text><Text numberOfLines={1} style={{color:t.text,fontSize:13}}>{replyPreview(view.pinned)||'Вложение'}</Text></View>
      </Pressable>
      <IconButton name="close" label="Открепить" size={18} color={t.muted} onPress={()=>store.sendAction(chat.id,{type:'pin',target:null})} style={{width:38,height:40}}/>
    </GlassSurface>:null}
    {notice?<Pressable onPress={()=>setNotice('')} style={{alignSelf:'center',marginVertical:4,paddingVertical:7,paddingHorizontal:14,backgroundColor:t.accentSoft,borderRadius:16,borderWidth:1,borderColor:t.border}}><Text style={{color:t.accent,fontSize:12}}>{notice}</Text></Pressable>:null}
    {failedActions.length?<Pressable onPress={()=>failedActions.forEach(item=>void store.retry(item))} style={{alignSelf:'center',marginVertical:4,paddingVertical:7,paddingHorizontal:14,borderRadius:16,borderWidth:1,borderColor:t.danger}}><Text style={{color:t.danger,fontSize:12}}>Действие не отправлено · повторить</Text></Pressable>:null}
    {store.cryptoError?<View style={{paddingHorizontal:13,paddingBottom:8}}><Notice text={store.cryptoError} error onRetry={()=>setSecurityOpen(true)}/></View>:null}
    {store.error||localError?<View style={{paddingHorizontal:13,paddingVertical:8}}><Notice text={localError||store.error} error onRetry={()=>{setLocalError('');void store.loadMessages(chat.id);}}/></View>:null}
    {copied?<View style={{alignSelf:'center',marginTop:6,paddingVertical:7,paddingHorizontal:14,backgroundColor:t.accentSoft,borderRadius:16,borderWidth:1,borderColor:t.border}}><Text style={{color:t.accent,fontSize:12}}>Скопировано</Text></View>:null}
    </View>
    {rows.length===0?<View style={{flex:1,justifyContent:'center',paddingTop:headerHeight}}>{store.messageLoading?<ActivityIndicator color={t.accent}/>:<Empty icon="hand-left-outline" title="Скажи «привет»" description={`Это начало вашей переписки с ${chat.peer.displayName}.`}/>}</View>:<FlatList ref={listRef} inverted data={rows} keyExtractor={row=>row.key} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS==='ios'?'interactive':'on-drag'} contentContainerStyle={{paddingHorizontal:wide?28:15,paddingTop:10,paddingBottom:headerHeight+14}} onScroll={e=>{const down=e.nativeEvent.contentOffset.y>350;if(down!==showDown)setShowDown(down);}} scrollEventThrottle={100} initialNumToRender={25} windowSize={11} onScrollToIndexFailed={info=>{listRef.current?.scrollToOffset({offset:info.averageItemLength*info.index,animated:true});setTimeout(()=>listRef.current?.scrollToIndex({index:info.index,animated:true,viewPosition:.5}),250);}}
      ListFooterComponent={store.hasMore[chat.id]?<View style={{alignItems:'center',padding:18}}><GlassSurface material="clear" radius={19} shadow={false}><Pressable onPress={()=>void store.loadMessages(chat.id,true)} disabled={store.messageLoading} accessibilityRole="button" style={{paddingVertical:11,paddingHorizontal:17}}>{store.messageLoading?<ActivityIndicator size="small" color={t.accent}/>:<Text style={{fontSize:12,color:t.accent,fontWeight:'600'}}>Более ранние сообщения</Text>}</Pressable></GlassSurface></View>:null}
      renderItem={renderRow} removeClippedSubviews={Platform.OS==='android'} maxToRenderPerBatch={12} updateCellsBatchingPeriod={40}/>
    }
    {showDown&&!selection?<View pointerEvents="box-none" style={{height:0,zIndex:4}}><View style={{position:'absolute',right:14,bottom:10}}><GlassSurface material="regular" radius={24} interactive contentStyle={{width:48,height:48,alignItems:'center',justifyContent:'center'}}><Pressable onPress={()=>{lightFeedback();listRef.current?.scrollToOffset({offset:0,animated:true});}} accessibilityRole="button" accessibilityLabel="Вниз к новым сообщениям" hitSlop={6}><Icon name="chevron-down" size={26} color={t.text}/></Pressable></GlassSurface></View></View>:null}
    {selection?<GlassSurface material="regular" radius={28} style={{marginHorizontal:12,marginTop:5,marginBottom:10}} contentStyle={{flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingVertical:8}}>
      {([
        {icon:'arrow-redo-outline',label:'Переслать',on:()=>{setForwardMany(selectedMessages);},ok:selectedMessages.length>0},
        {icon:'share-outline',label:'Поделиться',on:()=>{void shareMessages(selectedMessages);setSelection(null);},ok:selectedMessages.length>0},
        {icon:'bookmark-outline',label:'В Избранное',on:()=>{selectedMessages.forEach(saveToFavorites);setSelection(null);},ok:selectedMessages.length>0},
        {icon:'trash-outline',label:'Удалить',on:()=>setDeleteAsk(true),ok:selectedMessages.length>0,danger:true},
      ] as const).map(item=><Pressable key={item.label} disabled={!item.ok} onPress={()=>{lightFeedback();item.on();}} accessibilityRole="button" style={({pressed})=>({alignItems:'center',gap:4,paddingHorizontal:8,paddingVertical:4,opacity:!item.ok?.35:pressed?.6:1})}><Icon name={item.icon} size={22} color={'danger' in item?t.danger:t.accent}/><Text style={{fontSize:10,color:'danger' in item?t.danger:t.accent,fontWeight:'600'}}>{item.label}</Text></Pressable>)}
    </GlassSurface>:<View style={{marginHorizontal:10,marginTop:4,marginBottom:10,gap:6}}>
      {replyTo||editing||uploading||attachments.length?<GlassSurface material="regular" radius={22} contentStyle={{paddingHorizontal:8,paddingTop:8,paddingBottom:2}}>
      {replyTo||editing?<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingLeft:8,paddingBottom:6}}>
        <Icon name={editing?'create-outline':'arrow-undo-outline'} size={18} color={t.accent}/>
        <View style={{width:3,alignSelf:'stretch',borderRadius:2,backgroundColor:t.accent}}/>
        <View style={{flex:1,gap:1}}><Text style={{color:t.accent,fontSize:11,fontWeight:'700'}}>{editing?'Редактирование':`Ответ ${nameOf((replyTo as ViewMessage).senderId)==='Ты'?'себе':nameOf((replyTo as ViewMessage).senderId)}`}</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>{replyPreview((editing||replyTo)!)}</Text></View>
        <IconButton name="close" label={editing?'Отменить редактирование':'Отменить ответ'} size={18} color={t.muted} onPress={()=>{if(editing)store.setDraft(chat.id,'');setEditing(null);setReplyTo(null);}} style={{width:36,height:36}}/>
      </View>:null}
      {uploading?<View style={{flexDirection:'row',alignItems:'center',gap:9,padding:12,paddingTop:4}}><ActivityIndicator size="small" color={t.accent}/><Text style={{fontSize:12,color:t.muted}}>Обрабатываем и шифруем вложение…</Text></View>:null}
      {attachments.length?<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:7,paddingBottom:7}}>{attachments.map((attachment,index)=>{
        const kind=mediaPreviewKind(attachment);
        return <View key={attachment.id} style={{width:230,flexDirection:'row',alignItems:'center',gap:8,padding:10,borderRadius:19,backgroundColor:t.accentSoft,borderWidth:1,borderColor:t.border}}><Icon name={kind==='photo'?'image-outline':kind==='video'?'videocam-outline':kind==='audio'?'musical-note-outline':'document-outline'} color={t.accent} size={21}/><View style={{flex:1,gap:3}}><Text numberOfLines={1} style={{color:t.text,fontSize:12,fontWeight:'600'}}>{attachment.name}</Text><Text style={{color:t.muted,fontSize:10}}>{index+1} · {formatSize(attachment.size)}</Text></View><IconButton name="close" label={`Убрать ${attachment.name}`} onPress={()=>{store.removeDraftFile(chat.id,attachment.id);draftCount.current=Math.max(0,draftCount.current-1);}} disabled={uploading} size={18} style={{width:30,height:32}}/></View>;
      })}</ScrollView>:null}
      </GlassSurface>:null}
      {voice.active?<GlassSurface material="regular" radius={26} contentStyle={{padding:6}}><VoiceRecordingBar durationMs={voice.durationMs} levels={voice.levels} onCancel={()=>void finishVoice(false)} onSend={()=>void finishVoice(true)}/></GlassSurface>:<View style={{flexDirection:'row',gap:8,alignItems:'flex-end'}}>
        <GlassSurface material="regular" radius={24} interactive contentStyle={{width:48,height:48,alignItems:'center',justifyContent:'center'}}><Pressable accessibilityRole="button" accessibilityLabel="Вложения: галерея, файлы, опрос" disabled={uploading} onPress={()=>{Keyboard.dismiss();setStickers(false);setAttachMenu(true);}} hitSlop={6} style={{opacity:uploading?.4:1}}><Icon name="attach" size={27} color={t.text}/></Pressable></GlassSurface>
        <GlassSurface material="regular" radius={24} style={{flex:1}} contentStyle={{minHeight:48,maxHeight:140,flexDirection:'row',alignItems:'flex-end'}}>
          <View style={{flex:1,justifyContent:'center',minHeight:48}}><ComposerInput accessibilityLabel="Сообщение" placeholder={signalAvailable?'Сообщение':'Нужна мобильная версия'} editable={signalAvailable} value={text} onChangeText={changeText} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} multiline maxLength={8000} style={{fontSize:16,lineHeight:21,color:t.text,paddingHorizontal:14,paddingTop:Platform.OS==='ios'?12:10,paddingBottom:12,maxHeight:136}} onKeyPress={e=>{if(Platform.OS==='web'&&e.nativeEvent.key==='Enter'&&!(e.nativeEvent as unknown as {shiftKey?:boolean}).shiftKey){e.preventDefault();send();}}}/></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Стикеры и эмодзи" onPress={()=>{Keyboard.dismiss();setStickers(value=>!value);}} style={({pressed})=>({height:48,width:42,alignItems:'center',justifyContent:'center',opacity:pressed?.6:1})}><Icon name={stickers?'keypad-outline':'happy-outline'} color={stickers?t.accent:t.muted} size={24}/></Pressable>
        </GlassSurface>
        {canSend||!signalAvailable||uploading?<Pressable accessibilityRole="button" accessibilityLabel="Отправить сообщение" disabled={!signalAvailable||uploading||(!text.trim()&&!attachments.length&&!editing)} onPress={send} style={({pressed})=>({height:48,width:48,borderRadius:24,backgroundColor:t.accent,alignItems:'center',justifyContent:'center',opacity:!signalAvailable||uploading||(!text.trim()&&!attachments.length&&!editing)?.4:pressed?.75:1})}><Icon name={editing?'checkmark':'arrow-up'} color={t.onAccent} size={25}/></Pressable>
        :<GlassSurface material="regular" radius={24} interactive contentStyle={{width:48,height:48,alignItems:'center',justifyContent:'center'}}><Pressable accessibilityRole="button" accessibilityLabel={recordMode==='voice'?'Голосовое: удерживай для записи, нажми — переключить на видео':'Видеосообщение: удерживай для записи, нажми — переключить на голосовое'} delayLongPress={220}
          onPress={()=>{lightFeedback();const next=recordMode==='voice'?'video':'voice';setRecordMode(next);setNotice(next==='video'?'Удерживай, чтобы записать видеосообщение':'Удерживай, чтобы записать голосовое');setTimeout(()=>setNotice(current=>current.startsWith('Удерживай')?'':current),1800);}}
          onLongPress={()=>{setNotice('');if(recordMode==='voice')startVoice();else{impactFeedback();Keyboard.dismiss();setLocalError('');setCircleOpen(true);}}} hitSlop={6}><Icon name={recordMode==='voice'?'mic-outline':'videocam-outline'} color={t.text} size={25}/></Pressable></GlassSurface>}
      </View>}
      {text.length>7500?<Text style={{fontSize:10,color:t.muted,textAlign:'right',paddingRight:8}}>{text.length} / 8000</Text>:null}
    </View>}
    {stickers&&!selection?<StickerPanel onPick={emoji=>{if(!signalAvailable)return;lightFeedback();const reply=replyTo?{clientId:replyTo.clientId,senderId:replyTo.senderId,preview:replyPreview(replyTo)}:undefined;store.send(chat.id,emoji,null,reply?{reply}:undefined);if(reply)setReplyTo(null);listRef.current?.scrollToOffset({offset:0,animated:true});}} onClose={()=>setStickers(false)}/>:null}
    <VideoNoteRecorder visible={circleOpen} onClose={()=>setCircleOpen(false)} onDone={take=>void sendVideoNote(take)}/>
    <AttachmentPanel key={photoContext} onPoll={()=>{setAttachMenu(false);setTimeout(()=>setPollOpen(true),350);}} visible={attachMenu} busy={uploading} canAdd={signalAvailable} remainingSlots={Math.max(0,MAX_DRAFT_ATTACHMENTS-attachments.length)} onClose={()=>setAttachMenu(false)} onAdd={item=>upload(item.file)}/>
    <TrustSheet visible={securityOpen} onClose={()=>setSecurityOpen(false)} peerId={chat.peer.id} store={store}/>
    {peerInfo?<UserProfile api={api} user={chat.peer} chat={chat} status={headerStatus.text.startsWith('@')||headerStatus.text.endsWith('…')?undefined:headerStatus.text} onClose={()=>setPeerInfo(false)} onMute={muted=>store.updateChatSettings(chat.id,{muted})} onSearch={()=>{setSearchOpen(true);setQuery('');}} onSecurity={()=>setTimeout(()=>setSecurityOpen(true),350)}/>:null}
    <ContextMenu visible={!!actions} y={menuY} onClose={()=>setActions(null)} preview={actions?(actions.message?.text||actions.pending?.text||(actions.message?.attachment||actions.pending?.attachment?attachmentLabel((actions.message?.attachment||actions.pending?.attachment)!):'')):''} mine={!!actions&&(!!actions.pending||actions.message?.senderId===user.id)} reactions={actions?.message&&actions.message.cryptoState==='decrypted'?<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:2}}>{REACTIONS.map(emoji=>{const chosen=actions.message!.reactions.some(r=>r.mine&&r.emoji===emoji);return <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`Реакция ${emoji}`} accessibilityState={{selected:chosen}} onPress={()=>{react(actions.message!,emoji);setActions(null);}} style={{width:42,height:42,borderRadius:21,alignItems:'center',justifyContent:'center',backgroundColor:chosen?t.accentSoft:'transparent'}}><Text style={{fontSize:21}}>{emoji}</Text></Pressable>;})}</ScrollView>:null}>
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="arrow-undo-outline" label="Ответить" onPress={()=>{setEditing(null);setReplyTo(actions.message!);setActions(null);}}/>:null}
      {(actions?.message?.text||actions?.pending?.text)?<MenuItem icon="copy-outline" label="Скопировать" onPress={()=>void copy(actions?.message?.text||actions?.pending?.text||'')}/>:null}
      {(actions?.message?.attachment||actions?.pending?.attachment)?<MenuItem icon="download-outline" label="Сохранить" onPress={()=>{const a=actions?.message?.attachment||actions?.pending?.attachment;setActions(null);if(a)void download(a);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon={view.pinned?.clientId===actions.message.clientId?'pin':'pin-outline'} label={view.pinned?.clientId===actions.message.clientId?'Открепить':'Закрепить'} onPress={()=>{const m=actions.message!;store.sendAction(chat.id,{type:'pin',target:view.pinned?.clientId===m.clientId?null:m.clientId},m.text);setActions(null);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="arrow-redo-outline" label="Переслать" onPress={()=>{setForwarding(actions.message!);setActions(null);}}/>:null}
      {actions?.message&&actions.message.senderId===user.id&&actions.message.cryptoState==='decrypted'&&actions.message.text?<MenuItem icon="create-outline" label="Изменить" onPress={()=>{setReplyTo(null);setEditing(actions.message!);store.setDraft(chat.id,actions.message!.text);setActions(null);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="share-outline" label="Поделиться" onPress={()=>{const row=actions;setActions(null);void shareMessages(rowMessages(row));}}/>:null}
      {actions?.message?<MenuItem icon="checkmark-circle-outline" label="Выбрать" onPress={()=>startSelect(actions)}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="bookmark-outline" label="В Избранное" onPress={()=>{const m=actions.message!;setActions(null);saveToFavorites(m);}}/>:null}
      {actions?.pending?.state==='failed'?<MenuItem icon="refresh-outline" label="Повторить отправку" onPress={()=>{if(actions.pending)void store.retry(actions.pending);setActions(null);}}/>:null}
      {actions?.message?<MenuItem icon="eye-off-outline" label="Удалить у меня" description="Сообщение исчезнет только на этом устройстве" danger onPress={()=>{rowMessages(actions).forEach(m=>store.hideForMe(m));setActions(null);}}/>:null}
      {actions?.message&&actions.message.senderId===user.id&&actions.message.cryptoState==='decrypted'?<MenuItem icon="trash-outline" label="Удалить у всех" description="Собеседник перестанет видеть сообщение. Зашифрованная копия на сервере остаётся нечитаемой." danger onPress={()=>{rowMessages(actions).forEach(m=>store.sendAction(chat.id,{type:'delete',target:m.clientId}));setActions(null);}}/>:null}
    </ContextMenu>
    <Sheet visible={!!forwarding} title="Переслать в чат" onClose={()=>setForwarding(null)}>
      <SheetAction icon="bookmark-outline" label="Избранное" description="Только на этом устройстве" onPress={()=>{const m=forwarding!;setForwarding(null);saveToFavorites(m);}}/>
      {store.chats.length?store.chats.map(target=><SheetAction key={target.id} icon="chatbubble-outline" label={target.peer.displayName} description={`@${target.peer.username}`} onPress={()=>{const m=forwarding!;setForwarding(null);store.forward(target.id,m,originalAuthor(m)).then(()=>setNotice(`Переслано: ${target.peer.displayName}`)).catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось переслать.'));}}/>):<Text style={{color:t.muted,fontSize:13}}>Пока нет других чатов.</Text>}
    </Sheet>
    <AttachmentViewer api={api} attachment={preview} onClose={()=>setPreview(null)}/>
    {gallery?<MediaGallery api={api} items={gallery.items} index={gallery.index} onClose={()=>setGallery(null)}/>:null}
    <PollComposer visible={pollOpen} onClose={()=>setPollOpen(false)} onSend={poll=>{setPollOpen(false);lightFeedback();store.sendPoll(chat.id,poll);listRef.current?.scrollToOffset({offset:0,animated:true});}}/>
    <Sheet visible={deleteAsk} title={`Удалить ${selectedMessages.length} ${selectedMessages.length===1?'сообщение':selectedMessages.length<5?'сообщения':'сообщений'}?`} onClose={()=>setDeleteAsk(false)}>
      <SheetAction icon="eye-off-outline" label="Удалить у меня" description="Исчезнут только на этом устройстве" danger onPress={()=>{setDeleteAsk(false);deleteSelected(false);}}/>
      {selectedMessages.length&&selectedMessages.every(m=>m.senderId===user.id)?<SheetAction icon="trash-outline" label="Удалить у всех" description="Собеседник тоже перестанет их видеть" danger onPress={()=>{setDeleteAsk(false);deleteSelected(true);}}/>:null}
    </Sheet>
    <Sheet visible={!!forwardMany} title={`Переслать (${forwardMany?.length||0})`} onClose={()=>setForwardMany(null)}>
      {store.chats.map(target=><SheetAction key={target.id} icon="chatbubble-outline" label={target.peer.displayName} description={`@${target.peer.username}`} onPress={()=>{const list=forwardMany||[];setForwardMany(null);setSelection(null);void (async()=>{for(const m of list)await store.forward(target.id,m,originalAuthor(m));})().then(()=>setNotice(`Переслано: ${target.peer.displayName}`)).catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось переслать.'));}}/>)}
    </Sheet>
  </KeyboardSafeView></VoicePlaybackProvider>;
}
