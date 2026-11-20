import { TabBar } from './TabBar';
import { badgeText, useUnreadTotal } from './unreadBadge';
import { inviteCodeFrom, withoutInviteLink } from './communities/types';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMeshActive } from './nearby/meshState';
import { TITLE_TEXT, titleState } from './network/offline';
import { NAME_METAL, NAME_METAL_LIGHT, PlatinaGem, PlatinaName, hasPlatina } from './platina/PlatinaMark';
import { FolderEditor, FolderTabs, folderTabIds, matchesFolder, useChatFolders, type ChatFolder, type FolderFilter } from './ChatFolders';
import { attachmentLabel, isVideoNote, listAttachment } from './voice/voice';
import { animMs, motionEnabled } from './motion';
import { ActivityIndicator, FlatList, Image, LayoutAnimation, Platform, Pressable, RefreshControl, StyleSheet, UIManager, View, processColor, useWindowDimensions } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { NativeChatListProps, NativeChatRow } from '../modules/linea-chatlist';
import { useChatPreferences } from './chatPreferences';
import { tr } from './i18n';
import { visibleStatusEmoji } from './statusEmojiModel';
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) UIManager.setLayoutAnimationEnabledExperimental(true);
import { TITLE, Text, TextInput } from './typography';
import { MiniPlayer } from './music/PlayerControls';
import { ChatListSkeleton } from './effects';
import { FloatingHeader, TabBarEdge, isWideLayout, useBleed } from './tabInset';
import { tabBarMarginBottom } from './chatLayout';
import { Avatar, Bouncy, Button, Empty, Icon, IconButton, Notice, Sheet } from './components';
import { GlassSurface } from './glass';
import { SnowLedge } from './SnowPhone';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar } from './platina/Decor';
import { navigate } from './navigation';
import { ChatSearch } from './ChatSearch';
import { Nameplate } from './platina/Effects';
import { NameplateBake } from './platina/Nameplates';
import { FRAMES } from './platina/Decor';
import { findDecoration } from './platina/Decorations';
import { CODE_FRAME_SCALE, CodeFrame, isCodeFrame, type CodeFrameId } from './platina/CodeFrames';
import { VoiceBar } from './communities/VoiceBar';
import { startRoomCall } from './rooms/rooms';
import { orbColors } from './design/peerLight';
import { useRoomsAwake } from './rooms/RoomsSection';
import { useCalls } from './calls/CallProvider';
import { formatListTime, useTheme } from './theme';
import type { Api } from './api';
import type { Chat, Message, User } from './types';
import { chatListText, foldChat, pinPreview, skippedInList } from './messageMeta';
import { callListText } from './calls/callLog';
import { countChats } from './plural';
import type { MessengerStore } from './useMessenger';
import type { SavedItem } from './saved/saved.ts';
import { CLOSE_MS, ContextMenu, MenuItem } from './ContextMenu';
import { StoriesStrip } from './stories/StoriesStrip';
import { incomingCount, useFriendRequests } from './friendRequests';
import { useChannelsBadge } from './communities/unread';
import { impactFeedback, lightFeedback } from './haptics';
import { MuteSheet } from './notifications/MuteSheet';
import { RemoveChatSheet } from './ChatSheets';
import { isMuted, muteUntilLabel } from './notifications/model';
import { Gesture, GestureDetector, State } from 'react-native-gesture-handler';
import Animated, { Easing, makeMutable, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { getMarkedUnread, markedExtra, pruneMarkedUnread, setMarkedExtra, setMarkedUnread, showsUnread, useMarkedExtra, useMarkedUnread } from './markedUnread';
import { ROW_BUTTON, ROW_GAP, SEARCH_PULL, searchPullOpens, archiveSnap, fullSwipeDistance, openWidth, pageRelease, openRowSlot, pagePosition, rowActions, rowClaimsSwipe, rowDrag, rowRelease, type RowAction, type RowSupport } from './listSwipes';

// Telegram: the first row stands ~11 pt below the folder bar; flush against it, the bar's edge fade covered the top of «Избранное».
const LIST_GAP=10;
/** Height the search field takes at the top of the list (44 pt field, 10 pt gap). */
const SEARCH_ROW=54;
export type MessengerTab = 'chats' | 'people' | 'channels' | 'music' | 'ai' | 'profile';
type Navigation = { onProfile:()=>void;onNewChat:()=>void;onMusic:()=>void;onAI:()=>void;onChats:()=>void;activeTab?:MessengerTab };

// Experimental (phones, «Быстрый список чатов» in the settings): the list drawn by modules/linea-chatlist. Absent
// in a build without the module — then the React list below is used whatever the setting says.
const NativeChatListView:React.ComponentType<NativeChatListProps>|null=Platform.OS==='android'||Platform.OS==='ios'?(()=>{try{return requireOptionalNativeModule('LineaChatList')?requireNativeViewManager('LineaChatList'):null;}catch{return null;}})():null;
// A container the native side can photograph (modules/linea-chatlist, LineaBake): frames drawn in code are rendered
// by their own component once, off screen, and the native list shows the picture.
const NativeBakeView:React.ComponentType<{style?:unknown;children?:React.ReactNode;ref?:React.Ref<{snapshot:()=>Promise<string>}>}>|null=Platform.OS==='android'||Platform.OS==='ios'?(()=>{try{return requireOptionalNativeModule('LineaBake')?requireNativeViewManager('LineaBake'):null;}catch{return null;}})():null;
const FRAME_BOX=60;
function FrameBake({id,onReady}:{id:CodeFrameId;onReady:(id:string,base64:string)=>void}){
  const ref=useRef<{snapshot:()=>Promise<string>}>(null);const art=Math.round(FRAME_BOX*CODE_FRAME_SCALE);
  useEffect(()=>{
    let alive=true,tries=0;
    // The frame's layers must be on screen (off to the side) before the picture is taken; a blank answer is asked again.
    const shoot=()=>{void ref.current?.snapshot?.().then(data=>{if(!alive)return;if(data)onReady(id,data);else if(++tries<5)timer=setTimeout(shoot,400);}).catch(()=>{});};
    let timer=setTimeout(shoot,500);
    return()=>{alive=false;clearTimeout(timer);};
  },[id]);
  if(!NativeBakeView)return null;
  return <View pointerEvents="none" style={{position:'absolute',left:-4000,top:0,width:art,height:art}}><NativeBakeView ref={ref} style={{width:art,height:art}}><View style={{position:'absolute',left:(art-FRAME_BOX)/2,top:(art-FRAME_BOX)/2,width:FRAME_BOX,height:FRAME_BOX}}><CodeFrame id={id} size={FRAME_BOX} live={false}/></View></NativeBakeView></View>;
}
const colorNumber=(value:string)=>{const c=processColor(value);return typeof c==='number'?c:0;};
/** The line under the name, as ChatRow shows it (text only: the native row has no thumbnail). */
/** Telegram: a chat with unsent text or attachments shows «Черновик: …» in the list, the word in red. */
const DRAFT_WORD='Черновик:';
function draftLine(text:string|undefined,files:number):string{const typed=(text||'').replace(/\s+/g,' ').trim();return typed?`${DRAFT_WORD} ${typed.slice(0,160)}`:files?`${DRAFT_WORD} ${files>1?`вложения (${files})`:'вложение'}`:'';}
function nativeLine(chat:Chat,typing:boolean,userId:string):{icon:''|'mic';text:string}{
  const plain=(text:string)=>({icon:'' as const,text});
  const last=chat.lastMessage;if(typing)return plain('Печатает…');if(!last)return plain('Напиши первое сообщение');
  const call=callListText(last,userId);if(call)return plain(call);
  const text=listText(chatListText(last))||'';
  if(last.meta?.action?.type==='pin'&&last.meta.action.target)return plain(pinPreview(text,last.senderId===userId,chat.peer.displayName));
  if(text)return plain(text);
  const file=last.attachment;if(!file)return plain('Сообщение');
  return listAttachment(file);
}
const SAVED_ROW='__saved',ARCHIVE_ROW='__archive',BACK_ROW='__back';
const SWIPE_LABEL:Record<RowAction,string>={read:'Прочитано',unread:'Не прочитано',pin:'Закрепить',unpin:'Открепить',mute:'Без звука',unmute:'Со звуком',delete:'Удалить',archive:'В архив',unarchive:'Вернуть'};
/** The small picture before the preview, as ChatRow shows it: the photo, video or round video of the last message. */
function nativeThumb(chat:Chat,typing:boolean,userId:string):{thumb:string;thumbRound:boolean}{
  const last=chat.lastMessage,file=last?.attachment;
  if(typing||!last||!file?.preview||listText(chatListText(last))||callListText(last,userId))return {thumb:'',thumbRound:false};
  const round=isVideoNote(file);
  return round||file.mimeType.startsWith('image/')||file.mimeType.startsWith('video/')?{thumb:file.preview.base64,thumbRound:round}:{thumb:'',thumbRound:false};
}

/** The part of the list a chat belongs to: pinned ones first, then by the day of the last message. */
function listSection(chat:Chat):string{
  if(chat.settings?.pinnedAt)return 'Закреплённые';
  const at=chat.lastMessage?.createdAt;if(!at)return 'Раньше';
  const day=(value:Date)=>new Date(value.getFullYear(),value.getMonth(),value.getDate()).getTime();
  const days=Math.round((day(new Date())-day(new Date(at)))/86_400_000);
  return days<=0?'Сегодня':days===1?'Вчера':'Раньше';
}
/** The quiet heading above the first chat of each part. */
function ListSection({text}:{text:string}){
  const t=useTheme();
  return <Text style={{color:t.subtle,fontSize:11,fontWeight:'700',letterSpacing:1.4,textTransform:'uppercase',paddingHorizontal:18,paddingTop:14,paddingBottom:4}}>{text}</Text>;
}
/** The lighter and deeper corner colours of a letter avatar for the native rows. */
const orbPair=(color:string)=>{const [light,,deep]=orbColors(color);return {orbA:colorNumber(light),orbB:colorNumber(deep)};};
export function ChatListScreen({api,user,store,onProfile,onNewChat,onMusic,onAI,onQuickAI,onChats,onSaved,savedActive=false,activeTab='chats',rail=false,banner=null,sharedTabs,onEditing}: {/** The tab bar is drawn by the app (one bar for every tab): its height, so the list keeps room for it. */sharedTabs?:number;/** «Изм.» was opened or closed (the shared bar gives way to the actions). */onEditing?:(editing:boolean)=>void;api:Api;user:User;store:MessengerStore;onQuickAI:()=>void;onSaved:()=>void;savedActive?:boolean;rail?:boolean;banner?:React.ReactNode}&Navigation) {
  // Tabs float over the list (it scrolls under the blurred bar, like Telegram); the list keeps room for them at the end.
  const calls=useCalls();
  const [tabsHeight,setTabsHeight]=useState(96);const [headerHeight,setHeaderHeight]=useState(170);const bleed=useBleed();
  const float=!rail&&Platform.OS!=='web';
  // A tablet held upright has no rail but room for the «Поиск» field; only the phone gets the magnifier instead.
  const screen=useWindowDimensions();const phone=float&&Math.min(screen.width,screen.height)<600;
  // Phone: «Поиск» is not on screen at all until it is asked for — one quick pull down at the top of the list, or
  // two pulls in a row; any swipe up puts it away again.
  const [searchOpen,setSearchOpen]=useState(false);
  const mesh=useMeshActive();
  // Title like Telegram: «Ожидание сети…» → «Соединение…» → «Обновление…» → «Чаты».
  const title=titleState({connection:store.connection,online:store.online,updating:store.updating,mesh});
  // The open chat is highlighted only when it is shown beside the list (tablet/desktop), as in Telegram.
  const windowSize=useWindowDimensions();const wideLayout=isWideLayout(windowSize.width,windowSize.height);
  // Rows remount when a chat closes: a press interrupted by opening the chat otherwise left the
  // row stuck in its pressed (highlighted) colour after coming back.
  const t=useTheme();const [searching,setSearching]=useState(false);const query:string='';const [refreshing,setRefreshing]=useState(false);
  const [savedMenu,setSavedMenu]=useState<{y:number}|null>(null);const [savedClear,setSavedClear]=useState(false);
  const [archive,setArchive]=useState(false);const [editing,setEditing]=useState<Set<string>|null>(null);
  // One tab bar for the whole phone (drawn by the app): the list only keeps room for it and says when «Изм.» is open.
  useEffect(()=>{if(sharedTabs&&Math.abs(sharedTabs-tabsHeight)>1)setTabsHeight(sharedTabs);},[sharedTabs,tabsHeight]);
  const isEditing=!!editing;useEffect(()=>{onEditing?.(isEditing);},[isEditing,onEditing]);
const [removeAsk,setRemoveAsk]=useState<Chat[]|null>(null);const [menu,setMenu]=useState<{chat:Chat;y:number;x?:number}|null>(null);const [menuError,setMenuError]=useState('');const [muteAsk,setMuteAsk]=useState<Chat[]|null>(null);
  const archivedCount=store.chats.filter(c=>c.settings?.archived).length;
  const folders=useChatFolders(user.id);const [filter,setFilter]=useState<FolderFilter>('all');const [editor,setEditor]=useState<{folder:ChatFolder|null}|null>(null);
  // Chats marked unread by hand (Telegram «Пометить как непрочитанное»): a device-local flag (src/markedUnread.ts).
  // Opening the chat clears it — also when it was opened from elsewhere (a notification, search, the switcher).
  const marked=useMarkedUnread(user.id);
  // Only on a change of the open chat: marking the chat that is open beside the list (tablet/desktop) keeps the mark.
  const openedChat=useRef<string|null>(null);
  useEffect(()=>{const id=store.selectedId;if(id===openedChat.current)return;openedChat.current=id;if(id&&getMarkedUnread(user.id).has(id))setMarkedUnread(user.id,id,false);},[store.selectedId,user.id]);
  useEffect(()=>{if(!store.listLoading&&store.chats.length)pruneMarkedUnread(user.id,store.chats.map(c=>c.id));},[store.listLoading,store.chats,user.id]);
  // «Непрочитанные» badge: not archived, not muted — an expired mute counts again (isMuted compares the clock).
  const counted=(c:Chat)=>!c.settings?.archived&&!isMuted(c.settings);
  const unread=store.chats.filter(c=>counted(c)&&showsUnread(c,marked)).length;
  // A marked chat adds one to the «Чаты» tab badge, as in Telegram (the total itself counts messages, see App).
  const extra=markedExtra(store.chats,marked,c=>counted(c as Chat));
  useEffect(()=>{setMarkedExtra(extra);},[extra]);
  useEffect(()=>{if(filter!=='all'&&!folders.folders.some(f=>f.id===filter))setFilter('all');},[folders.folders,filter]);
  // Telegram: a sideways swipe over the list moves to the next / previous folder, the tab highlight
  // following the finger. Rows keep their own swipes: a pan that starts on a chat row belongs to the
  // row (rowTouch), so this one takes drags over the rest of the list (gaps, «Избранное», «Архив»,
  // an empty or short folder) and, in edit mode, the rows too. Logic in src/listSwipes.ts.
  const tabIds=folderTabIds(folders.folders);const folderIndex=Math.max(0,tabIds.indexOf(filter));
  const folderPos=useSharedValue(folderIndex);const listShift=useSharedValue(0);const panStart=useSharedValue({x:0,y:0});
  useEffect(()=>{folderPos.value=withTiming(folderIndex,{duration:animMs(220),easing:Easing.out(Easing.cubic)});closeOpenSwipeRow();},[folderIndex,folderPos]);
  // Which way a folder can be turned (bit 1: back, bit 2: forward) — the rows give those drags up, see SwipeRow.
  const ways=Platform.OS!=='web'&&!archive&&tabIds.length>1?(folderIndex>0?1:0)|(folderIndex<tabIds.length-1?2:0):0;
  useEffect(()=>{folderWays.value=ways;return()=>{folderWays.value=0;};},[ways]);
  const goFolder=(to:number)=>{const id=tabIds[to];if(id!==undefined&&id!==filter){lightFeedback();setFilter(id);}};
  const motion=motionEnabled();
  // The list's own width (narrower than the window beside the rail / an open chat), measured on layout.
  const listWidth=useSharedValue(windowSize.width);
  // Both sideways gestures of the list use the pan's own thresholds (sideways by 12–16 pt to start, 10 pt up or down to
  // give up), decided natively on the UI thread — not manual activation. With the row and the pager both activated
  // by hand, a finger held on the list and then moved (or a slanted swipe) left the list not scrolling at all on the
  // iPhone. The touch callbacks below only decline a drag that belongs to the other one, while it is still undecided.
  const folderSwipe=Gesture.Pan().activeOffsetX([-16,16]).failOffsetY([-10,10]).enabled(Platform.OS!=='web'&&!archive&&tabIds.length>1)
    .onTouchesDown((e,manager)=>{const touch=e.changedTouches[0];if(!touch||e.numberOfTouches>1){manager.fail();return;}panStart.value={x:touch.absoluteX,y:touch.absoluteY};})
    .onTouchesMove((e,manager)=>{
      if(e.state===State.ACTIVE)return;
      const touch=e.changedTouches[0];if(!touch)return;
      const dx=touch.absoluteX-panStart.value.x;if(Math.abs(dx)<3)return;
      // Nothing before «Все» or after the last folder: such a drag is left alone.
      if((dx>0&&folderIndex===0)||(dx<0&&folderIndex===tabIds.length-1)){manager.fail();return;}
      // On a chat row: from its edge the row's buttons slide out, from the middle the folder turns (rowClaimsSwipe).
      if(rowTouch.value&&rowClaimsSwipe(rowStart.value.local,rowStart.value.width,dx,rowStart.value.open,folderIndex>0,folderIndex<tabIds.length-1))manager.fail();
    })
    .onUpdate(e=>{folderPos.value=pagePosition(folderIndex,tabIds.length,e.translationX,listWidth.value);listShift.value=motion?e.translationX*0.3:0;})
    .onEnd(e=>{
      const to=pageRelease(folderIndex,tabIds.length,e.translationX,e.velocityX,listWidth.value);
      folderPos.value=motion?withTiming(to,{duration:200,easing:Easing.out(Easing.cubic)}):to;
      listShift.value=motion?withTiming(0,{duration:200,easing:Easing.out(Easing.cubic)}):0;
      runOnJS(goFolder)(to);
    });
  const listFollow=useAnimatedStyle(()=>({flex:1,transform:[{translateX:listShift.value}],opacity:1-Math.min(0.35,Math.abs(listShift.value)/400)}));
  // Telegram moves rows smoothly when a chat jumps to the top or gets pinned.
  const order=store.chats.map(c=>`${c.id}${c.settings?.pinnedAt||''}${c.settings?.archived?1:0}`).join(',');const lastOrder=useRef(order);
  if(lastOrder.current!==order){lastOrder.current=order;if(motionEnabled())LayoutAnimation.configureNext(LayoutAnimation.create(220,LayoutAnimation.Types.easeInEaseOut,LayoutAnimation.Properties.opacity));}
  // Pinned chats first (newest pin on top), archived chats only inside «Архив», as in Telegram.
  const chats=useMemo(()=>store.chats.filter(c=>!!c.settings?.archived===archive&&(archive||matchesFolder(c,filter,folders.folders,marked))&&`${c.peer.displayName} ${c.peer.username}`.toLowerCase().includes(query.toLowerCase())).map((c,i)=>({c,i})).sort((a,b)=>{const pa=a.c.settings?.pinnedAt||'',pb=b.c.settings?.pinnedAt||'';if(pa||pb)return pa&&pb?pb.localeCompare(pa):pa?-1:1;return a.i-b.i;}).map(x=>x.c),[store.chats,query,archive,filter,folders.folders,marked]);
  const change=(chat:Chat,update:Partial<{pinned:boolean;archived:boolean;muted:boolean}>)=>{setMenu(null);setMenuError('');lightFeedback();store.updateChatSettings(chat.id,update).catch(e=>setMenuError(e instanceof Error?e.message:'Не удалось изменить чат.'));};
  // Telegram «Выкл. звук»: a muted chat gets its sound back in one tap; otherwise the sheet asks for how long
  // (1 hour / 8 hours / 2 days / forever / custom). The server answers with the chat and tells every device over the socket.
  const askMute=(list:Chat[])=>{if(!list.length)return;if(list.every(c=>isMuted(c.settings))){list.forEach(c=>change(c,{muted:false}));setEditing(null);return;}
    // From the long-press menu the sheet waits until the menu is gone: opened in the same instant, the sheet was put on top of the menu's own window and went away with it, leaving an invisible window that took every touch on the list (seen on an iPhone).
    if(menu){setMenu(null);setTimeout(()=>setMuteAsk(list),CLOSE_MS+110);}else setMuteAsk(list);};
  const mute=(list:Chat[],until:string|null)=>{setMuteAsk(null);setMenuError('');setEditing(null);lightFeedback();void Promise.all(list.map(chat=>api.chatSettings(chat.id,until===null?{muted:true}:{mutedUntil:until}))).then(()=>store.refreshChats()).catch(e=>setMenuError(e instanceof Error?e.message:'Не удалось изменить чат.'));};
  // The store reads up to the newest server message, not only the one the list shows (reactions and edits are hidden here).
  // «Прочитано» also takes the hand-made mark off.
  const readChat=(chat:Chat)=>{if(marked.has(chat.id))setMarkedUnread(user.id,chat.id,false);if(chat.unreadCount)void store.readChat(chat.id,chat.lastMessage?.id||0);};
  const markUnread=(chat:Chat)=>{setMenu(null);lightFeedback();setMarkedUnread(user.id,chat.id,true);};
  const toggleEdit=(chat:Chat)=>{lightFeedback();setEditing(current=>{const next=new Set(current||[]);if(next.has(chat.id))next.delete(chat.id);else next.add(chat.id);return next;});};
  // Row callbacks read through a ref: ChatListItem stays memoized, so one chat updating re-renders one row, not the list.
  const rowActionsRef=useRef<RowActions>(null as unknown as RowActions);rowActionsRef.current={editing:!!editing,swipe:(chat,action)=>{switch(action){case 'read':readChat(chat);break;case 'unread':markUnread(chat);break;case 'pin':case 'unpin':change(chat,{pinned:action==='pin'});break;case 'mute':case 'unmute':askMute([chat]);break;case 'delete':setRemoveAsk([chat]);break;case 'archive':case 'unarchive':change(chat,{archived:action==='archive'});break;}},toggleEdit,select:chat=>store.selectChat(chat),menu:(chat,y,x)=>{impactFeedback();setMenu({chat,y,x});}};
  const selectedChats=editing?chats.filter(c=>editing.has(c.id)):[];
  const callSelected=()=>{const list=selectedChats;setEditing(null);lightFeedback();if(list.length===1){void calls.start(list[0],false);return;}void startRoomCall(api,store,user.id,list.map(chat=>chat.peer.id)).catch(e=>store.setError(e instanceof Error?e.message:'Не удалось позвонить.'));};
  const bulk=(fn:(chat:Chat)=>void)=>{const list=selectedChats.length?selectedChats:chats;list.forEach(fn);setEditing(null);lightFeedback();};
  const refresh=async()=>{if(Platform.OS==='android')openSearchRef.current();setRefreshing(true);await store.refreshChats();setRefreshing(false);};
  // Telegram keeps «Архив» above the first chat, out of sight until the list is pulled down: the list
  // opens scrolled just past it (its content is made at least that much taller than the screen) and a
  // drag that ends with it half shown settles open or shut. A further pull still refreshes.
  const archiveRow=!archive&&!!archivedCount&&!query&&filter==='all';
  // Phone: «Поиск» is put away; a pull on the list brings it out under the title, in the floating header (the list
  // itself is never scrolled for it: the header grows and the rows move down with it). `topRow` is «Архив» alone.
  const topRow=archiveRow;
  // ---- the experimental native list (Android) ----
  const nativePref=useChatPreferences().nativeList;const nativeOn=!!NativeChatListView&&nativePref;
  const typingMap=store.typing,selectedId=store.selectedId,savedItems=store.saved.items;
  const nativeRows=useMemo<NativeChatRow[]>(()=>{
    if(!nativeOn)return [];
    const rows:NativeChatRow[]=[];const base={orbA:0,orbB:0,section:'',unread:0,muted:false,pinned:false,accentPreview:false,ticks:0 as const,checked:-1 as const,selected:false,time:'',avatarUrl:'',avatarKey:'',thumb:'',thumbRound:false,previewIcon:'' as ''|'mic',previewRed:0,lead:[] as string[],trail:[] as string[],metal:[] as number[],nameLen:0,ring:[] as number[],deco:'',decoScale:1,plate:''};
    if(archive)rows.push({...base,id:BACK_ROW,title:'‹ Архив',preview:'Вернуться к чатам',avatarColor:colorNumber(t.surface2),initials:'‹'});
    else if(filter==='all'){
      const last=savedItems[savedItems.length-1];
      rows.push({...base,id:SAVED_ROW,title:'Избранное',preview:last?(listText(last.text)||(last.attachment?listAttachment(last.attachment).text:'Запись')):'Заметки, файлы и сохранённые сообщения',previewIcon:last&&!listText(last.text)&&last.attachment?listAttachment(last.attachment).icon:'',time:last?formatListTime(last.savedAt):'',selected:savedActive,avatarColor:colorNumber(t.accent),initials:'★'});
      if(archiveRow)rows.push({...base,id:ARCHIVE_ROW,title:'Архив',preview:countChats(archivedCount),avatarColor:colorNumber(t.surface2),initials:'▤'});
    }
    let part='';
    for(const chat of chats){
      // The first chat of each part of the list carries that part's heading.
      const own=archive||filter!=='all'||editing?'':listSection(chat),section=own!==part?own:'';part=own;
      const last=chat.lastMessage,typing=!!typingMap[chat.id],muted=isMuted(chat.settings);
      const swipes=editing?{left:[],right:[]}:rowActions({unread:chat.unreadCount>0||marked.has(chat.id),pinned:!!chat.settings?.pinnedAt,muted,archived:!!chat.settings?.archived},ROW_SUPPORT);
      const status=visibleStatusEmoji(chat.peer,Date.now());const draft=typing?'':draftLine(store.drafts[chat.id],(store.draftFiles[chat.id]||[]).length);const line=draft?{icon:'' as const,text:draft}:nativeLine(chat,typing,user.id);
      // Decorations as DecoratedAvatar and ChatRow show them in a list: an art decoration, else a colour ring (Platina
      // without a chosen frame wears the platinum one), and the nameplate behind the row. A frame drawn in code is a
      // picture the app takes of its own component (FrameBake), shown the way an art decoration is.
      const art=findDecoration(chat.peer.avatarFrame);const coded=isCodeFrame(chat.peer.avatarFrame)?chat.peer.avatarFrame:null;const ringOf=art||coded?undefined:FRAMES.find(item=>item.id===(chat.peer.avatarFrame||(chat.peer.seal==='platina'?'platinum':'')));
      rows.push({...nativeThumb(chat,typing,user.id),ring:ringOf?ringOf.colors.map(colorNumber):[],deco:coded||(art?(Image.resolveAssetSource(art.image as number)?.uri||''):''),decoScale:coded?CODE_FRAME_SCALE:art?art.scale:1,plate:chat.peer.nameplate||'',avatarUrl:chat.peer.avatarId?api.fileUrl(chat.peer.avatarId):'',avatarKey:chat.peer.avatarId?`invizent-file-${chat.peer.avatarId}`:'',lead:swipes.right.map(a=>`${a}:${tr(SWIPE_LABEL[a])}`),trail:swipes.left.map(a=>`${a}:${tr(SWIPE_LABEL[a])}`),
        id:chat.id,metal:chat.peer.seal==='platina'?(chat.peer.nameplate||t.dark?NAME_METAL:NAME_METAL_LIGHT).map(colorNumber):[],nameLen:chat.peer.displayName.length,title:`${chat.peer.displayName}${status?` ${status}`:''}${muted?' 🔕':''}`,preview:line.text,previewIcon:line.icon,previewRed:draft?DRAFT_WORD.length:0,time:last?formatListTime(last.createdAt):'',unread:chat.unreadCount||(marked.has(chat.id)?1:0),muted,pinned:!!chat.settings?.pinnedAt,accentPreview:typing,
        ticks:last&&last.senderId===user.id?(chat.peerLastReadMessageId>=last.id?2:1):0,checked:editing?(editing.has(chat.id)?1:0):-1,selected:wideLayout&&selectedId===chat.id,
        section,avatarColor:colorNumber(chat.peer.avatarColor||'#4B73BB'),...orbPair(chat.peer.avatarColor||'#4B73BB'),initials:chat.peer.displayName.trim().split(/\s+/).slice(0,2).map(word=>Array.from(word)[0]||'').join('').toUpperCase()});
    }
    return rows;
  },[nativeOn,chats,archive,filter,archiveRow,archivedCount,savedItems,savedActive,typingMap,marked,editing,selectedId,wideLayout,user.id,store.drafts,store.draftFiles,t.accent,t.surface2,api]);
  const nativeHeaders=useMemo(()=>api.authHeaders,[api,api.token]);
  // Nameplates are vector art drawn by the app: each one in use is rendered once off screen and handed to the native list as a picture.
  const [plates,setPlates]=useState<Record<string,string>>({});
  const plateIds=useMemo(()=>nativeOn?[...new Set(chats.map(c=>c.peer.nameplate).filter((id):id is string=>!!id))]:[],[nativeOn,chats]);
  const frameIds=useMemo(()=>nativeOn?[...new Set(chats.map(c=>c.peer.avatarFrame).filter(isCodeFrame))]:[],[nativeOn,chats]);
  const plateReady=useCallback((id:string,data:string)=>setPlates(prev=>prev[id]===data?prev:{...prev,[id]:data}),[]);
  const nativeAction=(id:string,action:string)=>{const chat=chats.find(c=>c.id===id);if(chat&&action in SWIPE_LABEL)rowActionsRef.current.swipe(chat,action as RowAction);};
  const nativePalette=useMemo(()=>({bg:colorNumber(t.bg),text:colorNumber(t.text),muted:colorNumber(t.muted),subtle:colorNumber(t.subtle),accent:colorNumber(t.accent),onAccent:colorNumber(t.onAccent),border:0,pressed:colorNumber(t.dark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.05)'),selected:colorNumber(t.accentSoft),badgeMuted:colorNumber(t.surface2),danger:colorNumber(t.danger),pinned:colorNumber(t.dark?'rgba(255,255,255,0.055)':'rgba(0,0,0,0.045)')}),[t]);
  const nativePress=(id:string)=>{
    if(id===SAVED_ROW){onSaved();return;}if(id===ARCHIVE_ROW){setArchive(true);return;}if(id===BACK_ROW){setArchive(false);return;}
    const chat=chats.find(c=>c.id===id);if(!chat)return;const a=rowActionsRef.current;if(a.editing)a.toggleEdit(chat);else a.select(chat);
  };
  const nativeLongPress=(id:string,y:number)=>{if(id===SAVED_ROW){lightFeedback();setSavedMenu({y});return;}const chat=chats.find(c=>c.id===id);if(chat)rowActionsRef.current.menu(chat,y);};
  const listRef=useRef<FlatList<Chat>>(null);const [archiveH,setArchiveH]=useState(0);const [listH,setListH]=useState(0);
  const hideArchive=useRef(true);const listOffset=useRef(0);const contentH=useRef(0);const dragFrom=useRef(0);
  const dragAt=useRef(0);const lastPull=useRef(0);
  const openSearchRef=useRef(()=>{});
  // The phone has no search row any more (owner's decision, 0.14.24): the magnifier in the header opens search, so a
  // pull of the list opens nothing.
  const openSearch=()=>{};
  openSearchRef.current=openSearch;
  const closeSearch=()=>{if(!searchOpen)return;if(motion)LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);setSearchOpen(false);};
  /** A drag has ended at offset `y`: a pull past the top of the list asks for «Поиск» (a quick one at once, a slow one
   *  on its second go within 2.5 s); a swipe up puts an open one away. */
  const searchGesture=(y:number)=>{
    if(!float||archive)return;
    const now=Date.now();
    if(searchOpen){if(y-dragFrom.current>6)closeSearch();return;}
    if(y>=-SEARCH_PULL)return;
    if(searchPullOpens(now-dragAt.current,now-lastPull.current))openSearch();
    lastPull.current=now;
  };
  const tryHideArchive=()=>{
    if(!hideArchive.current||!topRow||!archiveH||!listH)return;
    // Scrolled down into the chats: leave the position alone (the row is out of sight anyway).
    if(listOffset.current>1){hideArchive.current=false;return;}
    if(contentH.current<listH+archiveH-1)return;
    hideArchive.current=false;listOffset.current=archiveH;listRef.current?.scrollToOffset({offset:archiveH,animated:false});
  };
  const tryHideRef=useRef(tryHideArchive);tryHideRef.current=tryHideArchive;
  // The list remounts after search and the first load, at the top; the row hides again then, as when it (re)appears.
  const listMounted=!searching&&!store.listLoading;
  useEffect(()=>{if(listMounted)listOffset.current=0;},[listMounted]);
  // A folder change shows another list from the top: forget the old offset (only then — archiving a chat
  // while scrolled down must not jump the list to the top).
  const lastFilter=useRef(filter);if(lastFilter.current!==filter){lastFilter.current=filter;listOffset.current=0;}
  // Only «Архив» is tucked away by the offset; an opened «Поиск» is meant to be seen.
  useEffect(()=>{if(archiveRow&&listMounted){hideArchive.current=true;tryHideRef.current();}},[archiveRow,listMounted]);
  useEffect(()=>{tryHideRef.current();},[archiveH,listH]);
  const settleArchive=(y:number)=>{listOffset.current=y;if(!archiveRow||hideArchive.current)return;
    // The hidden block follows the direction of the drag that just ended: any swipe up puts it away, any pull down
    // brings it out whole (by the half-way rule alone a short swipe up left «Поиск» on screen).
    const moved=y-dragFrom.current;const to=archiveSnap(y,archiveH,moved>6?1:moved<-6?-1:0);if(to!==null){listOffset.current=to;listRef.current?.scrollToOffset({offset:to,animated:motion});}};
  if(searching)return <View style={{flex:1,backgroundColor:'transparent'}}><ChatSearch api={api} me={user} store={store} onClose={()=>setSearching(false)} onSaved={onSaved}/></View>;
  // In the list the field scrolls under the header, so it holds no snow there; in the header (PC, rail) it does.
  const searchBar=<GlassSurface systemGlass={false} lens material="regular" radius={22} shadow={false} style={{marginHorizontal:16,marginBottom:10}} contentStyle={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:14,minHeight:44,borderRadius:22,backgroundColor:t.dark?'rgba(255,255,255,0.07)':'rgba(110,122,148,0.13)'}}>
        <Pressable onPress={()=>{lightFeedback();setSearching(true);}} accessibilityRole="search" accessibilityLabel="Поиск" style={{flex:1,flexDirection:'row',alignItems:'center',gap:8,minHeight:44}}><Icon name="search-outline" color={t.muted} size={19}/><Text style={{flex:1,fontSize:17,color:t.muted}}>Поиск</Text></Pressable>
      </GlassSurface>;
  // Under the title: how much is waiting, in plain words.
  const unreadChats=chats.filter(chat=>chat.unreadCount>0).length;
  const unreadLine=unreadChats?`${unreadChats} ${unreadChats%10===1&&unreadChats%100!==11?'чат ждёт':unreadChats%10>=2&&unreadChats%10<=4&&(unreadChats%100<12||unreadChats%100>14)?'чата ждут':'чатов ждут'} ответа`:'всё прочитано';
  const header=<>
    {/* Telegram header: «Изм.» · title with connection state · AI and «new chat» buttons. */}
    <View style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:16,paddingTop:6,paddingBottom:10}}>
      <View style={{flex:1,minWidth:0,paddingLeft:4}}>{title==='chats'?<View><Text numberOfLines={1} style={[TITLE,{color:t.text,fontSize:30,lineHeight:36}]}>{archive?'Архив':'Чаты'}</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:12.5,marginTop:1}}>{editing?(selectedChats.length?`Выбрано: ${selectedChats.length}`:'Отметь чаты'):unreadLine}</Text></View>:title==='mesh'?<View accessibilityLabel="Связь через Mesh, без интернета" style={{flexDirection:'row',alignItems:'center',gap:6}}><Icon name="bluetooth" size={16} color={t.accent}/><Text style={{color:t.text,fontSize:17,fontWeight:'700'}}>Mesh</Text></View>:<View style={{flexDirection:'row',alignItems:'center',gap:6}}><ActivityIndicator size="small" color={t.muted}/><Text style={{color:t.text,fontSize:15,fontWeight:'600'}}>{TITLE_TEXT[title]}</Text></View>}</View>
      <SnowLedge id="chats.edit" radius={22}><Bouncy scaleTo={.88} onPress={()=>{lightFeedback();setEditing(current=>current?null:new Set());}} accessibilityRole="button" hitSlop={6}><GlassSurface material="regular" radius={22} interactive contentStyle={{height:44,paddingHorizontal:16,justifyContent:'center'}}><Text style={{color:t.text,fontSize:16,fontWeight:'600'}}>{editing?'Готово':'Выбрать'}</Text></GlassSurface></Bouncy></SnowLedge>
      {/* The phone keeps «Поиск» put away (it comes out when the list is pulled); the magnifier opens the search screen at once. */}
      {phone&&!archive&&!editing?<Bouncy scaleTo={.84} onPress={()=>{lightFeedback();setSearching(true);}} accessibilityRole="button" accessibilityLabel="Поиск" hitSlop={6}><GlassSurface material="regular" radius={22} interactive contentStyle={{width:44,height:44,alignItems:'center',justifyContent:'center'}}><Icon name="search" size={20} color={t.text}/></GlassSurface></Bouncy>:null}
      {/* «Изм.» as in Telegram: only «Готово» stays in the header (the spacer keeps the title centred). */}
      {editing?<View style={{width:phone?44:0}}/>:<SnowLedge id="chats.new" radius={22} max={4}><Bouncy scaleTo={.84} onPress={onNewChat} accessibilityRole="button" accessibilityLabel="Новый чат" hitSlop={6} style={{width:44,height:44,borderRadius:22,backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="create-outline" size={20} color={t.onAccent}/></Bouncy></SnowLedge>}
    </View>
    {/* The PC and the tablet rail keep «Поиск» in the header; the phone has the magnifier button instead. */}
    {phone?null:<SnowLedge id="chats.search" radius={22} inset={{left:16,right:16,bottom:10}}>{searchBar}</SnowLedge>}
    {/* F8: friends' stories above the chats (hidden while nobody has one); not in the archive or while editing. */}
    {!archive&&!editing?<StoriesStrip api={api} user={user} store={store}/>:null}
    {!archive&&folders.folders.length?<FolderTabs position={folderPos} folders={folders.folders} filter={filter} unread={unread} onChange={setFilter} onCreate={()=>setEditor({folder:null})} onEdit={folder=>setEditor({folder})}/>:null}
    <FolderEditor visible={!!editor} folder={editor?.folder||null} chats={store.chats} api={api} onClose={()=>setEditor(null)} onSave={folder=>{folders.upsert(folder);setFilter(folder.id);setEditor(null);}} onDelete={id=>{folders.remove(id);setEditor(null);}}/>
    {/* Security notices (recovery request, new sign-in) and real errors sit here, in the list's flow — never under the status bar. Offline shows nothing here: the title says it. */}
    {banner}
    {store.error?<View style={{paddingHorizontal:17,paddingBottom:12}}><Notice text={store.error} error onRetry={()=>void refresh()}/></View>:null}
  </>;
  return <View style={{flex:1,backgroundColor:'transparent'}}>
    {/* Phone, like Telegram: the header (title, search, folders) floats over the list, which scrolls under it
        and fades/blurs out there instead of being cut at a hard edge. Desktop keeps it in the flow. */}
    {float?<FloatingHeader onHeight={setHeaderHeight}>{header}</FloatingHeader>:header}
    {store.listLoading?<View style={{flex:1,overflow:'hidden',paddingTop:float?headerHeight+LIST_GAP:0,...(float?bleed.style:null)}}>{filter==='all'&&!archive?<SavedRow count={store.saved.items.length} last={store.saved.items[store.saved.items.length-1]} selected={savedActive} onPress={onSaved}/>:null}<ChatListSkeleton/></View>:nativeOn&&NativeChatListView?<View style={[{flex:1},float?bleed.style:null]}>{plateIds.filter(id=>!plates[id]).map(id=><NameplateBake key={id} plate={id} onReady={plateReady}/>)}{frameIds.filter(id=>!plates[id]).map(id=><FrameBake key={id} id={id} onReady={plateReady}/>)}<NativeChatListView style={{flex:1}} rows={nativeRows} palette={nativePalette} headers={nativeHeaders} plates={plates} onRowAction={e=>nativeAction(e.nativeEvent.id,e.nativeEvent.action)} pad={[float?headerHeight+LIST_GAP:0,(rail||editing?12:tabsHeight+12)+(float?bleed.bottom:0)]} onRowPress={e=>nativePress(e.nativeEvent.id)} onRowLongPress={e=>nativeLongPress(e.nativeEvent.id,e.nativeEvent.y)}/></View>:<GestureDetector gesture={folderSwipe}><Animated.View style={[listFollow,float?bleed.style:null]}><FlatList ref={listRef} onLayout={e=>{const {width:w,height}=e.nativeEvent.layout;if(w>0)listWidth.value=w;const h=Math.round(height);if(h&&h!==listH)setListH(h);}} onContentSizeChange={(_w,h)=>{contentH.current=h;tryHideArchive();}} onScrollBeginDrag={e=>{closeOpenSwipeRow();dragFrom.current=e.nativeEvent.contentOffset.y;dragAt.current=Date.now();}} onScrollEndDrag={e=>{searchGesture(e.nativeEvent.contentOffset.y);const v=e.nativeEvent.velocity?.y||0;if(Math.abs(v)>0.3){listOffset.current=e.nativeEvent.contentOffset.y;return;}settleArchive(e.nativeEvent.contentOffset.y);}} onMomentumScrollEnd={e=>settleArchive(e.nativeEvent.contentOffset.y)} style={{flex:1}} scrollIndicatorInsets={float?{top:headerHeight+LIST_GAP,bottom:tabsHeight}:undefined} progressViewOffset={float?headerHeight:undefined} data={chats} keyExtractor={item=>item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" alwaysBounceVertical contentContainerStyle={{paddingTop:float?headerHeight+LIST_GAP:0,paddingBottom:(rail||editing?12:tabsHeight+12)+(float?bleed.bottom:0),flexGrow:1,minHeight:topRow&&archiveH&&listH?listH+archiveH:undefined}} ListHeaderComponent={archive?<Pressable onPress={()=>setArchive(false)} accessibilityRole="button" style={{flexDirection:'row',alignItems:'center',gap:8,padding:12}}><Icon name="chevron-back" size={18} color={t.accent}/><Text style={{color:t.accent,fontSize:15,fontWeight:'700'}}>Архив</Text></Pressable>:<>{topRow?<View onLayout={e=>{const h=Math.round(e.nativeEvent.layout.height);if(h&&h!==archiveH)setArchiveH(h);}}>{archiveRow?<Pressable onPress={()=>{closeOpenSwipeRow();setArchive(true);}} accessibilityRole="button" accessibilityLabel={`Архив, чатов: ${archivedCount}`} style={({pressed})=>({flexDirection:'row',gap:13,alignItems:'center',paddingHorizontal:16,paddingVertical:12,borderRadius:24,backgroundColor:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent'})}><View style={{width:54,height:54,borderRadius:19,backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}}><Icon name="archive" color={t.muted} size={24}/></View><View style={{flex:1}}><Text style={{color:t.text,fontSize:15,fontWeight:'700'}}>Архив</Text><Text style={{color:t.muted,fontSize:12}}>{countChats(archivedCount)}</Text></View></Pressable>:null}</View>:null}{menuError?<View style={{paddingBottom:8}}><Notice text={menuError} error/></View>:null}{filter==='all'&&(!query||'избранное'.includes(query.toLowerCase()))?<SavedRow count={store.saved.items.length} last={store.saved.items[store.saved.items.length-1]} selected={savedActive} onPress={onSaved}/>:null}</>} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>void refresh()} tintColor={t.accent}/>} ListEmptyComponent={<View style={{flex:1,justifyContent:'center',paddingBottom:20}}>{query?<Empty icon="search-outline" title="Чат не найден" description="Попробуй другое имя или найди человека по @имени." action={<Button label="Найти собеседника" onPress={onNewChat} icon="add"/>}/>:filter==='unread'?<Empty icon="checkmark-done-outline" title="Всё прочитано" description="Здесь появятся чаты с новыми сообщениями и отмеченные как непрочитанные."/>:filter!=='all'||archive?<Empty icon="folder-open-outline" title="Здесь пока пусто" description={archive?'В архиве нет чатов.':'В этой папке нет чатов. Добавь их в настройках папки.'}/>:<Empty icon="chatbubbles-outline" title="Начни разговор" description="Найди своего человека по @имени. Всё начинается с простого «привет»." action={<Button label="Найти собеседника" onPress={onNewChat} icon="add"/>}/>}</View>}
      renderItem={({item,index})=>{const section=archive||filter!=='all'||editing?'':listSection(item)!==(index>0?listSection(chats[index-1]):'')?listSection(item):'';return <>{section?<ListSection text={section}/>:null}<ChatListItem chat={item} marked={marked.has(item.id)} api={api} userId={user.id} editable={!editing} selected={wideLayout&&store.selectedId===item.id} idle={!store.selectedId} typing={!!store.typing[item.id]} muted={isMuted(item.settings)} checked={editing?editing.has(item.id):undefined} actions={rowActionsRef}/></>;}}/></Animated.View></GestureDetector>}
    {editing?<GlassSurface lens material="regular" radius={26} style={{marginHorizontal:16,marginBottom:6}} contentStyle={{flexDirection:'row',justifyContent:'space-around',alignItems:'center',minHeight:52}}>
      <Pressable onPress={()=>bulk(readChat)} accessibilityRole="button" style={{padding:10}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{selectedChats.length?'Прочитать':'Прочитать все'}</Text></Pressable>
      {/* One chosen person is an ordinary call; several become a room and everyone is called at once. */}
      <Pressable disabled={!selectedChats.length} onPress={callSelected} accessibilityRole="button" accessibilityLabel="Позвонить выбранным" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{selectedChats.length>1?`Звонок · ${selectedChats.length}`:'Звонок'}</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>bulk(chat=>change(chat,{archived:!archive}))} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{archive?'Из архива':'В архив'}</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>setRemoveAsk(selectedChats)} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.danger,fontSize:14,fontWeight:'600'}}>Удалить</Text></Pressable>
    </GlassSurface>:null}
    <RemoveChatSheet chats={removeAsk} onClose={()=>setRemoveAsk(null)} onRemove={list=>{setEditing(null);list.forEach(chat=>store.removeChat(chat));}} onRemoveForEveryone={list=>{setEditing(null);void Promise.all(list.map(chat=>store.removeChatForEveryone(chat))).catch(e=>store.setError(e instanceof Error?e.message:'Не удалось удалить чат. Попробуй ещё раз.'));}}/>
    <MuteSheet visible={!!muteAsk} title={muteAsk&&muteAsk.length>1?countChats(muteAsk.length):muteAsk?.[0]?.peer.displayName||''} current={muteAsk&&muteAsk.length===1?muteAsk[0].settings:null} onClose={()=>setMuteAsk(null)} onMute={until=>{if(muteAsk)mute(muteAsk,until);}} onUnmute={()=>{const list=muteAsk||[];setMuteAsk(null);list.forEach(c=>change(c,{muted:false}));}}/>
    {/* A hold on «Избранное»: open it, or clear it completely (asked once more, it cannot be undone). */}
    <ContextMenu visible={!!savedMenu} y={savedMenu?.y||0} onClose={()=>setSavedMenu(null)} preview="Избранное">
      <MenuItem icon="bookmark-outline" label="Открыть" onPress={()=>{setSavedMenu(null);onSaved();}}/>
      <MenuItem separated icon="trash-outline" danger label="Очистить Избранное" onPress={()=>{setSavedMenu(null);setTimeout(()=>setSavedClear(true),CLOSE_MS+110);}}/>
    </ContextMenu>
    <Sheet visible={savedClear} title="Очистить Избранное?" onClose={()=>setSavedClear(false)}>
      <Text style={{color:t.muted,fontSize:14,lineHeight:20,marginBottom:14}}>Все заметки, файлы и голосовые из Избранного будут удалены с этого устройства. Вернуть их нельзя.</Text>
      <View style={{gap:8}}><Button danger secondary icon="trash-outline" label={`Удалить всё: ${store.saved.items.length}`} disabled={!store.saved.items.length} onPress={()=>{setSavedClear(false);void store.saved.clear().catch(()=>{});}}/><Button secondary label="Отмена" onPress={()=>setSavedClear(false)}/></View>
    </Sheet>
    <ContextMenu visible={!!menu} y={menu?.y||0} x={menu?.x} onClose={()=>setMenu(null)} preview={menu?.chat.peer.displayName} peek={menu?<ChatPeek chat={menu.chat} api={api} userId={user.id} messages={store.messages[menu.chat.id]}/>:undefined}>
      {menu?<>
        {showsUnread(menu.chat,marked)?<MenuItem icon="chatbubble-outline" label="Пометить как прочитанное" onPress={()=>{const chat=menu.chat;setMenu(null);lightFeedback();readChat(chat);}}/>:<MenuItem icon="chatbubble" label="Пометить как непрочитанное" onPress={()=>markUnread(menu.chat)}/>}
        <MenuItem icon={menu.chat.settings?.pinnedAt?'pin':'pin-outline'} label={menu.chat.settings?.pinnedAt?'Открепить':'Закрепить'} onPress={()=>change(menu.chat,{pinned:!menu.chat.settings?.pinnedAt})}/>
        <MenuItem icon={isMuted(menu.chat.settings)?'notifications-outline':'notifications-off-outline'} label={isMuted(menu.chat.settings)?'Включить звук':'Выключить звук'} onPress={()=>askMute([menu.chat])}/>
        <MenuItem icon="archive-outline" label={menu.chat.settings?.archived?'Вернуть из архива':'В архив'} onPress={()=>change(menu.chat,{archived:!menu.chat.settings?.archived})}/>
        <MenuItem icon="trash-outline" label="Удалить чат" danger onPress={()=>{const chat=menu.chat;setMenu(null);setRemoveAsk([chat]);}}/>
      </>:null}
    </ContextMenu>
    {/* The bottom scroll-edge effect behind the floating tab bar (the other tabs get it from TabsOverlay). */}
    {editing||rail?null:<TabBarEdge bar={tabsHeight}/>}
    {editing||sharedTabs?null:rail?<><VoiceBar onOpen={communityId=>navigate({to:'channels',communityId})}/><MiniPlayer onOpen={onMusic}/></>:<View pointerEvents="box-none" onLayout={e=>{const h=Math.round(e.nativeEvent.layout.height);if(h&&Math.abs(h-tabsHeight)>1)setTabsHeight(h);}} style={{position:'absolute',left:0,right:0,bottom:0}}><MessengerTabs onProfile={onProfile} onNewChat={onNewChat} onMusic={onMusic} onAI={onAI} onChats={onChats} activeTab={activeTab}/></View>}
  </View>;
}

