import { takeProfileRequest } from './birthdayNotifications';
import { StatusEmoji } from './StatusEmoji';
import { useMeshActive } from './nearby/meshState';
import { PlatinaGem, PlatinaName, hasPlatina } from './platina/PlatinaMark';
import { DecoratedAvatar } from './platina/Decor';
import { usePowerFeatures } from './motion';
import { ChatWallpaper, WallpaperPicker } from './WallpaperPicker';
import { useWallpaper } from './wallpapers';
import { usePlatina } from './platina/usePlatina';
import { ComposerInput } from './ComposerInput';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { ZoomIn, useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { ProgressRing } from './media/MediaBubble';
import { Text, TextInput } from './typography';
import { KeyboardSafeView } from './keyboard';
import { shareText } from './share';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import type { Api } from './api';
import { AttachmentCard, Avatar, Empty, Icon, IconButton, Notice, RecordHint, Sheet, SheetAction } from './components';
import { formatDay, formatSize, formatTime, useTheme } from './theme';
import { GlassContentTarget, GlassStage, GlassSurface, GlassTargetScope } from './glass';
import { ForwardPicker, type ForwardTarget } from './forward/ForwardPicker';
import { setForwardDraft, useForwardDraft } from './forward/forwardDraft';
import { SharedMedia } from './SharedMedia';
import type { Attachment, Chat, LocalFile, Message, PendingMessage, User } from './types';
import type { MessengerStore } from './useMessenger';
import { LARGE_FILE, localFileSize, shareEncryptedAttachment } from './e2ee/attachments';
import { TrustSheet } from './e2ee/TrustSheet';
import { signalAvailable } from './e2ee/signal';
import { AttachmentPanel } from './attachments/AttachmentPanel';
import { MAX_DRAFT_ATTACHMENTS } from './messageAttachments';
import { mediaPreviewKind } from './media/formats';
import { AttachmentViewer } from './media/AttachmentViewer';
import { openDocument } from './media/documentPreview';
import { WALLPAPERS, textMetrics, useChatPreferences } from './chatPreferences';
import { REACTIONS, foldChat, groupAlbums, replyPreview, type Reaction, type ViewMessage } from './messageMeta';
import { MediaGallery } from './media/AttachmentViewer';
import { PollComposer } from './PollBubble';
import { StickerPanel } from './StickerPanel';
import { Share } from 'react-native';
import { presenceText } from './presence';
import { VoiceMiniPlayer, VoicePlaybackProvider, VoiceRecordingBar, useVoiceRecorder } from './voice/VoiceMessage';
import { RecordButton } from './voice/RecordButton';
import { MessageRow, MissingRow, type AlbumPart, type Row, type RowHandlers } from './MessageRow';
import { ContextMenu, ReadDateRow, MenuItem } from './ContextMenu';
import { navigate } from './navigation';
import { inviteCodeFrom } from './communities/types';
import { inviteForwardable } from './communities/InviteCard';
import { TopPlayerBar } from './music/PlayerControls';
import { useCalls } from './calls/CallProvider';
import { UserProfile } from './UserProfile';
import { MiniProfile } from './MiniProfile';
import { errorFeedback, impactFeedback, lightFeedback } from './haptics';
import { VideoNoteRecorder, type VideoHold, type VideoNoteTake } from './videonote/VideoNote';
import { useCallback } from 'react';
import { attachmentLabel, isVideoNote, isVoice } from './voice/voice';
import { VOICE_MIME, VOICE_MIN_MS, videoNoteFileName, voiceFileName } from './voice/voice';


/** #RRGGBB + alpha → rgba(), for the edge fades. */
const fade=(hex:string,alpha:number)=>{const m=/^#([0-9a-f]{6})$/i.exec(hex);if(!m)return `rgba(0,0,0,${alpha})`;const n=parseInt(m[1],16);return `rgba(${n>>16},${(n>>8)&255},${n&255},${alpha})`;};

export function ChatScreen({api,user,chat,store,onBack,wide=false,onOpenMusic}: {api:Api;user:User;chat:Chat;store:MessengerStore;onBack:()=>void;wide?:boolean;onOpenMusic?:()=>void}) {
  const mesh=useMeshActive();
  const calls=useCalls();const insets=useSafeAreaInsets();const platina=usePlatina(api,user.id);
  // The chat (wallpaper, messages, fade) runs under the system navigation bar — gesture strip or the
  // 3 buttons — like Telegram; the composer alone stays above it, and above the keyboard when open.
  const keyboardMotion=Platform.OS==='web'?null:useReanimatedKeyboardAnimation();
  const navInset=wide?0:insets.bottom;
  const footerInset=useAnimatedStyle(()=>({paddingBottom:navInset*(1-(keyboardMotion?keyboardMotion.progress.value:0))}));
  const powerFeatures=usePowerFeatures();const t=useTheme();const [attachMenu,setAttachMenu]=useState(false);const [uploading,setUploading]=useState(false);const [downloadId,setDownloadId]=useState<string|null>(null);const [localError,setLocalError]=useState('');const [preview,setPreview]=useState<Attachment|null>(null);const [peerInfo,setPeerInfo]=useState(()=>takeProfileRequest(chat.id));const [avatarMenu,setAvatarMenu]=useState(false);const [actions,setActions]=useState<Row|null>(null);const [menuX,setMenuX]=useState<number|undefined>(undefined);const [menuY,setMenuY]=useState(0);const [copied,setCopied]=useState(false);
  const [securityOpen,setSecurityOpen]=useState(false);
  const photoContext=`${user.id}:${chat.id}`;const currentPhotoContext=useRef(photoContext);currentPhotoContext.current=photoContext;
  const text=store.drafts[chat.id]||'';const attachments=store.draftFiles[chat.id]||[];
  const uploadingRef=useRef(false),draftCount=useRef(attachments.length);draftCount.current=attachments.length;
  const glassTarget=useRef<View|null>(null);
  const listRef=useRef<FlatList<Row>>(null);const typingAt=useRef(0);const typingTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);const alive=useRef(true);
  const messages=store.messages[chat.id]||[];
  const pendingAll=store.pending.filter(p=>p.chatId===chat.id);
  // Actions (edit, delete, react, pin) are encrypted messages too; they are applied, not shown.
  const pending=useMemo(()=>pendingAll.filter(p=>!p.meta?.action),[pendingAll]);
  const failedActions=pendingAll.filter(p=>p.meta?.action&&p.state==='failed');
  // Optimistic actions: a reaction, vote, pin, edit or delete shows at once (as in Telegram),
  // while its encrypted message is still on the way; the confirmed copy replaces it.
  const pendingActionKey=pendingAll.filter(p=>p.meta?.action&&p.state==='sending').map(p=>p.clientId).join(',');
  const optimistic=useMemo(()=>pendingAll.filter(p=>p.meta?.action&&p.state==='sending').map((p,index)=>({id:Number.MAX_SAFE_INTEGER-1000+index,chatId:chat.id,senderId:user.id,clientId:p.clientId,text:p.text,attachment:null,createdAt:p.createdAt,cryptoState:'decrypted' as const,meta:p.meta})),[pendingActionKey,chat.id,user.id]);
  // Auto-deleted messages vanish on time: the clock ticks at the next expiry.
  const [expiryClock,setExpiryClock]=useState(()=>Date.now());
  const view=useMemo(()=>foldChat(optimistic.length?[...messages,...optimistic]:messages,user.id,store.hidden,expiryClock),[messages,optimistic,user.id,store.hidden,expiryClock]);
  useEffect(()=>{if(!view.nextExpiry)return;const id=setTimeout(()=>setExpiryClock(Date.now()),Math.min(Math.max(500,view.nextExpiry-Date.now()+100),2147483000));return()=>clearTimeout(id);},[view.nextExpiry]);
  const locked=view.rules.noCopy;
  const [replyTo,setReplyTo]=useState<ViewMessage|null>(null);
  const [editing,setEditing]=useState<ViewMessage|null>(null);
  const [forwarding,setForwarding]=useState<ViewMessage|null>(null);
  const [searchOpen,setSearchOpen]=useState(false);const [query,setQuery]=useState('');
  const [notice,setNotice]=useState('');
  const [selection,setSelection]=useState<Set<string>|null>(null);
  // Desktop: Esc leaves multi-select (as in every desktop messenger).
  useEffect(()=>{if(Platform.OS!=='web'||!selection||typeof window==='undefined')return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setSelection(null);}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[selection]);
  // Rows present when the chat opened do not animate; new ones slide in.
  const seen=useRef<Set<string>|null>(null);
  const [forwardMany,setForwardMany]=useState<ViewMessage[]|null>(null);
  // A banner of a closed channel/server is not forwarded (the owner chose who gets in).
  const forwardable=async(list:ViewMessage[])=>{for(const item of list){const code=item.text?inviteCodeFrom(item.text):null;if(code&&!(await inviteForwardable(api,code))){setNotice('Приглашение в закрытый канал или на закрытый сервер переслать нельзя.');return false;}}return true;};
  const [gallery,setGallery]=useState<{items:Attachment[];index:number}|null>(null);
  const [mediaOpen,setMediaOpen]=useState(false);const [headerHeight,setHeaderHeight]=useState(76);const [footerHeight,setFooterHeight]=useState(60);const [showDown,setShowDown]=useState(false);const [recordMode,setRecordMode]=useState<'voice'|'video'>('voice');
  // Emoji panel <-> keyboard like Telegram: the panel appears first (at keyboard height) and the
  // keyboard goes down under it; back to the keyboard, the panel stays until the keyboard is fully up.
  const [keyboardAsk,setKeyboardAsk]=useState(0);const closeStickersOnKeyboard=useRef(false);
  useEffect(()=>{if(Platform.OS==='web')return;const sub=Keyboard.addListener('keyboardDidShow',()=>{if(closeStickersOnKeyboard.current){closeStickersOnKeyboard.current=false;setStickers(false);}});return()=>sub.remove();},[]);
  const stickersToKeyboard=()=>{closeStickersOnKeyboard.current=true;setTimeout(()=>{if(closeStickersOnKeyboard.current){closeStickersOnKeyboard.current=false;setStickers(false);}},900);};
  const toggleStickers=()=>{
    if(!signalAvailable)return; // a browser cannot send in a 1:1 chat: no emoji into a read-only field
    if(Platform.OS==='web'){setStickers(value=>!value);return;}
    if(!stickers){setStickers(true);requestAnimationFrame(()=>Keyboard.dismiss());return;}
    stickersToKeyboard();setKeyboardAsk(n=>n+1);
  };
  const [mini,setMini]=useState<{x:number;y:number}|null>(null);const [pollOpen,setPollOpen]=useState(false);const [deleteAsk,setDeleteAsk]=useState(false);const [deleteOne,setDeleteOne]=useState<{list:ViewMessage[];everyone:boolean}|null>(null);const [stickers,setStickers]=useState(false);
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
    // A run of messages this device has no key for collapses into one line.
    const folded:Row[]=[];
    for(const row of all){const last=folded[folded.length-1];if(row.message?.cryptoState==='no-key'&&!row.album){if(last?.missing){last.missing++;last.createdAt=row.createdAt;continue;}folded.push({key:`x${row.key}`,createdAt:row.createdAt,missing:1});continue;}folded.push(row);}
    const visible=searchOpen&&needle?folded.filter(row=>!row.missing&&((row.message?.text||row.pending?.text||'').toLocaleLowerCase('ru').includes(needle)||(row.message?.attachment?.name||'').toLocaleLowerCase('ru').includes(needle))):folded;
    return visible.reverse();
  },[view,pending,searchOpen,needle,user.id]);
  const preferences=useChatPreferences();const metrics=textMetrics(preferences.textSize);
  const wallpaper=useWallpaper(chat.id);const [wallpaperOpen,setWallpaperOpen]=useState(false);
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
  // Emoji from the panel go into the text at the cursor, like on the system keyboard (Telegram does the
  // same); a message made only of emoji is still shown large after sending.
  const caret=useRef<{start:number;end:number}|null>(null);// null = end of the text (field not touched yet)
  const caretOf=(value:string)=>caret.current?{start:Math.min(caret.current.start,value.length),end:Math.min(Math.max(caret.current.end,caret.current.start),value.length)}:{start:value.length,end:value.length};const draftNow=useRef(text);draftNow.current=text;
  const insertEmoji=(emoji:string)=>{
    const value=draftNow.current;const {start,end}=caretOf(value);
    const next=value.slice(0,start)+emoji+value.slice(end);if(next.length>8000)return;
    caret.current={start:start+emoji.length,end:start+emoji.length};draftNow.current=next;changeText(next);lightFeedback();
  };
  const eraseBack=()=>{
    const value=draftNow.current;const {start,end}=caretOf(value);
    if(start!==end){caret.current={start,end:start};draftNow.current=value.slice(0,start)+value.slice(end);changeText(draftNow.current);return;}
    if(!start)return;
    const before=value.slice(0,start);const parts=typeof Intl!=='undefined'&&(Intl as any).Segmenter?[...new (Intl as any).Segmenter(undefined,{granularity:'grapheme'}).segment(before)].map((x:any)=>x.segment):Array.from(before);
    const cut=start-(parts[parts.length-1]||'').length;caret.current={start:cut,end:cut};draftNow.current=value.slice(0,cut)+value.slice(start);changeText(draftNow.current);
  };
  const changeText=(value:string)=>{
    store.setDraft(chat.id,value);
    if(Date.now()-typingAt.current>1500){store.sendTyping(chat.id,!!value);typingAt.current=Date.now();}
    if(typingTimer.current)clearTimeout(typingTimer.current);
    typingTimer.current=setTimeout(()=>store.sendTyping(chat.id,false),1800);
  };
  const forwardDraft=useForwardDraft(chat.id);
  const sendForward=()=>{const draft=forwardDraft;if(!draft)return false;setForwardDraft(null);const comment=text.trim();
    if(comment)store.send(chat.id,comment,null);void (async()=>{for(const item of draft.items)await store.forward(chat.id,item.message,item.author);})().catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось переслать.'));
    store.setDraft(chat.id,'');store.sendTyping(chat.id,false);listRef.current?.scrollToOffset({offset:0,animated:true});return true;};
  const send=()=>{
    if(forwardDraft&&!editing){lightFeedback();sendForward();return;}
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
    // A big file goes out at once as a bubble with progress (Telegram-like); small files wait in the draft.
    if(localFileSize(file)>LARGE_FILE){store.sendLargeFile(chat.id,{...file,size:localFileSize(file)});listRef.current?.scrollToOffset({offset:0,animated:true});return;}
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
    if(take.durationMs<VOICE_MIN_MS){errorFeedback();await FileSystem.deleteAsync(take.uri,{idempotent:true}).catch(()=>{});setNotice('Слишком короткое голосовое — держи запись хотя бы секунду.');return;}
    const chatId=chat.id,reply=replyTo?{clientId:replyTo.clientId,senderId:replyTo.senderId,preview:replyPreview(replyTo)}:undefined;
    uploadingRef.current=true;setUploading(true);setLocalError('');
    try{
      const name=voiceFileName();
      const uploaded=await store.uploadEncrypted({uri:take.uri,name,mimeType:VOICE_MIME});
      store.send(chatId,'',{...uploaded,name,mimeType:VOICE_MIME,media:{durationMs:Math.round(take.durationMs),...(take.waveform?{waveform:take.waveform}:{})}},reply?{reply}:undefined);
      if(reply)setReplyTo(null);
      listRef.current?.scrollToOffset({offset:0,animated:true});
    }catch(e){if(alive.current)setLocalError(e instanceof Error?e.message:'Не удалось отправить голосовое.');}
    finally{uploadingRef.current=false;if(alive.current)setUploading(false);await FileSystem.deleteAsync(take.uri,{idempotent:true}).catch(()=>{});}
  };
  const voice=useVoiceRecorder(()=>void finishVoice(true));
  const startVoice=(onFail?:()=>void)=>{impactFeedback();Keyboard.dismiss();setLocalError('');voice.start().catch(e=>{onFail?.();setLocalError(e instanceof Error?e.message:'Не удалось начать запись.');});};
  // Telegram's hold-to-record: hold the button, slide left to cancel, up to lock, release to send.
  const [recHold,setRecHold]=useState<{kind:'voice'|'video';locked:boolean}|null>(null);
  const [cancelProgress,setCancelProgress]=useState(0);
  const [videoHold,setVideoHold]=useState<VideoHold|null>(null);
  // Telegram: a tap on the record button shows the hint right in the input field, not as a toast.
  const [recordHint,setRecordHint]=useState('');const recordHintTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const toggleRecordMode=()=>{lightFeedback();voice.unprepare();const next=recordModeRef.current==='voice'?'video':'voice';recordModeRef.current=next;setRecordMode(next);setRecordHint(next==='video'?'Видео — удерживайте. Звук — нажмите.':'Звук — удерживайте. Видео — нажмите.');if(recordHintTimer.current)clearTimeout(recordHintTimer.current);recordHintTimer.current=setTimeout(()=>setRecordHint(''),2200);};
  // Latest values for the hold handlers (gesture callbacks can outlive the render they came from).
  const recordModeRef=useRef(recordMode);recordModeRef.current=recordMode;
  const recHoldRef=useRef(recHold);recHoldRef.current=recHold;
  const holdStart=()=>{setNotice('');setStickers(false);
    if(recordModeRef.current==='voice'){setRecHold({kind:'voice',locked:false});startVoice(()=>setRecHold(null));}
    else{Keyboard.dismiss();setLocalError('');setVideoHold({stop:0,cancel:0,locked:false});setCircleOpen(true);setRecHold({kind:'video',locked:false});}};
  const holdEnd=(result:'send'|'cancel')=>{const kind=recHoldRef.current?.kind??recordModeRef.current;setRecHold(null);setCancelProgress(0);
    if(kind==='voice')void finishVoice(result==='send');
    else setVideoHold(v=>v?{...v,stop:v.stop+(result==='send'?1:0),cancel:v.cancel+(result==='cancel'?1:0)}:v);};
  const holdLock=()=>{setCancelProgress(0);setRecHold(h=>h?{...h,locked:true}:h);setVideoHold(v=>v?{...v,locked:true}:v);};
  const canSend=!!text.trim()||attachments.length>0||!!editing||!!forwardDraft;
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
    if(store.connection!=='connected'&&mesh)return {text:'Mesh · без интернета',accent:true};
    if(store.connection==='connecting')return {text:'соединение…',accent:false};
    if(store.connection==='offline')return {text:'ожидание сети…',accent:false};
    if(isTyping)return {text:'печатает…',accent:true};
    const text=presenceText(store.presence[chat.peer.id]);
    return text?{text,accent:text==='в сети'}:{text:`@${chat.peer.username}`,accent:false};
  },[store.connection,isTyping,store.presence,chat.peer.id,chat.peer.username,clock,mesh]);
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
      else if(text){if(await shareText(text)==='copied')setNotice('Текст скопирован — вставь его, куда нужно.');}
      else if(files.length)await download(files[0]);
    }catch(e){setLocalError(e instanceof Error?e.message:'Не удалось поделиться.');}
  };
  const deleteSelected=(everyone:boolean)=>{
    for(const m of selectedMessages){if(everyone&&m.senderId===user.id)store.sendAction(chat.id,{type:'delete',target:m.clientId});else store.hideForMe(m);}
    setSelection(null);lightFeedback();
  };

  const handlers=useRef<RowHandlers>(null as unknown as RowHandlers);
  handlers.current={actions:(row,y,x)=>{setMenuY(y);setMenuX(x);setActions(row);},jumpTo,open:openAttachment,react,retry:pending=>void store.retry(pending),cancel:pending=>store.cancelPending(pending),reply:message=>{setEditing(null);setReplyTo(message);},vote:(message,options)=>store.sendAction(chat.id,{type:'vote',target:message.clientId,options},replyPreview(message)),toggleSelect};
  if(seen.current===null&&rows.length)seen.current=new Set(rows.map(row=>row.key));
  const fresh=(key:string)=>{if(!seen.current)return false;if(seen.current.has(key))return false;seen.current.add(key);return true;};
  const peerLastRead=chat.peerLastReadMessageId,peerName=chat.peer.displayName;
  const renderRow=useCallback(({item,index}:{item:Row;index:number})=>{
    const message=item.message,p=item.pending,mine=!!p||message?.senderId===user.id;
    const file=message?.attachment||p?.attachment,reply=message?.meta?.reply||p?.meta?.reply;
    const original=reply?view.byClientId.get(reply.clientId):undefined;
    // Telegram groups consecutive messages of one author: 2 pt apart, the tail only on the last one.
    const newer=index>0?rows[index-1]:undefined;
    const newerSender=newer?.pending?user.id:newer?.message?.senderId;
    const groupNext=!!newer&&newerSender===(p?user.id:message?.senderId)&&new Date(newer.createdAt).toDateString()===new Date(item.createdAt).toDateString()&&Date.parse(newer.createdAt)-Date.parse(item.createdAt)<5*60_000;
    if(item.missing)return <MissingRow count={item.missing}/>;
    return <MessageRow animatedEmoji={platina&&powerFeatures.stickers} groupNext={groupNext} row={item} selecting={!!selection} selected={!!selection?.has(item.key)} fresh={fresh(item.key)} olderCreatedAt={rows[index+1]?.createdAt} mine={mine} author={mine?'Ты':peerName} peerLastRead={peerLastRead} wide={wide} fontSize={metrics.fontSize} lineHeight={metrics.lineHeight} radius={preferences.bubbleRadius} downloading={!!downloadId&&file?.id===downloadId} replyAuthor={reply?(reply.senderId===user.id?'Ты':peerName):undefined} replyText={reply?(original?replyPreview(original):reply.preview||'Сообщение удалено'):undefined} api={api} handlers={handlers}/>;
  },[rows,user.id,peerName,peerLastRead,wide,metrics,downloadId,view.byClientId,api,selection,preferences.bubbleRadius,platina]);
  const [circleOpen,setCircleOpen]=useState(false);
  // Telegram: the sent circle appears in the chat at once (frame from the take, upload ring, ✕).
  // Uploads cannot be aborted, so ✕ means «do not send» once the upload ends.
  const [pendingNote,setPendingNote]=useState<{thumb?:string;progress:number}|null>(null);const noteCancelled=useRef(false);
  const sendVideoNote=async(take:VideoNoteTake)=>{
    setCircleOpen(false);noteCancelled.current=false;setPendingNote({progress:0});
    void VideoThumbnails.getThumbnailAsync(take.uri,{time:0,quality:.6}).then(frame=>setPendingNote(p=>p?{...p,thumb:frame.uri}:p)).catch(()=>{});
    const chatId=chat.id,reply=replyTo?{clientId:replyTo.clientId,senderId:replyTo.senderId,preview:replyPreview(replyTo)}:undefined;
    uploadingRef.current=true;setUploading(true);setLocalError('');
    try{
      const name=videoNoteFileName();
      const uploaded=await store.uploadEncrypted({uri:take.uri,name:'video.mp4',mimeType:'video/mp4'},(sent,total)=>{if(total>0)setPendingNote(p=>p?{...p,progress:sent/total}:p);});
      if(noteCancelled.current)return;
      store.send(chatId,'',{...uploaded,name,mimeType:'video/mp4',media:{...(uploaded.media||{}),durationMs:uploaded.media?.durationMs||Math.round(take.durationMs)}},reply?{reply}:undefined);
      if(reply)setReplyTo(null);
      listRef.current?.scrollToOffset({offset:0,animated:true});
    }catch(e){if(alive.current)setLocalError(e instanceof Error?e.message:'Не удалось отправить видеосообщение.');}
    finally{if(alive.current)setPendingNote(null);uploadingRef.current=false;if(alive.current)setUploading(false);await FileSystem.deleteAsync(take.uri,{idempotent:true}).catch(()=>{});}
  };
  // Telegram: messages scroll under the status bar (no hard edge at the safe area); the header sits below it.
  // Edge fades take the wallpaper's own colour (top / bottom of the gradient), so they never show as a
  // light band over a dark wallpaper; a photo wallpaper gets a soft dark fade.
  const preset=wallpaper.kind==='preset'?WALLPAPERS.find(item=>item.id===wallpaper.id)?.colors:null;
  const edge=preset?{top:preset[0],bottom:preset[preset.length-1],alpha:.9}:wallpaper.kind==='image'?{top:'#000000',bottom:'#000000',alpha:.5}:{top:t.bg,bottom:t.bg,alpha:.96};
  // Desktop (Telegram Desktop / Discord): a full-width bar — who, status, and the actions at hand.
  // Desktop: drop or paste files into the chat; keyboard as in Telegram Desktop / Discord.
  const [dropping,setDropping]=useState(false);
  const desktopRef=useRef({upload,text,editing,replyTo,searchOpen,messages:view.messages});desktopRef.current={upload,text,editing,replyTo,searchOpen,messages:view.messages};
  useEffect(()=>{
    if(Platform.OS!=='web'||!wide||typeof window==='undefined')return;
    const take=async(files:File[])=>{for(const file of files){try{await desktopRef.current.upload({uri:URL.createObjectURL(file),name:file.name||'файл',mimeType:file.type||'application/octet-stream',size:file.size,file});}catch(e){setLocalError(e instanceof Error?e.message:'Не удалось добавить файл.');break;}}};
    let depth=0;
    const hasFiles=(e:DragEvent)=>!!e.dataTransfer&&Array.from(e.dataTransfer.types||[]).includes('Files');
    const enter=(e:DragEvent)=>{if(!hasFiles(e))return;e.preventDefault();depth++;setDropping(true);};
    const over=(e:DragEvent)=>{if(hasFiles(e))e.preventDefault();};
    const leave=(e:DragEvent)=>{if(!hasFiles(e))return;depth=Math.max(0,depth-1);if(!depth)setDropping(false);};
    const drop=(e:DragEvent)=>{if(!hasFiles(e))return;e.preventDefault();depth=0;setDropping(false);void take(Array.from(e.dataTransfer!.files));};
    const paste=(e:ClipboardEvent)=>{const files=Array.from(e.clipboardData?.files||[]);if(!files.length)return;e.preventDefault();void take(files);};
    const key=(e:KeyboardEvent)=>{
      const d=desktopRef.current;const mod=e.ctrlKey||e.metaKey;
      if(mod&&!e.shiftKey&&(e.key==='f'||e.key==='F'||e.key==='а'||e.key==='А')){e.preventDefault();setSearchOpen(true);return;}
      if(e.key==='Escape'){if(d.searchOpen){setSearchOpen(false);setQuery('');return;}if(d.editing){setEditing(null);store.setDraft(chat.id,'');return;}if(d.replyTo){setReplyTo(null);return;}}
      // ↑ in an empty field edits your last message.
      if(e.key==='ArrowUp'&&!mod&&!e.altKey&&!d.text&&!d.editing){const target=e.target as HTMLElement|null;if(target?.tagName!=='TEXTAREA'&&target?.tagName!=='INPUT')return;
        const last=[...d.messages].reverse().find(m=>m.senderId===user.id&&m.cryptoState==='decrypted'&&!!m.text&&!m.meta?.poll);if(!last)return;e.preventDefault();setReplyTo(null);setEditing(last);store.setDraft(chat.id,last.text);}
    };
    window.addEventListener('dragenter',enter);window.addEventListener('dragover',over);window.addEventListener('dragleave',leave);window.addEventListener('drop',drop);window.addEventListener('paste',paste);window.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('dragenter',enter);window.removeEventListener('dragover',over);window.removeEventListener('dragleave',leave);window.removeEventListener('drop',drop);window.removeEventListener('paste',paste);window.removeEventListener('keydown',key,true);};
  },[wide,chat.id,user.id]);
  const desktopHeader=()=>{const hover=(state:{pressed:boolean})=>{const h=(state as {hovered?:boolean}).hovered;return {width:40,height:40,borderRadius:12,alignItems:'center' as const,justifyContent:'center' as const,backgroundColor:h?(t.dark?'rgba(255,255,255,0.08)':'rgba(0,0,0,0.05)'):'transparent',opacity:state.pressed?.6:1};};
    return <View style={{height:60,marginTop:-8,flexDirection:'row',alignItems:'center',gap:12,paddingHorizontal:16,backgroundColor:t.glassOpaque,borderBottomWidth:1,borderColor:t.border}}>
      <Pressable onPress={()=>setPeerInfo(true)} accessibilityRole="button" accessibilityLabel={`Полный профиль ${chat.peer.displayName}`}><DecoratedAvatar user={chat.peer} api={api} size={40} animated/></Pressable>
      <Pressable onPress={(e:any)=>setMini({x:e.nativeEvent.pageX,y:e.nativeEvent.pageY})} accessibilityRole="button" style={{flex:1,minWidth:0,gap:2}}>
        <View style={{flexDirection:'row',gap:6,alignItems:'center'}}><PlatinaName user={chat.peer} numberOfLines={1} style={{flexShrink:1,color:t.text,fontSize:16,fontWeight:'700',letterSpacing:-.2}}/><StatusEmoji user={chat.peer} size={16} animated/></View>
        <Text numberOfLines={1} style={{color:headerStatus.accent?t.accent:t.muted,fontSize:12.5}}>{headerStatus.text}</Text>
      </Pressable>
      <Pressable onPress={()=>{setSearchOpen(open=>!open);setQuery('');}} accessibilityRole="button" accessibilityLabel="Поиск в этом чате (Ctrl+F)" style={hover}><Icon name="search-outline" size={20} color={searchOpen?t.accent:t.muted}/></Pressable>
      {calls.available?<Pressable onPress={()=>calls.start(chat,false)} accessibilityRole="button" accessibilityLabel="Позвонить" style={hover}><Icon name="call-outline" size={20} color={t.muted}/></Pressable>:null}
      {calls.available?<Pressable onPress={()=>calls.start(chat,true)} accessibilityRole="button" accessibilityLabel="Видеозвонок" style={hover}><Icon name="videocam-outline" size={21} color={t.muted}/></Pressable>:null}
      <Pressable onPress={()=>setMediaOpen(true)} accessibilityRole="button" accessibilityLabel="Медиа и файлы чата" style={hover}><Icon name="images-outline" size={20} color={t.muted}/></Pressable>
      <Pressable onPress={()=>setPeerInfo(true)} accessibilityRole="button" accessibilityLabel="Информация" style={hover}><Icon name="information-circle-outline" size={22} color={t.muted}/></Pressable>
    </View>;};

  return <VoicePlaybackProvider api={api}><GlassTargetScope targetRef={glassTarget}><KeyboardSafeView style={{flex:1,backgroundColor:'transparent',marginTop:wide?0:-insets.top,marginBottom:wide?0:-insets.bottom}}><View style={{flex:1}}>
    {/* Android: header and composer glass blur this (wallpaper + messages) on the GPU. */}
    <GlassContentTarget targetRef={glassTarget} style={{flex:1}}>
    <ChatWallpaper choice={wallpaper} style={{top:-80,bottom:-60}}/>
    {rows.length===0?<View style={{flex:1,justifyContent:'center',paddingTop:headerHeight,paddingBottom:footerHeight}}>{store.messageLoading?<ActivityIndicator color={t.accent}/>:<Empty icon="hand-left-outline" title="Скажи «привет»" description={`Это начало вашей переписки с ${chat.peer.displayName}.`}/>}</View>:<FlatList ref={listRef} inverted data={rows} keyExtractor={row=>row.key} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS==='ios'?'interactive':'on-drag'} contentContainerStyle={{paddingHorizontal:wide?28:9,paddingTop:footerHeight+8,paddingBottom:headerHeight+14}} onScroll={e=>{const down=e.nativeEvent.contentOffset.y>350;if(down!==showDown)setShowDown(down);}} scrollEventThrottle={100} initialNumToRender={25} windowSize={11} onScrollToIndexFailed={info=>{listRef.current?.scrollToOffset({offset:info.averageItemLength*info.index,animated:true});setTimeout(()=>listRef.current?.scrollToIndex({index:info.index,animated:true,viewPosition:.5}),250);}}
      ListHeaderComponent={pendingNote?<Animated.View entering={ZoomIn.springify().damping(16)} style={{alignSelf:'flex-end',marginVertical:6,width:212,height:212,borderRadius:106,overflow:'hidden',backgroundColor:'#11162A',alignItems:'center',justifyContent:'center'}}>
        {pendingNote.thumb?<Image source={{uri:pendingNote.thumb}} style={StyleSheet.absoluteFill} resizeMode="cover"/>:null}
        <View style={{width:56,height:56,borderRadius:28,backgroundColor:'rgba(10,20,35,0.6)',alignItems:'center',justifyContent:'center'}}><ProgressRing progress={pendingNote.progress} size={56}/><Pressable accessibilityRole="button" accessibilityLabel="Не отправлять видеосообщение" onPress={()=>{noteCancelled.current=true;setPendingNote(null);}} hitSlop={8}><Icon name="close" size={24} color="#FFF"/></Pressable></View>
      </Animated.View>:null}
      ListFooterComponent={store.hasMore[chat.id]?<View style={{alignItems:'center',padding:18}}><GlassSurface material="clear" radius={19} shadow={false}><Pressable onPress={()=>void store.loadMessages(chat.id,true)} disabled={store.messageLoading} accessibilityRole="button" style={{paddingVertical:11,paddingHorizontal:17}}>{store.messageLoading?<ActivityIndicator size="small" color={t.accent}/>:<Text style={{fontSize:12,color:t.accent,fontWeight:'600'}}>Более ранние сообщения</Text>}</Pressable></GlassSurface></View>:null}
      renderItem={renderRow} removeClippedSubviews={Platform.OS==='android'} maxToRenderPerBatch={12} updateCellsBatchingPeriod={40}/>
    }
    </GlassContentTarget>
    {/* Like Telegram: messages fade out under the status bar + header and under the composer
        instead of showing through sharp-edged behind the clock and the input field. */}
    {headerHeight?<LinearGradient pointerEvents="none" colors={[fade(edge.top,edge.alpha),fade(edge.top,edge.alpha*.85),fade(edge.top,0)]} locations={[0,.55,1]} style={{position:'absolute',top:0,left:0,right:0,height:headerHeight+22,zIndex:4}}/>:null}
    {footerHeight?<LinearGradient pointerEvents="none" colors={[fade(edge.bottom,0),fade(edge.bottom,edge.alpha*.85),fade(edge.bottom,edge.alpha)]} locations={[0,.45,1]} style={{position:'absolute',bottom:0,left:0,right:0,height:footerHeight+22,zIndex:3}}/>:null}
    <VoiceMiniPlayer top={headerHeight+4} find={id=>{const m=view.messages.find(x=>x.attachment?.id===id);return m&&m.attachment?{author:originalAuthor(m),attachment:m.attachment}:null;}}/>
    <View pointerEvents="box-none" onLayout={e=>setHeaderHeight(e.nativeEvent.layout.height)} style={{position:'absolute',top:0,left:0,right:0,zIndex:5,paddingTop:8+(wide?0:insets.top),gap:6}}>
    {selection?<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12}}>
      <GlassSurface material="regular" radius={24} interactive contentStyle={{height:48,justifyContent:'center',paddingHorizontal:16}}><Pressable onPress={()=>setSelection(null)} accessibilityRole="button" hitSlop={8}><Text style={{color:t.accent,fontSize:16,fontWeight:'600'}}>Отмена</Text></Pressable></GlassSurface>
      <View style={{flex:1,alignItems:'center'}}><GlassSurface material="regular" radius={24} contentStyle={{height:48,justifyContent:'center',paddingHorizontal:18}}><Text style={{color:t.text,fontSize:16,fontWeight:'700'}}>Выбрано: {selectedMessages.length}</Text></GlassSurface></View>
      <GlassSurface material="regular" radius={24} interactive contentStyle={{height:48,width:48,alignItems:'center',justifyContent:'center'}}><Pressable onPress={()=>void copy(selectedMessages.map(m=>m.meta?.poll?replyPreview(m):m.text).filter(Boolean).join('\n\n')).then(()=>setSelection(null))} disabled={!selectedMessages.some(m=>m.text)} accessibilityRole="button" accessibilityLabel="Скопировать выбранные" style={{opacity:selectedMessages.some(m=>m.text)?1:.4}}><Icon name="copy-outline" size={21} color={t.accent}/></Pressable></GlassSurface>
    </View>:wide?desktopHeader():<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12}}>
      {/* Telegram: the name sits exactly in the middle of the screen — equal side columns, not «what is left». */}
      <View style={{flex:1,alignItems:'flex-start'}}>{!wide?<GlassSurface material="regular" radius={26} interactive style={{height:44,maxHeight:44,flexGrow:0,flexShrink:0}} contentStyle={{height:44,maxHeight:44,flexGrow:0,flexShrink:0,minWidth:44,flexDirection:'row',alignItems:'center',justifyContent:'center',paddingHorizontal:otherUnread?10:0,gap:4}}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={`Назад к чатам${otherUnread?`, непрочитанных ${otherUnread}`:''}`} hitSlop={6} style={{flexDirection:'row',alignItems:'center',gap:4}}><Icon name="chevron-back" size={26} color={t.text}/>{otherUnread?<View style={{minWidth:22,height:22,borderRadius:11,paddingHorizontal:6,backgroundColor:t.text,alignItems:'center',justifyContent:'center'}}><Text style={{color:t.dark?'#000':'#FFF',fontSize:12,fontWeight:'700'}}>{otherUnread>99?'99+':otherUnread}</Text></View>:null}</Pressable></GlassSurface>:null}</View>
      {/* As in Telegram: the name in the middle, the avatar on the right; both open the full profile
          (calls, media, «Ещё» with no-copy, auto-delete, block). */}
      <View style={{maxWidth:'62%',alignItems:'center'}}>
        <GlassSurface material="regular" radius={22} interactive style={{maxWidth:'100%',height:44,maxHeight:44,flexGrow:0,flexShrink:0,minWidth:0}} contentStyle={{maxWidth:'100%',height:44,maxHeight:44,flexGrow:0,flexShrink:0,minWidth:0,justifyContent:'center',paddingHorizontal:18,paddingVertical:0}}>
          <Pressable onPress={()=>{Keyboard.dismiss();setPeerInfo(true);}} accessibilityRole="button" accessibilityLabel={`Профиль ${chat.peer.displayName}`} style={{alignItems:'center',maxWidth:'100%'}}>
            <View style={{flexShrink:1,alignItems:'center',gap:1,maxWidth:'100%'}}>
            <View style={{flexDirection:'row',gap:5,alignItems:'center',maxWidth:'100%'}}><PlatinaName user={chat.peer} style={{flexShrink:1,color:t.text,fontSize:16,lineHeight:19,includeFontPadding:false,fontWeight:'600',letterSpacing:-.25}}/><StatusEmoji user={chat.peer} size={16} animated/></View>
            <Text numberOfLines={1} style={{color:headerStatus.accent?t.accent:t.muted,fontSize:12,lineHeight:15,includeFontPadding:false}}>{headerStatus.text}</Text>
            </View>
          </Pressable>
        </GlassSurface>
      </View>
      <View style={{flex:1,alignItems:'flex-end'}}>
        <Pressable onPress={()=>{Keyboard.dismiss();setPeerInfo(true);}} onLongPress={()=>{Keyboard.dismiss();impactFeedback();setAvatarMenu(true);}} delayLongPress={350} accessibilityRole="button" accessibilityLabel={`Полный профиль ${chat.peer.displayName}`} hitSlop={4} style={({pressed})=>({opacity:pressed?.75:1})}><DecoratedAvatar user={chat.peer} api={api} size={44} animated/></Pressable>
      </View>
    </View>}
    {onOpenMusic&&!selection?<TopPlayerBar onOpen={onOpenMusic}/>:null}
    {searchOpen?<GlassSurface lens material="regular" radius={22} shadow={false} style={{marginHorizontal:12}} contentStyle={{flexDirection:'row',alignItems:'center',gap:9,paddingHorizontal:14,minHeight:46}}>
      <Icon name="search-outline" size={18} color={t.muted}/>
      <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Поиск в этом чате" placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} accessibilityLabel="Поиск в этом чате" style={{flex:1,color:t.text,fontSize:15,paddingVertical:10}}/>
      {needle?<Text style={{color:t.muted,fontSize:11}}>{rows.length?`Найдено: ${rows.length}`:'Ничего'}</Text>:null}
      <IconButton name="close" label="Закрыть поиск" size={18} color={t.muted} onPress={()=>{setSearchOpen(false);setQuery('');}} style={{width:34,height:38}}/>
    </GlassSurface>:null}
    {/* Telegram's pinned bar: a tall glass pill, a thin light line on the left, «Закреплённое сообщение»
        in regular weight over the grey preview, and a plain icon (no circle) on the right to unpin. */}
    {view.pinned&&!searchOpen?<GlassSurface lens material="regular" radius={26} shadow={false} style={{marginHorizontal:12,marginTop:6}} contentStyle={{flexDirection:'row',alignItems:'center',paddingLeft:16,paddingRight:6,minHeight:56}}>
      <Pressable accessibilityRole="button" accessibilityLabel="Перейти к закреплённому сообщению" onPress={()=>jumpTo(view.pinned!.clientId)} style={{flex:1,flexDirection:'row',alignItems:'center',gap:12}}>
        <View style={{width:2.5,height:34,borderRadius:2,backgroundColor:t.text,opacity:.9}}/>
        <View style={{flex:1,gap:1,paddingVertical:8}}><Text numberOfLines={1} style={{color:t.text,fontSize:15,fontWeight:'500'}}>Закреплённое сообщение</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:15}}>{replyPreview(view.pinned)||'Вложение'}</Text></View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Открепить" hitSlop={8} onPress={()=>store.sendAction(chat.id,{type:'pin',target:null})} style={({pressed})=>({width:44,height:44,alignItems:'center',justifyContent:'center',opacity:pressed?.5:1})}><Icon name="close" size={22} color={t.muted}/></Pressable>
    </GlassSurface>:null}
    </View>
    {/* Notices sit in their own layer under the header: when they lived inside the header container
        and appeared, iOS 26 glass buttons of the header stretched to the container's new height. */}
    <View pointerEvents="box-none" style={{position:'absolute',top:headerHeight,left:0,right:0,zIndex:5}}>
    {notice?<Pressable onPress={()=>setNotice('')} style={{alignSelf:'center',marginVertical:4,paddingVertical:7,paddingHorizontal:14,backgroundColor:t.accentSoft,borderRadius:16,borderWidth:1,borderColor:t.border}}><Text style={{color:t.accent,fontSize:12}}>{notice}</Text></Pressable>:null}
    {failedActions.length?<Pressable onPress={()=>failedActions.forEach(item=>void store.retry(item))} style={{alignSelf:'center',marginVertical:4,paddingVertical:7,paddingHorizontal:14,borderRadius:16,borderWidth:1,borderColor:t.danger}}><Text style={{color:t.danger,fontSize:12}}>Действие не отправлено · повторить</Text></Pressable>:null}
    {store.cryptoError?<View style={{paddingHorizontal:13,paddingBottom:8}}><Notice text={store.cryptoError} error onRetry={()=>/устройств/i.test(store.cryptoError)&&/Безопасность/.test(store.cryptoError)?navigate({to:'security'}):setSecurityOpen(true)} actionLabel={/Безопасность/.test(store.cryptoError)?'Устройства':'Сверить коды'}/></View>:null}
    {store.error||localError?<View style={{paddingHorizontal:13,paddingVertical:8}}><Notice text={localError||store.error} error onRetry={()=>{setLocalError('');void store.loadMessages(chat.id);}}/></View>:null}
    {copied?<View style={{alignSelf:'center',marginTop:6,paddingVertical:7,paddingHorizontal:14,backgroundColor:t.accentSoft,borderRadius:16,borderWidth:1,borderColor:t.border}}><Text style={{color:t.accent,fontSize:12}}>Скопировано</Text></View>:null}
    </View>
    {/* Like Telegram: the composer floats over the messages, which scroll underneath it. */}
    <Animated.View pointerEvents="box-none" onLayout={e=>setFooterHeight(e.nativeEvent.layout.height)} style={[{position:'absolute',left:0,right:0,bottom:0,zIndex:4},footerInset]}>
    {showDown&&!selection?<View pointerEvents="box-none" style={{height:0}}><View style={{position:'absolute',right:14,bottom:10}}><GlassSurface material="regular" radius={20} interactive contentStyle={{width:40,height:40,alignItems:'center',justifyContent:'center'}}><Pressable onPress={()=>{lightFeedback();listRef.current?.scrollToOffset({offset:0,animated:true});}} accessibilityRole="button" accessibilityLabel="Вниз к новым сообщениям" hitSlop={6}><Icon name="chevron-down" size={26} color={t.text}/></Pressable></GlassSurface></View></View>:null}
    {selection?<GlassSurface lens material="regular" radius={28} style={{marginHorizontal:12,marginTop:5,marginBottom:10}} contentStyle={{flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingVertical:8}}>
      {([
        {icon:'arrow-redo-outline',label:'Переслать',on:()=>{const list=selectedMessages;void forwardable(list).then(ok=>{if(ok)setForwardMany(list);});},ok:selectedMessages.length>0},
        {icon:'share-outline',label:'Поделиться',on:()=>{void shareMessages(selectedMessages);setSelection(null);},ok:selectedMessages.length>0},
        {icon:'bookmark-outline',label:'В Избранное',on:()=>{selectedMessages.forEach(saveToFavorites);setSelection(null);},ok:selectedMessages.length>0},
        {icon:'trash-outline',label:'Удалить',on:()=>setDeleteAsk(true),ok:selectedMessages.length>0,danger:true},
      ] as const).map(item=><Pressable key={item.label} disabled={!item.ok} onPress={()=>{lightFeedback();item.on();}} accessibilityRole="button" style={({pressed})=>({alignItems:'center',gap:4,paddingHorizontal:8,paddingVertical:4,opacity:!item.ok?.35:pressed?.6:1})}><Icon name={item.icon} size={22} color={'danger' in item?t.danger:t.accent}/><Text style={{fontSize:10,color:'danger' in item?t.danger:t.accent,fontWeight:'600'}}>{item.label}</Text></Pressable>)}
    </GlassSurface>:<View style={{marginHorizontal:wide?20:8,marginTop:4,marginBottom:8,gap:6}}>
      {replyTo||editing||uploading||attachments.length||forwardDraft?<GlassSurface lens material="regular" radius={22} contentStyle={{paddingHorizontal:8,paddingTop:8,paddingBottom:2}}>
      {forwardDraft&&!editing?<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingLeft:8,paddingBottom:6}}>
        <Icon name="arrow-redo-outline" size={18} color={t.accent}/>
        <View style={{width:3,alignSelf:'stretch',borderRadius:2,backgroundColor:t.accent}}/>
        <View style={{flex:1,gap:1}}><Text style={{color:t.accent,fontSize:11,fontWeight:'700'}}>{forwardDraft.items.length>1?`Переслать ${forwardDraft.items.length} ${forwardDraft.items.length<5?'сообщения':'сообщений'}`:'Переслать сообщение'}</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>{`${forwardDraft.items[0]?.author||''}: ${forwardDraft.items[0]?.message.text||(forwardDraft.items[0]?.message.attachment?attachmentLabel(forwardDraft.items[0].message.attachment):'')}`}</Text></View>
        <IconButton name="close" label="Не пересылать" size={18} color={t.muted} onPress={()=>setForwardDraft(null)} style={{width:36,height:36}}/>
      </View>:null}
      {replyTo||editing?<View style={{flexDirection:'row',alignItems:'center',gap:8,paddingLeft:8,paddingBottom:6}}>
        <Icon name={editing?'create-outline':'arrow-undo-outline'} size={18} color={t.accent}/>
        <View style={{width:3,alignSelf:'stretch',borderRadius:2,backgroundColor:t.accent}}/>
        <View style={{flex:1,gap:1}}><Text style={{color:t.accent,fontSize:11,fontWeight:'700'}}>{editing?'Редактирование':`Ответ ${nameOf((replyTo as ViewMessage).senderId)==='Ты'?'себе':nameOf((replyTo as ViewMessage).senderId)}`}</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>{replyPreview((editing||replyTo)!)}</Text></View>
        <IconButton name="close" label={editing?'Отменить редактирование':'Отменить ответ'} size={18} color={t.muted} onPress={()=>{if(editing)store.setDraft(chat.id,'');setEditing(null);setReplyTo(null);}} style={{width:36,height:36}}/>
      </View>:null}
      {uploading&&!pendingNote?<View style={{flexDirection:'row',alignItems:'center',gap:9,padding:12,paddingTop:4}}><ActivityIndicator size="small" color={t.accent}/><Text style={{fontSize:12,color:t.muted}}>Обрабатываем и шифруем вложение…</Text></View>:null}
      {attachments.length?<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:7,paddingBottom:7}}>{attachments.map((attachment,index)=>{
        const kind=mediaPreviewKind(attachment);
        return <View key={attachment.id} style={{width:230,flexDirection:'row',alignItems:'center',gap:8,padding:10,borderRadius:19,backgroundColor:t.accentSoft,borderWidth:1,borderColor:t.border}}><Icon name={kind==='photo'?'image-outline':kind==='video'?'videocam-outline':kind==='audio'?'musical-note-outline':'document-outline'} color={t.accent} size={21}/><View style={{flex:1,gap:3}}><Text numberOfLines={1} style={{color:t.text,fontSize:12,fontWeight:'600'}}>{attachment.name}</Text><Text style={{color:t.muted,fontSize:10}}>{index+1} · {formatSize(attachment.size)}</Text></View><IconButton name="close" label={`Убрать ${attachment.name}`} onPress={()=>{store.removeDraftFile(chat.id,attachment.id);draftCount.current=Math.max(0,draftCount.current-1);}} disabled={uploading} size={18} style={{width:30,height:32}}/></View>;
      })}</ScrollView>:null}
      </GlassSurface>:null}
      {voice.active&&!(recHold?.kind==='voice'&&!recHold.locked)?<VoiceRecordingBar floating durationMs={voice.durationMs} levels={voice.levels} paused={voice.paused} onPause={voice.togglePause} onCancel={()=>{setRecHold(null);void finishVoice(false);}} onSend={()=>{setRecHold(null);void finishVoice(true);}}/>:<View style={{flexDirection:'row',gap:8,alignItems:'flex-end'}}>
        <RecordHint text={recordHint}/>
        {recHold?.kind==='voice'&&!recHold.locked?<GlassSurface key="holdstrip" lens material="regular" radius={20} style={{flex:1}} contentStyle={{minHeight:40,justifyContent:'center'}}><VoiceRecordingBar holding cancelProgress={cancelProgress} durationMs={voice.durationMs} levels={voice.levels} onCancel={()=>{}} onSend={()=>{}}/></GlassSurface>:<>
        <GlassSurface material="regular" radius={20} interactive contentStyle={{width:40,height:40,alignItems:'center',justifyContent:'center'}}><Pressable accessibilityRole="button" accessibilityLabel="Вложения: галерея, файлы, опрос" disabled={uploading} onPress={()=>{Keyboard.dismiss();setStickers(false);setAttachMenu(true);}} hitSlop={6} style={{opacity:uploading?.4:1}}><Icon name="attach" size={24} color={t.text}/></Pressable></GlassSurface>
        <GlassSurface lens material="regular" radius={20} style={{flex:1}} contentStyle={{minHeight:40,maxHeight:140,flexDirection:'row',alignItems:'flex-end'}}>
          <View style={{flex:1,justifyContent:'center',minHeight:40}}><ComposerInput focusKey={editing?`edit:${editing.clientId}`:replyTo?`reply:${replyTo.clientId}`:keyboardAsk?`keyboard:${keyboardAsk}`:null} onFocus={()=>{if(stickers&&Platform.OS!=='web')stickersToKeyboard();}} minHeight={40} accessibilityLabel="Сообщение" placeholder={signalAvailable?'Сообщение':'Нужна мобильная версия'} editable={signalAvailable} value={text} onChangeText={changeText} onSelectionChange={e=>{caret.current=e.nativeEvent.selection;}} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} multiline maxLength={8000} style={{fontSize:17,lineHeight:22,color:t.text,paddingHorizontal:14,paddingTop:Platform.OS==='ios'?9:7,paddingBottom:9,maxHeight:136}} onKeyPress={e=>{if(Platform.OS==='web'&&e.nativeEvent.key==='Enter'&&!(e.nativeEvent as unknown as {shiftKey?:boolean}).shiftKey){e.preventDefault();send();}}}/></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Стикеры и эмодзи" onPress={toggleStickers} style={({pressed})=>({height:40,width:38,alignItems:'center',justifyContent:'center',opacity:pressed?.6:1})}><Icon name={stickers?'keypad-outline':'happy-outline'} color={stickers?t.accent:t.muted} size={22}/></Pressable>
        </GlassSurface>
        {canSend||!signalAvailable||uploading?<Pressable accessibilityRole="button" accessibilityLabel="Отправить сообщение" disabled={!signalAvailable||uploading||(!text.trim()&&!attachments.length&&!editing&&!forwardDraft)} onPress={send} style={({pressed})=>({height:40,width:40,borderRadius:20,backgroundColor:t.accent,alignItems:'center',justifyContent:'center',opacity:!signalAvailable||uploading||(!text.trim()&&!attachments.length&&!editing&&!forwardDraft)?.4:pressed?.75:1})}><Icon name={editing?'checkmark':'arrow-up'} color={t.onAccent} size={25}/></Pressable>
        :null}</>}
        {!(canSend||!signalAvailable||uploading)||recHold?<View key="rec" style={{zIndex:5}}><RecordButton mode={recordMode} disabled={uploading||!signalAvailable} onToggleMode={toggleRecordMode} onTouchDown={()=>{if(recordModeRef.current==='voice')voice.prepare();}} onHoldStart={holdStart} onHoldEnd={holdEnd} onLock={holdLock} onSlide={setCancelProgress} level={recHold?.kind==='voice'?voice.levels.at(-1)||0:0}/></View>:null}
      </View>}
      {text.length>7500?<Text style={{fontSize:10,color:t.muted,textAlign:'right',paddingRight:8}}>{text.length} / 8000</Text>:null}
    </View>}
    {stickers&&!selection?<StickerPanel bottomInset={insets.bottom} onPick={insertEmoji} onErase={eraseBack} onClose={()=>setStickers(false)}/>:null}
    </Animated.View>
    <VideoNoteRecorder visible={circleOpen} hold={videoHold} onClose={()=>{setCircleOpen(false);setVideoHold(null);setRecHold(null);}} onDone={take=>{setCircleOpen(false);setVideoHold(null);setRecHold(null);void sendVideoNote(take);}}/>
    <AttachmentPanel key={photoContext} onPoll={()=>{setAttachMenu(false);setTimeout(()=>setPollOpen(true),350);}} visible={attachMenu} busy={uploading} canAdd={signalAvailable} remainingSlots={Math.max(0,MAX_DRAFT_ATTACHMENTS-attachments.length)} onClose={()=>setAttachMenu(false)} onAdd={item=>upload(item.file)}/>
    <TrustSheet visible={securityOpen} onClose={()=>setSecurityOpen(false)} peerId={chat.peer.id} store={store}/>
    {mediaOpen?<Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={()=>setMediaOpen(false)}><GlassStage><SafeAreaView style={{flex:1}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:14,paddingVertical:10}}><IconButton name="close" label="Закрыть" onPress={()=>setMediaOpen(false)}/><Text style={{flex:1,color:t.text,fontSize:17,fontWeight:'700'}} numberOfLines={1}>Вложения · {chat.peer.displayName}</Text></View>
      <ScrollView contentContainerStyle={{padding:16,paddingBottom:40}}><SharedMedia messages={view.messages} emptyText="Здесь появятся фото, видео, файлы, голосовые и ссылки из этого чата." onOpen={attachment=>{setMediaOpen(false);setTimeout(()=>openAttachment(attachment),250);}}/></ScrollView>
    </SafeAreaView></GlassStage></Modal>:null}
    {mini?<MiniProfile api={api} user={chat.peer} me={user.id} at={mini} inChat status={headerStatus.text} onClose={()=>setMini(null)} onOpenProfile={()=>setTimeout(()=>setPeerInfo(true),Platform.OS==='ios'?300:0)} quick={{onCall:calls.available?video=>setTimeout(()=>calls.start(chat,video),Platform.OS==='ios'?300:0):undefined,onAttachments:()=>setTimeout(()=>setMediaOpen(true),Platform.OS==='ios'?300:0),rules:view.rules||{ttl:0,noCopy:false},onRules:rules=>store.sendAction(chat.id,{type:'settings',ttl:rules.ttl,noCopy:rules.noCopy})}}/>:null}
    {peerInfo?<UserProfile api={api} user={chat.peer} chat={chat} shared={view.messages} onOpenAttachment={openAttachment} status={headerStatus.text.startsWith('@')||headerStatus.text.endsWith('…')?undefined:headerStatus.text} onClose={()=>setPeerInfo(false)} onMute={muted=>store.updateChatSettings(chat.id,{muted})} onSearch={()=>{setSearchOpen(true);setQuery('');}} onSecurity={()=>setTimeout(()=>setSecurityOpen(true),350)} onWallpaper={()=>setTimeout(()=>setWallpaperOpen(true),350)} rules={view.rules} onRules={signalAvailable?rules=>store.sendAction(chat.id,{type:'settings',ttl:rules.ttl,noCopy:rules.noCopy}):undefined} onClear={()=>store.sendAction(chat.id,{type:'clear'})}/>:null}
    <WallpaperPicker visible={wallpaperOpen} onClose={()=>setWallpaperOpen(false)} chatId={chat.id}/>
    {dropping?<View pointerEvents="none" style={{position:'absolute',top:12,left:12,right:12,bottom:12,zIndex:20,borderRadius:24,borderWidth:2,borderStyle:'dashed',borderColor:t.accent,backgroundColor:t.dark?'rgba(10,14,24,0.72)':'rgba(255,255,255,0.78)',alignItems:'center',justifyContent:'center',gap:10}}><Icon name="cloud-upload-outline" size={44} color={t.accent}/><Text style={{color:t.text,fontSize:20,fontWeight:'700'}}>Отпусти, чтобы прикрепить</Text><Text style={{color:t.muted,fontSize:13}}>Файлы зашифруются перед отправкой</Text></View>:null}
    {/* Telegram: long-press the avatar in the header — a large photo card with «Открыть профиль» and «Поиск». */}
    <ContextMenu visible={avatarMenu} y={insets.top+60} onClose={()=>setAvatarMenu(false)} peek={avatarMenu?<View style={{alignItems:'center',padding:18,borderRadius:28,backgroundColor:t.dark?'#1C1C1E':'#FFFFFF'}}><DecoratedAvatar user={chat.peer} api={api} size={220} animated round/><Text raw numberOfLines={1} style={{color:t.text,fontSize:18,fontWeight:'700',marginTop:14}}>{chat.peer.displayName}</Text><Text style={{color:t.muted,fontSize:14,marginTop:2}}>{headerStatus.text}</Text></View>:undefined}>
      <MenuItem icon="person-circle-outline" label="Открыть профиль" onPress={()=>{setAvatarMenu(false);setTimeout(()=>setPeerInfo(true),Platform.OS==='ios'?250:0);}}/>
      <MenuItem icon="search-outline" label="Поиск" onPress={()=>{setAvatarMenu(false);setTimeout(()=>setSearchOpen(true),250);}}/>
    </ContextMenu>
    <ContextMenu visible={!!actions} y={menuY} x={menuX} onClose={()=>setActions(null)} peekRow peek={actions&&menuX===undefined?renderRow({item:actions,index:Math.max(0,rows.indexOf(actions))}):undefined} preview={actions?(actions.message?.text||actions.pending?.text||(actions.message?.attachment||actions.pending?.attachment?attachmentLabel((actions.message?.attachment||actions.pending?.attachment)!):'')):''} mine={!!actions&&(!!actions.pending||actions.message?.senderId===user.id)} reactions={actions?.message&&actions.message.cryptoState==='decrypted'?REACTIONS.map(emoji=>({emoji,chosen:actions.message!.reactions.some(r=>r.mine&&r.emoji===emoji)})):undefined} onReact={emoji=>{if(actions?.message){react(actions.message,emoji as Reaction);setActions(null);}}}>
      {actions?.message&&actions.message.senderId===user.id&&actions.message.id<=chat.peerLastReadMessageId&&Date.now()-Date.parse(actions.message.createdAt)<7*864e5?<ReadDateRow key={actions.message.id} load={()=>api.readDate(chat.id,actions.message!.id)}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="arrow-undo-outline" label="Ответить" onPress={()=>{setEditing(null);setReplyTo(actions.message!);setActions(null);}}/>:null}
      {!locked&&(actions?.message?.text||actions?.pending?.text)?<MenuItem icon="copy-outline" label="Скопировать" onPress={()=>void copy(actions?.message?.text||actions?.pending?.text||'')}/>:null}
      {!locked&&(actions?.message?.attachment||actions?.pending?.attachment)?<MenuItem icon="download-outline" label={(()=>{const a=actions?.message?.attachment||actions?.pending?.attachment;const kind=a?mediaPreviewKind(a):'file';return kind==='video'?'Сохранить видео':kind==='photo'?'Сохранить фото':'Сохранить';})()} onPress={()=>{const a=actions?.message?.attachment||actions?.pending?.attachment;setActions(null);if(a)void download(a);}}/>:null}
      {actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon={view.pinned?.clientId===actions.message.clientId?'pin':'pin-outline'} label={view.pinned?.clientId===actions.message.clientId?'Открепить':'Закрепить'} onPress={()=>{const m=actions.message!;store.sendAction(chat.id,{type:'pin',target:view.pinned?.clientId===m.clientId?null:m.clientId},m.text);setActions(null);}}/>:null}
      {!locked&&actions?.message&&actions.message.cryptoState==='decrypted'?<MenuItem icon="arrow-redo-outline" label="Переслать" onPress={()=>{const item=actions.message!;void forwardable([item]).then(ok=>{if(ok)setForwarding(item);});setActions(null);}}/>:null}
      {actions?.message&&actions.message.senderId===user.id&&actions.message.cryptoState==='decrypted'&&actions.message.text?<MenuItem icon="create-outline" label="Изменить" onPress={()=>{setReplyTo(null);setEditing(actions.message!);store.setDraft(chat.id,actions.message!.text);setActions(null);}}/>:null}
      {actions?.pending?.state==='failed'?<MenuItem icon="refresh-outline" label="Повторить отправку" onPress={()=>{if(actions.pending)void store.retry(actions.pending);setActions(null);}}/>:null}
       {actions?.message?<MenuItem icon="trash-outline" label="Удалить" danger onPress={()=>{const list=rowMessages(actions);const mineAll=list.every(m=>m.senderId===user.id&&m.cryptoState==='decrypted');setActions(null);setDeleteOne({list,everyone:mineAll});}}/>:null}
      {actions?.message?<MenuItem separated icon="checkmark-circle-outline" label="Выбрать" onPress={()=>startSelect(actions)}/>:null}
    </ContextMenu>
    <ForwardPicker visible={!!forwarding||!!forwardMany} api={api} userId={user.id} chats={store.chats} count={forwarding?1:forwardMany?.length||0}
      onClose={()=>{setForwarding(null);setForwardMany(null);}}
      onPick={(target:ForwardTarget)=>{const list=forwarding?[forwarding]:forwardMany||[];setForwarding(null);setForwardMany(null);setSelection(null);
        if(!target){list.forEach(m=>saveToFavorites(m));return;}
        // Telegram: the chat opens with the forward waiting above the input (a comment can be added).
        setForwardDraft({chatId:target.id,items:list.map(m=>({message:m,author:originalAuthor(m)}))});
        if(target.id!==chat.id)store.selectChat(target);}}
      onSendMany={(targets:ForwardTarget[],comment:string)=>{const list=forwarding?[forwarding]:forwardMany||[];setForwarding(null);setForwardMany(null);setSelection(null);
        void (async()=>{for(const target of targets){if(!target){list.forEach(m=>saveToFavorites(m));continue;}if(comment)store.send(target.id,comment,null);for(const m of list)await store.forward(target.id,m,originalAuthor(m));}
          setNotice(targets.length===1&&targets[0]?`Переслано: ${targets[0].peer.displayName}`:`Переслано в ${targets.length} ${targets.length<5?'чата':'чатов'}`);})().catch(e=>setLocalError(e instanceof Error?e.message:'Не удалось переслать.'));}}/>
    <AttachmentViewer api={api} attachment={preview} onClose={()=>setPreview(null)}/>
    {gallery?<MediaGallery api={api} items={gallery.items} index={gallery.index} onClose={()=>setGallery(null)}/>:null}
    <PollComposer visible={pollOpen} onClose={()=>setPollOpen(false)} onSend={poll=>{setPollOpen(false);lightFeedback();store.sendPoll(chat.id,poll);listRef.current?.scrollToOffset({offset:0,animated:true});}}/>
    {/* Telegram: the menu has one «Удалить»; the choice comes after it. */}
    <Sheet visible={!!deleteOne} title={deleteOne&&deleteOne.list.length>1?`Удалить ${deleteOne.list.length} ${deleteOne.list.length<5?'сообщения':'сообщений'}?`:'Удалить сообщение?'} onClose={()=>setDeleteOne(null)}>
      <SheetAction icon="eye-off-outline" label="Удалить у меня" description="Исчезнет только на этом устройстве" danger onPress={()=>{const d=deleteOne;setDeleteOne(null);d?.list.forEach(m=>store.hideForMe(m));}}/>
      {deleteOne?.everyone?<SheetAction icon="trash-outline" label="Удалить у всех" description="Собеседник тоже перестанет видеть. Зашифрованная копия на сервере остаётся нечитаемой." danger onPress={()=>{const d=deleteOne;setDeleteOne(null);d?.list.forEach(m=>store.sendAction(chat.id,{type:'delete',target:m.clientId}));}}/>:null}
    </Sheet>
    <Sheet visible={deleteAsk} title={`Удалить ${selectedMessages.length} ${selectedMessages.length===1?'сообщение':selectedMessages.length<5?'сообщения':'сообщений'}?`} onClose={()=>setDeleteAsk(false)}>
      <SheetAction icon="eye-off-outline" label="Удалить у меня" description="Исчезнут только на этом устройстве" danger onPress={()=>{setDeleteAsk(false);deleteSelected(false);}}/>
      {selectedMessages.length&&selectedMessages.every(m=>m.senderId===user.id)?<SheetAction icon="trash-outline" label="Удалить у всех" description="Собеседник тоже перестанет их видеть" danger onPress={()=>{setDeleteAsk(false);deleteSelected(true);}}/>:null}
    </Sheet>
  </View></KeyboardSafeView></GlassTargetScope></VoicePlaybackProvider>;
}
