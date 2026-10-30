import { StatusEmoji } from './StatusEmoji';
import { ComposerInput } from './ComposerInput';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Dimensions, FlatList, Keyboard, PanResponder, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from './typography';
import { KeyboardSafeView } from './keyboard';
import * as Clipboard from 'expo-clipboard';
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
import { textMetrics, useChatPreferences } from './chatPreferences';
import { REACTIONS, foldChat, replyPreview, type Reaction, type ViewMessage } from './messageMeta';
import { VoicePlaybackProvider, VoiceRecordingBar, useVoiceRecorder } from './voice/VoiceMessage';
import { MessageRow, type Row, type RowHandlers } from './MessageRow';
import { ContextMenu, MenuItem } from './ContextMenu';
import { UserProfile } from './UserProfile';
import { impactFeedback, lightFeedback } from './haptics';
import { VideoNoteRecorder, type VideoNoteTake } from './videonote/VideoNote';
import { useCallback } from 'react';
import { attachmentLabel } from './voice/voice';
import { VOICE_MIME, VOICE_MIN_MS, videoNoteFileName, voiceFileName } from './voice/voice';


export function ChatScreen({api,user,chat,store,onBack,wide=false}: {api:Api;user:User;chat:Chat;store:MessengerStore;onBack:()=>void;wide?:boolean}) {
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
  useEffect(()=>{setReplyTo(null);setEditing(null);setForwarding(null);setSearchOpen(false);setQuery('');},[chat.id]);
  const needle=query.trim().toLocaleLowerCase('ru');
  const rows=useMemo<Row[]>(()=>{
    const all:Row[]=[
      ...view.messages.map(message=>({key:`m${message.id}`,message,createdAt:message.createdAt})),
      ...pending.map(p=>({key:`p${p.clientId}`,pending:p,createdAt:p.createdAt})),
    ];
    const visible=searchOpen&&needle?all.filter(row=>(row.message?.text||row.pending?.text||'').toLocaleLowerCase('ru').includes(needle)||(row.message?.attachment?.name||'').toLocaleLowerCase('ru').includes(needle)):all;
    return visible.reverse();
  },[view,pending,searchOpen,needle]);
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
  const openAttachment=(file:Attachment)=>{if(mediaPreviewKind(file)!=='file')setPreview(file);else void download(file);};
  const copy=async(value:string)=>{await Clipboard.setStringAsync(value);setActions(null);setCopied(true);setTimeout(()=>setCopied(false),2000);};
  const isTyping=(store.typing[chat.id]||0)>Date.now();

  // Swipe right anywhere in the chat to go back, as in Telegram for iPhone.
  const backX=useRef(new Animated.Value(0)).current;const backRef=useRef(onBack);backRef.current=onBack;
  const backSwipe=useRef(PanResponder.create({
    onMoveShouldSetPanResponder:(_e,g)=>g.dx>14&&Math.abs(g.dx)>Math.abs(g.dy)*2,
    onPanResponderMove:(_e,g)=>backX.setValue(Math.max(0,g.dx)),
    onPanResponderRelease:(_e,g)=>{if(g.dx>110||g.vx>0.8)lightFeedback();if(g.dx>110||g.vx>0.8)Animated.timing(backX,{toValue:Dimensions.get('window').width,duration:160,useNativeDriver:true}).start(()=>backRef.current());else Animated.spring(backX,{toValue:0,useNativeDriver:true}).start();},
    onPanResponderTerminate:()=>Animated.spring(backX,{toValue:0,useNativeDriver:true}).start(),
  })).current;
  const handlers=useRef<RowHandlers>(null as unknown as RowHandlers);
  handlers.current={actions:(row,y)=>{setMenuY(y);setActions(row);},jumpTo,open:openAttachment,react,retry:pending=>void store.retry(pending),reply:message=>{setEditing(null);setReplyTo(message);}};
  const peerLastRead=chat.peerLastReadMessageId,peerName=chat.peer.displayName;
  const renderRow=useCallback(({item,index}:{item:Row;index:number})=>{
    const message=item.message,p=item.pending,mine=!!p||message?.senderId===user.id;
    const file=message?.attachment||p?.attachment,reply=message?.meta?.reply||p?.meta?.reply;
    const original=reply?view.byClientId.get(reply.clientId):undefined;
    return <MessageRow row={item} olderCreatedAt={rows[index+1]?.createdAt} mine={mine} author={mine?'Ты':peerName} peerLastRead={peerLastRead} wide={wide} fontSize={metrics.fontSize} lineHeight={metrics.lineHeight} downloading={!!downloadId&&file?.id===downloadId} replyAuthor={reply?(reply.senderId===user.id?'Ты':peerName):undefined} replyText={reply?(original?replyPreview(original):reply.preview||'Сообщение удалено'):undefined} api={api} handlers={handlers}/>;
  },[rows,user.id,peerName,peerLastRead,wide,metrics,downloadId,view.byClientId,api]);
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
  return <VoicePlaybackProvider api={api}><Animated.View style={{flex:1,transform:[{translateX:backX}]}} {...(wide?{}:backSwipe.panHandlers)}><KeyboardSafeView style={{flex:1,backgroundColor:'transparent'}}>
    <GlassSurface material="regular" radius={27} style={{marginHorizontal:12,marginTop:12,marginBottom:8}} contentStyle={{minHeight:70,flexDirection:'row',alignItems:'center',gap:9,paddingHorizontal:wide?17:8,paddingVertical:10}}>
      {!wide?<IconButton name="chevron-back" label="Назад к чатам" onPress={onBack} style={{width:38,height:43}}/>:null}
      <Pressable onPress={()=>setPeerInfo(true)} accessibilityRole="button" accessibilityLabel={`Профиль ${chat.peer.displayName}`} style={{flex:1,flexDirection:'row',gap:12,alignItems:'center'}}><Avatar user={chat.peer} api={api} size={43}/><View style={{flex:1,gap:5}}><View style={{flexDirection:'row',gap:5,alignItems:'center'}}><Text numberOfLines={1} style={{flexShrink:1,color:t.text,fontSize:16,fontWeight:'700',letterSpacing:-.25}}>{chat.peer.displayName}</Text><StatusEmoji user={chat.peer} size={16}/></View><Text style={{color:isTyping?t.accent:t.muted,fontSize:11}}>{isTyping?'печатает…':`@${chat.peer.username}`}</Text></View></Pressable>
      <IconButton name={searchOpen?'close':'search-outline'} label={searchOpen?'Закрыть поиск':'Поиск по переписке'} onPress={()=>{setSearchOpen(!searchOpen);setQuery('');}} color={searchOpen?t.accent:t.muted} style={{width:39,height:43}}/>
      <IconButton name="ellipsis-horizontal" label="О собеседнике" onPress={()=>setPeerInfo(true)} color={t.muted} style={{width:39,height:43}}/>
    </GlassSurface>
    {searchOpen?<GlassSurface material="regular" radius={22} shadow={false} style={{marginHorizontal:12,marginBottom:6}} contentStyle={{flexDirection:'row',alignItems:'center',gap:9,paddingHorizontal:14,minHeight:46}}>
      <Icon name="search-outline" size={18} color={t.muted}/>
      <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Поиск в этом чате" placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} accessibilityLabel="Поиск в этом чате" style={{flex:1,color:t.text,fontSize:15,paddingVertical:10}}/>
      {needle?<Text style={{color:t.muted,fontSize:11}}>{rows.length?`Найдено: ${rows.length}`:'Ничего'}</Text>:null}
    </GlassSurface>:null}
    {view.pinned&&!searchOpen?<GlassSurface material="clear" radius={18} shadow={false} style={{marginHorizontal:12,marginBottom:6}} contentStyle={{flexDirection:'row',alignItems:'center',gap:8,paddingLeft:12,paddingRight:4,minHeight:44}}>
      <Pressable accessibilityRole="button" accessibilityLabel="Перейти к закреплённому сообщению" onPress={()=>jumpTo(view.pinned!.clientId)} style={{flex:1,flexDirection:'row',alignItems:'center',gap:9}}>
        <View style={{width:3,alignSelf:'stretch',marginVertical:8,borderRadius:2,backgroundColor:t.accent}}/>
        <View style={{flex:1,gap:2,paddingVertical:6}}><Text style={{color:t.accent,fontSize:11,fontWeight:'700'}}>Закреплённое сообщение</Text><Text numberOfLines={1} style={{color:t.text,fontSize:13}}>{replyPreview(view.pinned)||'Вложение'}</Text></View>
      </Pressable>
      <IconButton name="close" label="Открепить" size={18} color={t.muted} onPress={()=>store.sendAction(chat.id,{type:'pin',target:null})} style={{width:38,height:40}}/>
    </GlassSurface>:null}
    {notice?<Pressable onPress={()=>setNotice('')} style={{alignSelf:'center',marginVertical:4,paddingVertical:7,paddingHorizontal:14,backgroundColor:t.accentSoft,borderRadius:16,borderWidth:1,borderColor:t.border}}><Text style={{color:t.accent,fontSize:12}}>{notice}</Text></Pressable>:null}
    {failedActions.length?<Pressable onPress={()=>failedActions.forEach(item=>void store.retry(item))} style={{alignSelf:'center',marginVertical:4,paddingVertical:7,paddingHorizontal:14,borderRadius:16,borderWidth:1,borderColor:t.danger}}><Text style={{color:t.danger,fontSize:12}}>Действие не отправлено · повторить</Text></Pressable>:null}
    <Pressable accessibilityRole="button" accessibilityLabel="Защита чата и проверка ключей" onPress={()=>setSecurityOpen(true)} style={{paddingHorizontal:18,paddingVertical:8,flexDirection:'row',gap:7,alignItems:'center',justifyContent:'center'}}><Icon name="lock-closed-outline" color={t.accent} size={15}/><Text style={{color:t.muted,fontSize:11,flexShrink:1}}>{signalAvailable?'Сквозное шифрование · проверить устройства':'Переписка доступна в приложении Android/iPhone'}</Text><Icon name="chevron-forward" color={t.muted} size={13}/></Pressable>
    {store.cryptoError?<View style={{paddingHorizontal:13,paddingBottom:8}}><Notice text={store.cryptoError} error onRetry={()=>setSecurityOpen(true)}/></View>:null}
    {store.connection!=='connected'?<View style={{paddingVertical:8,paddingHorizontal:18,flexDirection:'row',gap:7,justifyContent:'center',alignItems:'center'}}><Icon name="cloud-offline-outline" color={t.muted} size={15}/><Text style={{fontSize:11,color:t.muted}}>{store.connection==='connecting'?'Восстанавливаем соединение…':'Нет соединения с сервером'}</Text></View>:null}
    {store.error||localError?<View style={{paddingHorizontal:13,paddingVertical:8}}><Notice text={localError||store.error} error onRetry={()=>{setLocalError('');void store.loadMessages(chat.id);}}/></View>:null}
    {copied?<View style={{alignSelf:'center',marginTop:6,paddingVertical:7,paddingHorizontal:14,backgroundColor:t.accentSoft,borderRadius:16,borderWidth:1,borderColor:t.border}}><Text style={{color:t.accent,fontSize:12}}>Скопировано</Text></View>:null}
    {rows.length===0?<View style={{flex:1,justifyContent:'center'}}>{store.messageLoading?<ActivityIndicator color={t.accent}/>:<Empty icon="hand-left-outline" title="Скажи «привет»" description={`Это начало вашей переписки с ${chat.peer.displayName}.`}/>}</View>:<FlatList ref={listRef} inverted data={rows} keyExtractor={row=>row.key} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS==='ios'?'interactive':'on-drag'} contentContainerStyle={{paddingHorizontal:wide?28:15,paddingTop:14,paddingBottom:14}} initialNumToRender={25} windowSize={11} onScrollToIndexFailed={info=>{listRef.current?.scrollToOffset({offset:info.averageItemLength*info.index,animated:true});setTimeout(()=>listRef.current?.scrollToIndex({index:info.index,animated:true,viewPosition:.5}),250);}}
      ListFooterComponent={store.hasMore[chat.id]?<View style={{alignItems:'center',padding:18}}><GlassSurface material="clear" radius={19} shadow={false}><Pressable onPress={()=>void store.loadMessages(chat.id,true)} disabled={store.messageLoading} accessibilityRole="button" style={{paddingVertical:11,paddingHorizontal:17}}>{store.messageLoading?<ActivityIndicator size="small" color={t.accent}/>:<Text style={{fontSize:12,color:t.accent,fontWeight:'600'}}>Более ранние сообщения</Text>}</Pressable></GlassSurface></View>:null}
      renderItem={renderRow} removeClippedSubviews={Platform.OS==='android'} maxToRenderPerBatch={12} updateCellsBatchingPeriod={40}/>
    }
    <GlassSurface material="regular" radius={28} style={{marginHorizontal:12,marginTop:5,marginBottom:10}} contentStyle={{padding:8}}>
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
      {voice.active?<VoiceRecordingBar durationMs={voice.durationMs} levels={voice.levels} onCancel={()=>void finishVoice(false)} onSend={()=>void finishVoice(true)}/>:<View style={{flexDirection:'row',gap:6,alignItems:'flex-end'}}>
        <IconButton name="add" label="Добавить вложения: галерея, аудио или файлы" onPress={()=>{Keyboard.dismiss();setAttachMenu(true);}} color={t.accent} disabled={uploading} style={{width:44,height:44,borderRadius:21}}/>
        <View style={{flex:1,minHeight:44,maxHeight:140,justifyContent:'center'}}><ComposerInput accessibilityLabel="Сообщение" placeholder={signalAvailable?'Сообщение…':'Нужна мобильная версия'} editable={signalAvailable} value={text} onChangeText={changeText} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} multiline maxLength={8000} style={{fontSize:15,lineHeight:21,color:t.text,paddingHorizontal:6,paddingTop:Platform.OS==='ios'?11:10,paddingBottom:11,maxHeight:136}} onKeyPress={e=>{if(Platform.OS==='web'&&e.nativeEvent.key==='Enter'&&!(e.nativeEvent as unknown as {shiftKey?:boolean}).shiftKey){e.preventDefault();send();}}}/></View>
        {!canSend&&signalAvailable&&!uploading?<Pressable accessibilityRole="button" accessibilityLabel="Записать видеосообщение" onPress={()=>{Keyboard.dismiss();setLocalError('');setCircleOpen(true);}} style={({pressed})=>({height:44,width:40,borderRadius:22,alignItems:'center',justifyContent:'center',opacity:pressed?.6:1})}><Icon name="videocam-outline" color={t.accent} size={23}/></Pressable>:null}
        {!canSend&&signalAvailable&&!uploading?<Pressable accessibilityRole="button" accessibilityLabel="Записать голосовое сообщение" onPress={startVoice} style={({pressed})=>({height:44,width:44,borderRadius:22,alignItems:'center',justifyContent:'center',backgroundColor:t.accentSoft,borderWidth:1,borderColor:t.border,opacity:pressed?.7:1})}><Icon name="mic-outline" color={t.accent} size={23}/></Pressable>:<Pressable accessibilityRole="button" accessibilityLabel="Отправить сообщение" disabled={!signalAvailable||uploading||(!text.trim()&&!attachments.length)} onPress={send} style={({pressed})=>({height:44,width:44,borderRadius:22,backgroundColor:t.accent,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:t.dark?'rgba(255,255,255,0.32)':'rgba(255,255,255,0.7)',shadowColor:t.accent,shadowOpacity:.2,shadowRadius:9,shadowOffset:{width:0,height:3},opacity:!signalAvailable||uploading||(!text.trim()&&!attachments.length)?.4:pressed?.75:1})}><Icon name="arrow-up" color={t.onAccent} size={23}/></Pressable>}
      </View>}
      {text.length>7500?<Text style={{fontSize:10,color:t.muted,textAlign:'right',paddingTop:4,paddingRight:8}}>{text.length} / 8000</Text>:null}
    </GlassSurface>
    <VideoNoteRecorder visible={circleOpen} onClose={()=>setCircleOpen(false)} onDone={take=>void sendVideoNote(take)}/>
    <AttachmentPanel key={photoContext} visible={attachMenu} busy={uploading} canAdd={signalAvailable} remainingSlots={Math.max(0,MAX_DRAFT_ATTACHMENTS-attachments.length)} onClose={()=>setAttachMenu(false)} onAdd={item=>upload(item.file)}/>
    <TrustSheet visible={securityOpen} onClose={()=>setSecurityOpen(false)} peerId={chat.peer.id} store={store}/>
    {peerInfo?<UserProfile api={api} user={chat.peer} chat={chat} onClose={()=>setPeerInfo(false)} onMute={muted=>store.updateChatSettings(chat.id,{muted})}/>:null}
    <ContextMenu visible={!!actions} y={menuY} onClose={()=>setActions(null)} preview={actions?(actions.message?.text||actions.pending?.text||(actions.message?.attachment||actions.pending?.attachment?attachmentLabel((actions.message?.attachment||actions.pending?.attachment)!):'')):''} mine={!!actions&&(!!actions.pending||actions.message?.senderId===user.id)} reactions={actions?.message&&actions.message.cryptoState==='decrypted'?<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:2}}>{REACTIONS.map(emoji=>{const chosen=actions.message!.reactions.some(r=>r.mine&&r.emoji===emoji);return <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`Реакция ${emoji}`} accessibilityState={{selected:chosen}} onPress={()=>{react(actions.message!,emoji);setActions(null);}} style={{width:42,height:42,borderRadius:21,alignItems:'center',justifyContent:'center',backgroundColor:chosen?t.accentSoft:'transparent'}}><Text style={{fontSize:21}}>{emoji}</Text></Pressable>;})}</ScrollView>:null}>
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="arrow-undo-outline" label="Ответить" onPress={()=>{setEditing(null);setReplyTo(actions.message!);setActions(null);}}/>:null}
      {(actions?.message?.text||actions?.pending?.text)?<MenuItem icon="copy-outline" label="Скопировать" onPress={()=>void copy(actions?.message?.text||actions?.pending?.text||'')}/>:null}
      {(actions?.message?.attachment||actions?.pending?.attachment)?<MenuItem icon="download-outline" label="Сохранить" onPress={()=>{const a=actions?.message?.attachment||actions?.pending?.attachment;setActions(null);if(a)void download(a);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon={view.pinned?.clientId===actions.message.clientId?'pin':'pin-outline'} label={view.pinned?.clientId===actions.message.clientId?'Открепить':'Закрепить'} onPress={()=>{const m=actions.message!;store.sendAction(chat.id,{type:'pin',target:view.pinned?.clientId===m.clientId?null:m.clientId},m.text);setActions(null);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="arrow-redo-outline" label="Переслать" onPress={()=>{setForwarding(actions.message!);setActions(null);}}/>:null}
      {actions?.message&&actions.message.senderId===user.id&&actions.message.cryptoState==='decrypted'&&actions.message.text?<MenuItem icon="create-outline" label="Изменить" onPress={()=>{setReplyTo(null);setEditing(actions.message!);store.setDraft(chat.id,actions.message!.text);setActions(null);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="bookmark-outline" label="В Избранное" onPress={()=>{const m=actions.message!;setActions(null);saveToFavorites(m);}}/>:null}
      {actions?.pending?.state==='failed'?<MenuItem icon="refresh-outline" label="Повторить отправку" onPress={()=>{if(actions.pending)void store.retry(actions.pending);setActions(null);}}/>:null}
      {actions?.message?<MenuItem icon="eye-off-outline" label="Удалить у меня" description="Сообщение исчезнет только на этом устройстве" danger onPress={()=>{store.hideForMe(actions.message!);setActions(null);}}/>:null}
      {actions?.message&&actions.message.senderId===user.id&&actions.message.cryptoState==='decrypted'?<MenuItem icon="trash-outline" label="Удалить у всех" description="Собеседник перестанет видеть сообщение. Зашифрованная копия на сервере остаётся нечитаемой." danger onPress={()=>{store.sendAction(chat.id,{type:'delete',target:actions.message!.clientId});setActions(null);}}/>:null}
    </ContextMenu>
    <Sheet visible={!!forwarding} title="Переслать в чат" onClose={()=>setForwarding(null)}>
      <SheetAction icon="bookmark-outline" label="Избранное" description="Только на этом устройстве" onPress={()=>{const m=forwarding!;setForwarding(null);saveToFavorites(m);}}/>
      {store.chats.length?store.chats.map(target=><SheetAction key={target.id} icon="chatbubble-outline" label={target.peer.displayName} description={`@${target.peer.username}`} onPress={()=>{const m=forwarding!;setForwarding(null);store.forward(target.id,m,originalAuthor(m)).then(()=>setNotice(`Переслано: ${target.peer.displayName}`)).catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось переслать.'));}}/>):<Text style={{color:t.muted,fontSize:13}}>Пока нет других чатов.</Text>}
    </Sheet>
    <AttachmentViewer api={api} attachment={preview} onClose={()=>setPreview(null)}/>
  </KeyboardSafeView></Animated.View></VoicePlaybackProvider>;
}