export function MessengerTabs({onProfile,onNewChat,onMusic,onAI,onChats,activeTab='chats'}: Navigation) {
  const t=useTheme();const insets=useSafeAreaInsets();const tabBadges:Record<string,number>=useTabBadges(useUnreadTotal()+useMarkedExtra());
  const roomsAwake=useRoomsAwake();
  const narrow=useWindowDimensions().width<350; // e.g. 320 pt phones, a folded Galaxy Fold cover screen
  // The music screen shows its own player above the same tab bar; everywhere else it sits here, above the tabs.
  return <><VoiceBar onOpen={communityId=>navigate({to:'channels',communityId})}/>{activeTab!=='music'?<MiniPlayer onOpen={onMusic}/>:null}<SnowLedge id="tabs" radius={31} max={7} inset={{left:narrow?8:12,right:narrow?8:12,top:5,bottom:tabBarMarginBottom(Platform.OS==='ios',insets.bottom)}}><GlassSurface pure lens material="regular" radius={31} style={{marginHorizontal:narrow?8:12,marginBottom:tabBarMarginBottom(Platform.OS==='ios',insets.bottom),marginTop:5}} contentStyle={{paddingHorizontal:3.6,paddingVertical:3}}>{/* 3.6 at the ends: the pill of the first and last tab then sits as far from the bar's end as from its top and bottom (6.6 pt), concentric with the bar's rounded ends (simulator: 5 pt vs 6.7 pt with 2) */}
    {/* «Люди» and «Каналы» share one slot (swipe up on it to switch, remembered); five tabs, each with its own tap animation. */}
    <TabBar active={activeTab==='people'?'people':activeTab==='channels'?'channels':activeTab==='profile'?'profile':activeTab==='music'?'music':activeTab==='ai'?'ai':'chats'} items={[
      {id:'ai',label:'AI',icon:'sparkles-outline',activeIcon:'sparkles',badge:0,onPress:onAI},
      {id:'people',label:'Люди',icon:'people-outline',activeIcon:'people',badge:tabBadges.people||0,onPress:onNewChat},
      {id:'channels',label:'Каналы',icon:'planet-outline',activeIcon:'planet',badge:tabBadges.channels||0,dot:roomsAwake?'#3EE08E':undefined,onPress:()=>navigate({to:'channels'})},
      {id:'chats',label:'Чаты',icon:'chatbubbles-outline',activeIcon:'chatbubbles',badge:tabBadges.chats||0,onPress:onChats},
      {id:'music',label:'Музыка',icon:'headset-outline',activeIcon:'headset',badge:0,onPress:onMusic},
      {id:'profile',label:'Настройки',icon:'settings-outline',activeIcon:'settings',badge:0,onPress:onProfile},
    ]}/>
  </GlassSurface></SnowLedge></>;
}

/** The list shows an invite as words, as the chat shows it as a card (not the raw https://…/i/… link). */
function listText(text: string | undefined): string {
  if (!text) return '';
  if (!inviteCodeFrom(text)) return text;
  return withoutInviteLink(text).trim() || '🔗 Приглашение на сервер';
}

type RowActions={editing:boolean;swipe:(chat:Chat,action:RowAction)=>void;toggleEdit:(chat:Chat)=>void;select:(chat:Chat)=>void;menu:(chat:Chat,y:number,x?:number)=>void};
/** One list row with stable props (primitives, the chat object and a ref): memo skips it when another chat changes. */
const ChatListItem=memo(function ChatListItem({chat,marked,api,userId,editable,selected,idle,typing,muted,checked,actions}:{chat:Chat;marked:boolean;api:Api;userId:string;editable:boolean;selected:boolean;idle:boolean;typing:boolean;muted:boolean;checked?:boolean;actions:React.MutableRefObject<RowActions>}) {
  const onAction=useCallback((action:RowAction)=>actions.current.swipe(chat,action),[actions,chat]);
  // Telegram: with another row's buttons open, a tap on a chat only closes them.
  const onPress=useCallback(()=>{if(closeOpenSwipeRow())return;const a=actions.current;if(a.editing)a.toggleEdit(chat);else a.select(chat);},[actions,chat]);
  const onLongPress=useCallback((y:number,x?:number)=>{closeOpenSwipeRow();actions.current.menu(chat,y,x);},[actions,chat]);
  return <SwipeRow enabled={editable} muted={muted} unread={chat.unreadCount>0||marked} pinned={!!chat.settings?.pinnedAt} archived={!!chat.settings?.archived} onAction={onAction}><ChatRow key={idle?'idle':'open'} chat={chat} marked={marked} api={api} userId={userId} selected={selected} typing={typing} muted={muted} checked={checked} onPress={onPress} onLongPress={onLongPress}/></SwipeRow>;
});

function ChatRow({chat,marked,api,userId,selected,typing,muted,checked,onPress,onLongPress}: {chat:Chat;marked:boolean;api:Api;userId:string;selected:boolean;typing:boolean;muted:boolean;checked?:boolean;onPress:()=>void;onLongPress:(y:number,x?:number)=>void}) {
  const t=useTheme();const last=chat.lastMessage;
  // Desktop: right click opens the chat menu at the cursor.
  const ref=useRef<View>(null);const longRef=useRef(onLongPress);longRef.current=onLongPress;
  useEffect(()=>{const node=ref.current as unknown as HTMLElement|null;if(Platform.OS!=='web'||!node?.addEventListener)return;const menu=(e:MouseEvent)=>{e.preventDefault();longRef.current(e.clientY,e.clientX);};node.addEventListener('contextmenu',menu);return()=>node.removeEventListener('contextmenu',menu);},[]);
  // chatListText hides spoilers (▒) also for a chat whose page is not loaded (the server's lastMessage).
  // A finished call (F9) reads with its direction, as the chat shows it: «Пропущенный звонок», «Исходящий звонок · 3:12».
  const preview=typing?'Печатает…':last?(callListText(last,userId)??(last.meta?.action?.type==='pin'&&last.meta.action.target?pinPreview(listText(chatListText(last))||'',last.senderId===userId,chat.peer.displayName):`${listText(chatListText(last))|| (last.attachment?attachmentLabel(last.attachment):'Сообщение')}`)):'Напиши первое сообщение';
  // Telegram: a round video, photo or video shows its own small thumbnail before the label (from the
  // encrypted preview inside the message), and a round video reads just «Видеосообщение».
  const media=!typing&&last&&!listText(chatListText(last))&&last.attachment&&!callListText(last,userId)?last.attachment:null;
  const note=!!media&&isVideoNote(media);
  const thumb=media?.preview&&(note||media.mimeType.startsWith('image/')||media.mimeType.startsWith('video/'))?`data:${media.preview.mimeType};base64,${media.preview.base64}`:null;
  const shown=thumb&&media?(note?'Видеосообщение':media.mimeType.startsWith('image/')?'Фотография':'Видео'):preview;
  // A timed mute ends by the clock, not by a refresh. As in Telegram the row shows only the crossed bell;
  // when the sound comes back is said in the profile («Без звука · до 18:30») and to the screen reader here.
  const pinned=!!chat.settings?.pinnedAt;
  const quietLabel=muted?`, без звука${chat.settings?.mutedUntil?` ${muteUntilLabel(chat.settings.mutedUntil)}`:''}`:'';
  // On a nameplate (dark art) the row's text is light, also in the light theme (it was dark on dark).
  const onPlate=!!chat.peer.nameplate&&!t.dark;
  const c=onPlate?{text:'#FFFFFF',muted:'rgba(255,255,255,0.8)',subtle:'rgba(255,255,255,0.62)'}:{text:t.text,muted:t.muted,subtle:t.subtle};
  return <View ref={ref}><Pressable onPress={onPress} onLongPress={event=>onLongPress(event.nativeEvent.pageY)} delayLongPress={450} accessibilityRole="button" accessibilityLabel={`${chat.peer.displayName}${chat.unreadCount?`, непрочитанных ${chat.unreadCount}`:marked?', помечен как непрочитанный':''}${quietLabel}`} style={({pressed})=>({flexDirection:'row',gap:12,paddingLeft:16,paddingRight:16,paddingVertical:8,backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.05)'):'transparent'})}>{chat.peer.nameplate?<View pointerEvents="none" style={{position:'absolute',left:10,right:10,top:3,bottom:3}}><Nameplate plate={chat.peer.nameplate} radius={20}/></View>:null}{checked!==undefined?<View style={{justifyContent:'center'}}><Icon name={checked?'checkmark-circle':'ellipse-outline'} size={24} color={checked?t.accent:chat.peer.nameplate?'#FFFFFF':c.subtle}/></View>:null}<DecoratedAvatar user={chat.peer} api={api} size={60}/><View style={{flex:1,justifyContent:'center',gap:3,paddingBottom:8,marginBottom:-8,minHeight:68}}><View style={{flexDirection:'row',gap:5,alignItems:'center'}}><View style={{flex:1,flexDirection:'row',alignItems:'center',gap:5}}><PlatinaName user={chat.peer} animated={false} onDark={onPlate} style={{flexShrink:1,color:c.text,fontSize:16,fontWeight:'600',letterSpacing:-.2}}/><StatusEmoji user={chat.peer} size={15}/>{muted?<Icon name="notifications-off" size={13} color={c.subtle}/>:null}</View>{last?<Text style={{color:(chat.unreadCount||marked)&&!muted?t.accent:c.muted,fontSize:14}}>{formatListTime(last.createdAt)}</Text>:null}</View><View style={{flexDirection:'row',alignItems:'center',gap:6}}>{thumb?<Image source={{uri:thumb}} style={{width:20,height:20,borderRadius:note?10:4,alignSelf:'flex-start',marginTop:0}} fadeDuration={0}/>:null}<Text numberOfLines={2} style={{flex:1,color:typing?t.accent:c.muted,fontSize:15,lineHeight:19,fontWeight:typing?'600':'400'}}>{shown}</Text>{chat.unreadCount>0?<View style={{minWidth:22,height:22,borderRadius:11,backgroundColor:muted?c.subtle:t.accent,alignItems:'center',justifyContent:'center',paddingHorizontal:6}}><Text maxFontSizeMultiplier={1} style={{color:t.onAccent,fontSize:12,fontWeight:'700'}}>{badgeText(chat.unreadCount)}</Text></View>:marked?<View style={{width:22,height:22,borderRadius:11,backgroundColor:muted?c.subtle:t.accent}}/>:pinned?<Icon name="pin" size={14} color={c.subtle}/>:last?.senderId===userId?<Icon name={chat.peerLastReadMessageId>=last.id?'checkmark-done':'checkmark'} size={16} color={chat.peerLastReadMessageId>=last.id?t.accent:c.subtle}/>:null}</View></View></Pressable></View>;
}

function SavedRow({count,last,selected,onPress}:{count:number;last?:SavedItem;selected:boolean;onPress:()=>void}) {
  const t=useTheme();
  const preview=last?(listText(last.text)||(last.attachment?attachmentLabel(last.attachment):'Запись')):'Заметки, файлы и сохранённые сообщения';
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Избранное, записей: ${count}`} style={({pressed})=>({flexDirection:'row',gap:12,paddingLeft:16,paddingRight:16,paddingVertical:8,backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.05)'):'transparent'})}><View style={{width:60,height:60,borderRadius:30,backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="bookmark" color={t.onAccent} size={26}/></View><View style={{flex:1,justifyContent:'center',gap:3,paddingBottom:8,marginBottom:-8,minHeight:68}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{flex:1,color:t.text,fontSize:16,fontWeight:'600',letterSpacing:-.2}}>Избранное</Text>{last?<Text style={{color:t.muted,fontSize:14}}>{formatListTime(last.savedAt)}</Text>:null}</View><Text numberOfLines={2} style={{color:t.muted,fontSize:15,lineHeight:19}}>{preview}</Text></View></Pressable>;
}

/** Long-press on a chat, as in Telegram: a card with the chat itself (header and the latest messages) above the menu. */
function ChatPeek({chat,api,userId,messages}:{chat:Chat;api:Api;userId:string;messages?:Message[]}) {
  const t=useTheme();const {height}=useWindowDimensions();
  // Edits and deletions applied as in the chat itself (actions and call signalling are not bubbles).
  const shown=(messages?.length?foldChat(messages,userId).messages:chat.lastMessage?[chat.lastMessage].filter(m=>!skippedInList(m)):[]).slice(-14);
  return <View style={{height:Math.min(440,Math.round(height*0.5)),borderRadius:24,overflow:'hidden',backgroundColor:t.bg,borderWidth:StyleSheet.hairlineWidth,borderColor:t.border}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:14,paddingVertical:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:t.border}}>
      <Avatar user={chat.peer} api={api} size={36}/>
      <View style={{flex:1}}><Text numberOfLines={1} style={{color:t.text,fontSize:15,fontWeight:'700'}}>{chat.peer.displayName}</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>@{chat.peer.username}</Text></View>
    </View>
    <View style={{flex:1,justifyContent:'flex-end',paddingHorizontal:10,paddingBottom:10,gap:4}}>
      {shown.length?shown.map(m=>{const mine=m.senderId===userId;return <View key={m.clientId||m.id} style={{alignSelf:mine?'flex-end':'flex-start',maxWidth:'82%',borderRadius:16,paddingHorizontal:10,paddingVertical:6,backgroundColor:mine?t.bubble:t.incoming}}>
        <Text numberOfLines={4} raw style={{color:t.text,fontSize:14,lineHeight:19}}>{callListText(m,userId)??(listText(chatListText(m))||(m.attachment?attachmentLabel(m.attachment):'Сообщение'))}</Text>
      </View>;}):<Text style={{color:t.muted,textAlign:'center',marginBottom:20}}>Сообщений пока нет</Text>}
    </View>
  </View>;
}

/** The row whose swipe buttons are open (one at a time, as in Telegram): opening another closes it. */
const openRows=openRowSlot();
/** Close the open row, if any (a tap on another row, a scroll, a folder change). True when one was open. */
function closeOpenSwipeRow():boolean{return openRows.closeOpen();}
/** 1 while a finger is down on a chat row that can swipe: the folder swipe on the list then stands aside. */
const rowTouch=makeMutable(0);
/** Where the finger went down on a swipeable row (pt from its left), the row's width and whether it stands open. */
const rowStart=makeMutable({local:0,width:0,open:false});
/** Folder turns possible from the list on screen: bit 1 back, bit 2 forward; 0 — rows keep every sideways drag. */
const folderWays=makeMutable(0);
/** What a swipe can do. «Непрочитано» has no server endpoint: it is a device-local mark (src/markedUnread.ts). */
const ROW_SUPPORT:RowSupport={markUnread:true,pin:true,archive:true};
const MUTE_ORANGE='#FF9500',PIN_GREEN='#34C759',ARCHIVE_GREY='#8E8E93';
type ButtonLook={icon:React.ComponentProps<typeof Icon>['name'];label:string;color:string;iconColor:string};
function buttonLook(action:RowAction,t:ReturnType<typeof useTheme>):ButtonLook{
  // Telegram's orange for «Выключить звук», green for «Закрепить», grey for «Архив»; the icon on them is white as there.
  // Dark themes have a light danger tone and accent: the icon on those is dark, as text on the accent.
  switch(action){
    case 'read':return {icon:'chatbubble',label:'Прочитано',color:t.accent,iconColor:t.onAccent};
    case 'unread':return {icon:'chatbubble-outline',label:'Непрочитано',color:t.accent,iconColor:t.onAccent};
    case 'pin':return {icon:'pin',label:'Закрепить',color:PIN_GREEN,iconColor:'#FFF'};
    case 'unpin':return {icon:'pin-outline',label:'Открепить',color:PIN_GREEN,iconColor:'#FFF'};
    case 'mute':return {icon:'notifications-off',label:'Выключить звук',color:MUTE_ORANGE,iconColor:'#FFF'};
    case 'unmute':return {icon:'notifications',label:'Включить звук',color:MUTE_ORANGE,iconColor:'#FFF'};
    case 'delete':return {icon:'trash',label:'Удалить',color:t.danger,iconColor:t.dark?t.bg:'#FFF'};
    case 'archive':return {icon:'archive',label:'В архив',color:ARCHIVE_GREY,iconColor:'#FFF'};
    case 'unarchive':return {icon:'archive-outline',label:'Вернуть',color:ARCHIVE_GREY,iconColor:'#FFF'};
  }
}

/**
 * A Telegram swipe button: a coloured capsule with its label under it, growing in as the row slides.
 * `side` is -1 for the buttons a left swipe shows, 1 for a right swipe; `order` 0 is the leading
 * (outermost) button, which a full swipe performs: the others then fade and it grows.
 */
function SwipeButton({action,x,side,order,open,armed,onPress}:{action:RowAction;x:SharedValue<number>;side:-1|1;order:number;open:number;armed:SharedValue<number>;onPress:()=>void}) {
  const t=useTheme();const look=buttonLook(action,t);
  const style=useAnimatedStyle(()=>{
    const d=side*x.value;const p=Math.min(1,Math.max(0,(d-order*ROW_GAP*2)/(Math.max(open,1)*0.75)));
    const on=armed.value===side;
    return {opacity:on&&order>0?0:p,transform:[{scale:(0.5+0.5*p)*(on&&order===0?1.12:1)}]};
  });
  return <Animated.View style={[{width:ROW_BUTTON,alignItems:'center',gap:4},style]}>
    <Pressable accessibilityRole="button" accessibilityLabel={look.label} onPress={onPress} hitSlop={4} style={({pressed})=>({width:ROW_BUTTON,height:42,borderRadius:21,backgroundColor:look.color,alignItems:'center',justifyContent:'center',opacity:pressed?.75:1})}><Icon name={look.icon} size={21} color={look.iconColor}/></Pressable>
    {/* The label sits on the row background, so it takes the theme's secondary text (a fixed grey read at 2.5:1 on the light theme). */}
    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1} style={{width:ROW_BUTTON+ROW_GAP,textAlign:'center',color:t.muted,fontSize:10,fontWeight:'600'}}>{look.label}</Text>
  </Animated.View>;
}

/**
 * Telegram swipes on a chat (logic in src/listSwipes.ts). Left slides the row to reveal «Выключить
 * звук · Удалить · В архив»; right reveals «Прочитано» (unread chats) or «Непрочитано» (read ones, a device-local mark) and «Закрепить». The row stays
 * open until a button, a tap on it or elsewhere, a scroll or a swipe back closes it; one row is open
 * at a time. Dragging on past ~60% of the row performs the outermost button (with a haptic tick),
 * as a full swipe does in Telegram.
 */
function SwipeRow({enabled,unread,pinned,muted,archived,onAction,children}:{enabled:boolean;unread:boolean;pinned:boolean;muted:boolean;archived:boolean;onAction:(action:RowAction)=>void;children:React.ReactNode}) {
  const {width:windowWidth}=useWindowDimensions();
  const x=useSharedValue(0);const start=useSharedValue(0);const armed=useSharedValue(0);const rowWidth=useSharedValue(windowWidth);const [open,setOpen]=useState(false);
  const {left,right}=rowActions({unread,pinned,muted,archived},ROW_SUPPORT);
  const leftOpen=openWidth(left.length),rightOpen=openWidth(right.length);
  const actionRef=useRef(onAction);actionRef.current=onAction;
  const leadRef=useRef({left:left[0],right:right[0]});leadRef.current={left:left[0],right:right[0]};
  const motion=motionEnabled();
  const SPRING={damping:24,stiffness:300,mass:0.8};
  // The shared slot knows this row by `closeHandle`: one function for the row's whole life. (A fresh wrapper per open
  // was never recognised as this row's, the slot stayed taken and every later tap on a chat only «closed» it.)
  const closeSelf=useRef<()=>void>(()=>{});const closeHandle=useRef(()=>closeSelf.current()).current;
  const close=()=>{x.value=motion?withSpring(0,SPRING):0;setOpen(false);openRows.release(closeHandle);};
  closeSelf.current=close;
  useEffect(()=>()=>openRows.release(closeHandle),[closeHandle]);
  const claim=()=>openRows.closeOthers(closeHandle);
  const opened=()=>{openRows.open(closeHandle);setOpen(true);};
  const full=(side:-1|1)=>{const action=side<0?leadRef.current.left:leadRef.current.right;close();if(action)actionRef.current(action);};
  // Activated by hand: a sideways drag is the row's only from its edge (or anywhere when it is open / no folder
  // lies that way); from the middle it is left to the folder pager. Up/down is the list's scroll.
  const down=useSharedValue({x:0,y:0});
  const pan=Gesture.Pan().enabled(enabled).activeOffsetX([-12,12]).failOffsetY([-10,10])
    .onBegin(()=>{rowTouch.value=1;})
    .onFinalize(()=>{rowTouch.value=0;})
    .onTouchesDown((e,manager)=>{const touch=e.changedTouches[0];if(!touch||e.numberOfTouches>1){manager.fail();return;}down.value={x:touch.absoluteX,y:touch.absoluteY};rowStart.value={local:touch.x,width:rowWidth.value,open:x.value!==0};})
    .onTouchesMove((e,manager)=>{
      if(e.state===State.ACTIVE)return;
      const touch=e.changedTouches[0];if(!touch)return;
      const dx=touch.absoluteX-down.value.x;if(Math.abs(dx)<3)return;
      // From the middle of the row the drag is the folder pager's (see folderSwipe for why this is not manual activation).
      if(!rowClaimsSwipe(rowStart.value.local,rowStart.value.width,dx,rowStart.value.open,(folderWays.value&1)!==0,(folderWays.value&2)!==0))manager.fail();
    })
    .onStart(()=>{start.value=x.value;runOnJS(claim)();})
    .onUpdate(e=>{
      const v=rowDrag(start.value+e.translationX,leftOpen,rightOpen,rowWidth.value);x.value=v;
      const side=v<0&&v<=-fullSwipeDistance(rowWidth.value,leftOpen)?-1:v>0&&v>=fullSwipeDistance(rowWidth.value,rightOpen)?1:0;
      if(side!==armed.value){armed.value=side;if(side)runOnJS(impactFeedback)();}
    })
    .onEnd(e=>{
      const release=rowRelease(x.value,e.velocityX,leftOpen,rightOpen,fullSwipeDistance(rowWidth.value,leftOpen),fullSwipeDistance(rowWidth.value,rightOpen));
      armed.value=0;
      if(release==='full-left'||release==='full-right'){runOnJS(full)(release==='full-left'?-1:1);return;}
      const to=release==='open-left'?-leftOpen:release==='open-right'?rightOpen:0;
      x.value=motion?withSpring(to,{...SPRING,velocity:e.velocityX}):to;
      if(to)runOnJS(opened)();else runOnJS(close)();
    });
  const row=useAnimatedStyle(()=>({transform:[{translateX:x.value}]}));
  const act=(action:RowAction)=>()=>{close();actionRef.current(action);};
  return <GestureDetector gesture={pan}><View onLayout={e=>{const w=e.nativeEvent.layout.width;if(w>0)rowWidth.value=w;}}>
    {left.length?<View style={{position:'absolute',top:0,bottom:0,right:0,flexDirection:'row',alignItems:'center',gap:ROW_GAP,paddingRight:ROW_GAP}}>
      {/* Leading button at the edge: «Выключить звук · Удалить · В архив». */}
      {left.map((action,order)=>({action,order})).reverse().map(({action,order})=><SwipeButton key={action} action={action} x={x} side={-1} order={order} open={leftOpen} armed={armed} onPress={act(action)}/>)}
    </View>:null}
    {right.length?<View style={{position:'absolute',top:0,bottom:0,left:0,flexDirection:'row',alignItems:'center',gap:ROW_GAP,paddingLeft:ROW_GAP}}>
      {right.map((action,order)=><SwipeButton key={action} action={action} x={x} side={1} order={order} open={rightOpen} armed={armed} onPress={act(action)}/>)}
    </View>:null}
    <Animated.View style={row}>{children}{open?<Pressable accessibilityLabel="Закрыть кнопки" onPress={close} style={StyleSheet.absoluteFill}/>:null}</Animated.View>
  </View></GestureDetector>;
}

/**
 * Desktop: sections live in a narrow rail on the left (as Telegram Desktop folders and
 * Discord servers), not in a phone tab bar squeezed under the chat list.
 */
export function DesktopRail({api,user,unread,onProfile,onNewChat,onMusic,onAI,onChats,onSettings,activeTab='chats'}: Navigation&{api:Api;user:User;unread:number;onSettings:()=>void}) {
  const t=useTheme();
  const items=[{id:'chats',label:'Чаты',icon:'chatbubbles-outline',active:'chatbubbles',onPress:onChats},{id:'people',label:'Люди',icon:'people-outline',active:'people',onPress:onNewChat},{id:'channels',label:'Каналы',icon:'planet-outline',active:'planet',onPress:()=>navigate({to:'channels'})},{id:'music',label:'Музыка',icon:'headset-outline',active:'headset',onPress:onMusic},{id:'ai',label:'AI',icon:'sparkles-outline',active:'sparkles',onPress:onAI}] as const;
  const tabBadges=useTabBadges(unread+useMarkedExtra());const badges:Record<string,number>=tabBadges;
  const button=(id:string,label:string,icon:React.ComponentProps<typeof Icon>['name'],onPress:()=>void,badge=0,a11y=label,word='непрочитанных')=>{const on=activeTab===id;return <Pressable key={id} onPress={onPress} accessibilityRole="tab" accessibilityLabel={badge?`${a11y}, ${word}: ${badge}`:a11y} accessibilityState={{selected:on}}
    style={(state)=>{const hovered=(state as {hovered?:boolean}).hovered;return {width:64,paddingVertical:8,borderRadius:16,alignItems:'center',gap:4,backgroundColor:on?t.accentSoft:hovered?(t.dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.04)'):'transparent',opacity:state.pressed?.7:1};}}>
    {on?<View style={{position:'absolute',left:-6,top:14,bottom:14,width:3,borderRadius:2,backgroundColor:t.accent}}/>:null}
    <View><Icon name={icon} size={23} color={on?t.accent:t.muted}/>{badge?<View style={{position:'absolute',top:-7,left:13,minWidth:18,height:18,paddingHorizontal:5,borderRadius:9,borderWidth:2,borderColor:t.dark?'#15171D':'#FFF',backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Text style={{color:t.onAccent,fontSize:10,fontWeight:'800'}}>{badgeText(badge)}</Text></View>:null}</View>
    {label?<Text numberOfLines={1} style={{fontSize:11,color:on?t.accent:t.muted,fontWeight:on?'700':'600'}}>{label}</Text>:null}
  </Pressable>;};
  return <View accessibilityRole="tablist" style={{width:80,alignItems:'center',paddingTop:14,paddingBottom:14,gap:4,borderRightWidth:1,borderColor:t.border,backgroundColor:t.dark?'rgba(0,0,0,0.18)':'rgba(255,255,255,0.35)'}}>
    {items.map(item=>button(item.id,item.label,activeTab===item.id?item.active:item.icon,item.onPress,badges[item.id]||0,item.label,badgeWord[item.id]))}
    {button('profile','',activeTab==='profile'?'settings':'settings-outline',onSettings,0,'Настройки')}
    <View style={{flex:1}}/>
    <Pressable onPress={onProfile} accessibilityRole="button" accessibilityLabel="Мой профиль" style={{marginTop:6,borderRadius:22}}><Avatar user={user} api={api} size={40} round/></Pressable>
  </View>;
}

/** Badge numbers for the section tabs: unread chats, waiting friend requests. */
const badgeWord: Record<string, string> = { chats: 'непрочитанных', people: 'заявок в друзья', channels: 'непрочитанных' };
function useTabBadges(chats: number): Record<string, number> {
  const requests = incomingCount(useFriendRequests());
  return { chats, people: requests, channels: useChannelsBadge() };
}
