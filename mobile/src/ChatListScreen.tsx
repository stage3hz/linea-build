import { TabBar } from './TabBar';
import { badgeText, useUnreadTotal } from './unreadBadge';
import { inviteCodeFrom, withoutInviteLink } from './communities/types';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMeshActive } from './nearby/meshState';
import { PlatinaGem, PlatinaName, hasPlatina } from './platina/PlatinaMark';
import { FolderEditor, FolderTabs, matchesFolder, useChatFolders, type ChatFolder, type FolderFilter } from './ChatFolders';
import { attachmentLabel } from './voice/voice';
import { motionEnabled } from './motion';
import { ActivityIndicator, FlatList, LayoutAnimation, Platform, Pressable, RefreshControl, StyleSheet, UIManager, View, useWindowDimensions } from 'react-native';
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) UIManager.setLayoutAnimationEnabledExperimental(true);
import { Text, TextInput } from './typography';
import { MiniPlayer } from './music/PlayerControls';
import { ChatListSkeleton } from './effects';
import { FloatingHeader, isWideLayout, useBleed } from './tabInset';
import { Avatar, Bouncy, Button, Empty, Icon, IconButton, Notice, Sheet, SheetAction } from './components';
import { GlassSurface } from './glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusEmoji } from './StatusEmoji';
import { DecoratedAvatar } from './platina/Decor';
import { navigate } from './navigation';
import { ChatSearch } from './ChatSearch';
import { Nameplate } from './platina/Effects';
import { VoiceBar } from './communities/VoiceBar';
import { formatListTime, useTheme } from './theme';
import type { Api } from './api';
import type { Chat, Message, User } from './types';
import { chatListText, isQuietAction, pinPreview } from './messageMeta';
import { countChats } from './plural';
import type { MessengerStore } from './useMessenger';
import type { SavedItem } from './saved/saved.ts';
import { ContextMenu, MenuItem } from './ContextMenu';
import { StoriesStrip } from './stories/StoriesStrip';
import { incomingCount, useFriendRequests } from './friendRequests';
import { useChannelsBadge } from './communities/unread';
import { impactFeedback, lightFeedback } from './haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';

export type MessengerTab = 'chats' | 'people' | 'channels' | 'music' | 'ai' | 'profile';
type Navigation = { onProfile:()=>void;onNewChat:()=>void;onMusic:()=>void;onAI:()=>void;onChats:()=>void;activeTab?:MessengerTab };

export function ChatListScreen({api,user,store,onProfile,onNewChat,onMusic,onAI,onQuickAI,onChats,onSaved,savedActive=false,activeTab='chats',rail=false}: {api:Api;user:User;store:MessengerStore;onQuickAI:()=>void;onSaved:()=>void;savedActive?:boolean;rail?:boolean}&Navigation) {
  // Tabs float over the list (it scrolls under the blurred bar, like Telegram); the list keeps room for them at the end.
  const [tabsHeight,setTabsHeight]=useState(96);const [headerHeight,setHeaderHeight]=useState(170);const bleed=useBleed();
  const float=!rail&&Platform.OS!=='web';
  const mesh=useMeshActive();
  // The open chat is highlighted only when it is shown beside the list (tablet/desktop), as in Telegram.
  const windowSize=useWindowDimensions();const wideLayout=isWideLayout(windowSize.width,windowSize.height);
  // Rows remount when a chat closes: a press interrupted by opening the chat otherwise left the
  // row stuck in its pressed (highlighted) colour after coming back.
  const t=useTheme();const [searching,setSearching]=useState(false);const query:string='';const [refreshing,setRefreshing]=useState(false);
  const [archive,setArchive]=useState(false);const [editing,setEditing]=useState<Set<string>|null>(null);const [removeAsk,setRemoveAsk]=useState<Chat[]|null>(null);const [menu,setMenu]=useState<{chat:Chat;y:number;x?:number}|null>(null);const [menuError,setMenuError]=useState('');
  const archivedCount=store.chats.filter(c=>c.settings?.archived).length;
  const folders=useChatFolders(user.id);const [filter,setFilter]=useState<FolderFilter>('all');const [editor,setEditor]=useState<{folder:ChatFolder|null}|null>(null);
  const unread=store.chats.filter(c=>!c.settings?.archived&&c.unreadCount>0).length;
  useEffect(()=>{if(filter!=='all'&&filter!=='unread'&&!folders.folders.some(f=>f.id===filter))setFilter('all');},[folders.folders,filter]);
  // Telegram moves rows smoothly when a chat jumps to the top or gets pinned.
  const order=store.chats.map(c=>`${c.id}${c.settings?.pinnedAt||''}${c.settings?.archived?1:0}`).join(',');const lastOrder=useRef(order);
  if(lastOrder.current!==order){lastOrder.current=order;if(motionEnabled())LayoutAnimation.configureNext(LayoutAnimation.create(220,LayoutAnimation.Types.easeInEaseOut,LayoutAnimation.Properties.opacity));}
  // Pinned chats first (newest pin on top), archived chats only inside «Архив», as in Telegram.
  const chats=useMemo(()=>store.chats.filter(c=>!!c.settings?.archived===archive&&(archive||matchesFolder(c,filter,folders.folders))&&`${c.peer.displayName} ${c.peer.username}`.toLowerCase().includes(query.toLowerCase())).map((c,i)=>({c,i})).sort((a,b)=>{const pa=a.c.settings?.pinnedAt||'',pb=b.c.settings?.pinnedAt||'';if(pa||pb)return pa&&pb?pb.localeCompare(pa):pa?-1:1;return a.i-b.i;}).map(x=>x.c),[store.chats,query,archive,filter,folders.folders]);
  const change=(chat:Chat,update:Partial<{pinned:boolean;archived:boolean;muted:boolean}>)=>{setMenu(null);setMenuError('');lightFeedback();store.updateChatSettings(chat.id,update).catch(e=>setMenuError(e instanceof Error?e.message:'Не удалось изменить чат.'));};
  // The store reads up to the newest server message, not only the one the list shows (reactions and edits are hidden here).
  const readChat=(chat:Chat)=>{if(chat.unreadCount)void store.readChat(chat.id,chat.lastMessage?.id||0);};
  const toggleEdit=(chat:Chat)=>{lightFeedback();setEditing(current=>{const next=new Set(current||[]);if(next.has(chat.id))next.delete(chat.id);else next.add(chat.id);return next;});};
  const selectedChats=editing?chats.filter(c=>editing.has(c.id)):[];
  const bulk=(fn:(chat:Chat)=>void)=>{const list=selectedChats.length?selectedChats:chats;list.forEach(fn);setEditing(null);lightFeedback();};
  const refresh=async()=>{setRefreshing(true);await store.refreshChats();setRefreshing(false);};
  if(searching)return <View style={{flex:1,backgroundColor:'transparent'}}><ChatSearch api={api} me={user} store={store} onClose={()=>setSearching(false)} onSaved={onSaved}/></View>;
  const header=<>
    {/* Telegram header: «Изм.» · title with connection state · AI and «new chat» buttons. */}
    <View style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:16,paddingTop:6,paddingBottom:10}}>
      <Bouncy scaleTo={.88} onPress={()=>{lightFeedback();setEditing(current=>current?null:new Set());}} accessibilityRole="button" hitSlop={6}><GlassSurface material="regular" radius={22} interactive contentStyle={{height:44,paddingHorizontal:16,justifyContent:'center'}}><Text style={{color:t.text,fontSize:16,fontWeight:'600'}}>{editing?'Готово':'Изм.'}</Text></GlassSurface></Bouncy>
      <View style={{flex:1,alignItems:'center'}}>{store.connection==='connected'?<Text style={{color:t.text,fontSize:17,fontWeight:'700'}}>Чаты</Text>:mesh?<View accessibilityLabel="Связь через Mesh, без интернета" style={{flexDirection:'row',alignItems:'center',gap:6}}><Icon name="bluetooth" size={16} color={t.accent}/><Text style={{color:t.text,fontSize:17,fontWeight:'700'}}>Mesh</Text></View>:<View style={{flexDirection:'row',alignItems:'center',gap:6}}><ActivityIndicator size="small" color={t.muted}/><Text style={{color:t.text,fontSize:15,fontWeight:'600'}}>{store.connection==='connecting'?'Соединение…':'Ожидание сети…'}</Text></View>}</View>
      <Bouncy scaleTo={.84} onPress={onQuickAI} accessibilityRole="button" accessibilityLabel="Быстрый вопрос AI" hitSlop={6}><GlassSurface material="regular" radius={22} interactive contentStyle={{width:44,height:44,alignItems:'center',justifyContent:'center'}}><Icon name="sparkles-outline" size={20} color={t.text}/></GlassSurface></Bouncy>
      <Bouncy scaleTo={.84} onPress={onNewChat} accessibilityRole="button" accessibilityLabel="Новый чат" hitSlop={6} style={{width:44,height:44,borderRadius:22,backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="create-outline" size={20} color={t.onAccent}/></Bouncy>
    </View>
    <GlassSurface lens material="regular" radius={22} shadow={false} style={{marginHorizontal:16,marginBottom:10}} contentStyle={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:14,minHeight:44}}>
      <Pressable onPress={()=>{lightFeedback();setSearching(true);}} accessibilityRole="search" accessibilityLabel="Поиск" style={{flex:1,flexDirection:'row',alignItems:'center',gap:8,minHeight:44}}><Icon name="search-outline" color={t.muted} size={19}/><Text style={{flex:1,fontSize:17,color:t.muted}}>Поиск</Text></Pressable>
    </GlassSurface>
    {/* F8: friends' stories above the chats (hidden while nobody has one); not in the archive or while editing. */}
    {!archive&&!editing?<StoriesStrip api={api} user={user} store={store}/>:null}
    {!archive?<FolderTabs folders={folders.folders} filter={filter} unread={unread} onChange={setFilter} onCreate={()=>setEditor({folder:null})} onEdit={folder=>setEditor({folder})}/>:null}
    <FolderEditor visible={!!editor} folder={editor?.folder||null} chats={store.chats} api={api} onClose={()=>setEditor(null)} onSave={folder=>{folders.upsert(folder);setFilter(folder.id);setEditor(null);}} onDelete={id=>{folders.remove(id);setEditor(null);}}/>
    {store.error?<View style={{paddingHorizontal:17,paddingBottom:12}}><Notice text={store.error} error onRetry={()=>void refresh()}/></View>:null}
  </>;
  return <View style={{flex:1,backgroundColor:'transparent'}}>
    {/* Phone, like Telegram: the header (title, search, folders) floats over the list, which scrolls under it
        and fades/blurs out there instead of being cut at a hard edge. Desktop keeps it in the flow. */}
    {float?<FloatingHeader onHeight={setHeaderHeight}>{header}</FloatingHeader>:header}
    {store.listLoading?<View style={{flex:1,overflow:'hidden',paddingTop:float?headerHeight:0,...(float?bleed.style:null)}}>{filter==='all'&&!archive?<SavedRow count={store.saved.items.length} last={store.saved.items[store.saved.items.length-1]} selected={savedActive} onPress={onSaved}/>:null}<ChatListSkeleton/></View>:<FlatList style={float?bleed.style:undefined} scrollIndicatorInsets={float?{top:headerHeight,bottom:tabsHeight}:undefined} progressViewOffset={float?headerHeight:undefined} data={chats} keyExtractor={item=>item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" alwaysBounceVertical contentContainerStyle={{paddingTop:float?headerHeight:0,paddingBottom:(rail||editing?12:tabsHeight+12)+(float?bleed.bottom:0),flexGrow:1}} ListHeaderComponent={archive?<Pressable onPress={()=>setArchive(false)} accessibilityRole="button" style={{flexDirection:'row',alignItems:'center',gap:8,padding:12}}><Icon name="chevron-back" size={18} color={t.accent}/><Text style={{color:t.accent,fontSize:15,fontWeight:'700'}}>Архив</Text></Pressable>:<>{menuError?<View style={{paddingBottom:8}}><Notice text={menuError} error/></View>:null}{filter==='all'&&(!query||'избранное'.includes(query.toLowerCase()))?<SavedRow count={store.saved.items.length} last={store.saved.items[store.saved.items.length-1]} selected={savedActive} onPress={onSaved}/>:null}{archivedCount&&!query&&filter==='all'?<Pressable onPress={()=>setArchive(true)} accessibilityRole="button" accessibilityLabel={`Архив, чатов: ${archivedCount}`} style={({pressed})=>({flexDirection:'row',gap:13,alignItems:'center',paddingHorizontal:16,paddingVertical:12,borderRadius:24,marginBottom:6,backgroundColor:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent'})}><View style={{width:54,height:54,borderRadius:19,backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}}><Icon name="archive" color={t.muted} size={24}/></View><View style={{flex:1}}><Text style={{color:t.text,fontSize:15,fontWeight:'700'}}>Архив</Text><Text style={{color:t.muted,fontSize:12}}>{countChats(archivedCount)}</Text></View></Pressable>:null}</>} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>void refresh()} tintColor={t.accent}/>} ListEmptyComponent={<View style={{flex:1,justifyContent:'center',paddingBottom:20}}><Empty icon={query?'search-outline':'chatbubbles-outline'} title={query?'Чат не найден':'Начни разговор'} description={query?'Попробуй другое имя или найди человека по @имени.':'Найди своего человека по @имени. Всё начинается с простого «привет».'} action={<Button label="Найти собеседника" onPress={onNewChat} icon="add"/>}/></View>}
      renderItem={({item})=><SwipeRow enabled={!editing} muted={!!item.settings?.muted} unread={item.unreadCount>0} onMute={()=>change(item,{muted:!item.settings?.muted})} onDelete={()=>setRemoveAsk([item])} onRead={()=>readChat(item)}><ChatRow key={store.selectedId?'open':'idle'} chat={item} api={api} userId={user.id} selected={wideLayout&&store.selectedId===item.id} typing={!!store.typing[item.id]} checked={editing?editing.has(item.id):undefined} onPress={()=>editing?toggleEdit(item):store.selectChat(item)} onLongPress={(y,x)=>{impactFeedback();setMenu({chat:item,y,x});}}/></SwipeRow>}/>}
    {editing?<GlassSurface lens material="regular" radius={26} style={{marginHorizontal:16,marginBottom:6}} contentStyle={{flexDirection:'row',justifyContent:'space-around',alignItems:'center',minHeight:52}}>
      <Pressable onPress={()=>bulk(readChat)} accessibilityRole="button" style={{padding:10}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{selectedChats.length?'Прочитать':'Прочитать все'}</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>bulk(chat=>change(chat,{archived:!archive}))} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{archive?'Из архива':'В архив'}</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>bulk(chat=>change(chat,{muted:!chat.settings?.muted}))} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>Звук</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>setRemoveAsk(selectedChats)} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.danger,fontSize:14,fontWeight:'600'}}>Удалить</Text></Pressable>
    </GlassSurface>:null}
    <Sheet visible={!!removeAsk} title={removeAsk&&removeAsk.length>1?`Удалить чаты (${removeAsk.length})?`:'Удалить чат?'} onClose={()=>setRemoveAsk(null)}>
      <SheetAction icon="trash-outline" label="Удалить у меня" description="Чат и загруженные сообщения исчезнут на этом устройстве. Если собеседник напишет снова, чат вернётся." danger onPress={()=>{const list=removeAsk||[];setRemoveAsk(null);setEditing(null);lightFeedback();list.forEach(chat=>store.removeChat(chat));}}/>
      <SheetAction icon="people-outline" label="Удалить у меня и у собеседника" description="Чат, все сообщения и файлы будут удалены на сервере и у обоих. Отменить нельзя." danger onPress={()=>{const list=removeAsk||[];setRemoveAsk(null);setEditing(null);lightFeedback();void Promise.all(list.map(chat=>store.removeChatForEveryone(chat))).catch(e=>store.setError(e instanceof Error?e.message:'Не удалось удалить чат. Попробуй ещё раз.'));}}/>
    </Sheet>
    <ContextMenu visible={!!menu} y={menu?.y||0} x={menu?.x} onClose={()=>setMenu(null)} preview={menu?.chat.peer.displayName} peek={menu?<ChatPeek chat={menu.chat} api={api} userId={user.id} messages={store.messages[menu.chat.id]}/>:undefined}>
      {menu?<>
        <MenuItem icon={menu.chat.settings?.pinnedAt?'pin':'pin-outline'} label={menu.chat.settings?.pinnedAt?'Открепить':'Закрепить'} onPress={()=>change(menu.chat,{pinned:!menu.chat.settings?.pinnedAt})}/>
        <MenuItem icon={menu.chat.settings?.muted?'notifications-outline':'notifications-off-outline'} label={menu.chat.settings?.muted?'Включить звук':'Выключить звук'} onPress={()=>change(menu.chat,{muted:!menu.chat.settings?.muted})}/>
        <MenuItem icon="archive-outline" label={menu.chat.settings?.archived?'Вернуть из архива':'В архив'} onPress={()=>change(menu.chat,{archived:!menu.chat.settings?.archived})}/>
        <MenuItem icon="trash-outline" label="Удалить чат" danger onPress={()=>{const chat=menu.chat;setMenu(null);setRemoveAsk([chat]);}}/>
      </>:null}
    </ContextMenu>
    {editing?null:rail?<><VoiceBar onOpen={communityId=>navigate({to:'channels',communityId})}/><MiniPlayer onOpen={onMusic}/></>:<View pointerEvents="box-none" onLayout={e=>{const h=Math.round(e.nativeEvent.layout.height);if(h&&Math.abs(h-tabsHeight)>1)setTabsHeight(h);}} style={{position:'absolute',left:0,right:0,bottom:0}}><MessengerTabs onProfile={onProfile} onNewChat={onNewChat} onMusic={onMusic} onAI={onAI} onChats={onChats} activeTab={activeTab}/></View>}
  </View>;
}

export function MessengerTabs({onProfile,onNewChat,onMusic,onAI,onChats,activeTab='chats'}: Navigation) {
  const t=useTheme();const insets=useSafeAreaInsets();const tabBadges:Record<string,number>=useTabBadges(useUnreadTotal());
  const narrow=useWindowDimensions().width<350; // e.g. 320 pt phones, a folded Galaxy Fold cover screen
  // The music screen shows its own player above the same tab bar; everywhere else it sits here, above the tabs.
  return <><VoiceBar onOpen={communityId=>navigate({to:'channels',communityId})}/>{activeTab!=='music'?<MiniPlayer onOpen={onMusic}/>:null}<GlassSurface systemGlass={false} material="regular" radius={31} style={{marginHorizontal:narrow?8:12,marginBottom:Platform.OS==='ios'&&insets.bottom?21-insets.bottom:10,marginTop:5}} contentStyle={{paddingHorizontal:2,paddingVertical:3}}>
    {/* «Люди» and «Каналы» share one slot (swipe up on it to switch, remembered); five tabs, each with its own tap animation. */}
    <TabBar active={activeTab==='people'?'people':activeTab==='channels'?'channels':activeTab==='profile'?'profile':activeTab==='music'?'music':activeTab==='ai'?'ai':'chats'} items={[
      {id:'ai',label:'AI',icon:'sparkles-outline',activeIcon:'sparkles',badge:0,onPress:onAI},
      {id:'people',label:'Люди',icon:'people-outline',activeIcon:'people',badge:tabBadges.people||0,onPress:onNewChat},
      {id:'channels',label:'Каналы',icon:'planet-outline',activeIcon:'planet',badge:tabBadges.channels||0,onPress:()=>navigate({to:'channels'})},
      {id:'chats',label:'Чаты',icon:'chatbubbles-outline',activeIcon:'chatbubbles',badge:tabBadges.chats||0,onPress:onChats},
      {id:'music',label:'Музыка',icon:'headset-outline',activeIcon:'headset',badge:0,onPress:onMusic},
      {id:'profile',label:'Настройки',icon:'settings-outline',activeIcon:'settings',badge:0,onPress:onProfile},
    ]}/>
  </GlassSurface></>;
}

/** The list shows an invite as words, as the chat shows it as a card (not the raw https://…/i/… link). */
function listText(text: string | undefined): string {
  if (!text) return '';
  if (!inviteCodeFrom(text)) return text;
  return withoutInviteLink(text).trim() || '🔗 Приглашение на сервер';
}

function ChatRow({chat,api,userId,selected,typing,checked,onPress,onLongPress}: {chat:Chat;api:Api;userId:string;selected:boolean;typing:boolean;checked?:boolean;onPress:()=>void;onLongPress:(y:number,x?:number)=>void}) {
  const t=useTheme();const last=chat.lastMessage;
  // Desktop: right click opens the chat menu at the cursor.
  const ref=useRef<View>(null);const longRef=useRef(onLongPress);longRef.current=onLongPress;
  useEffect(()=>{const node=ref.current as unknown as HTMLElement|null;if(Platform.OS!=='web'||!node?.addEventListener)return;const menu=(e:MouseEvent)=>{e.preventDefault();longRef.current(e.clientY,e.clientX);};node.addEventListener('contextmenu',menu);return()=>node.removeEventListener('contextmenu',menu);},[]);
  // chatListText hides spoilers (▒) also for a chat whose page is not loaded (the server's lastMessage).
  const preview=typing?'Печатает…':last?(last.meta?.action?.type==='pin'&&last.meta.action.target?pinPreview(listText(chatListText(last))||'',last.senderId===userId,chat.peer.displayName):`${listText(chatListText(last))|| (last.attachment?attachmentLabel(last.attachment):'Сообщение')}`):'Напиши первое сообщение';
  const muted=!!chat.settings?.muted,pinned=!!chat.settings?.pinnedAt;
  // On a nameplate (dark art) the row's text is light, also in the light theme (it was dark on dark).
  const onPlate=!!chat.peer.nameplate&&!t.dark;
  const c=onPlate?{text:'#FFFFFF',muted:'rgba(255,255,255,0.8)',subtle:'rgba(255,255,255,0.62)'}:{text:t.text,muted:t.muted,subtle:t.subtle};
  return <View ref={ref}><Pressable onPress={onPress} onLongPress={event=>onLongPress(event.nativeEvent.pageY)} delayLongPress={450} accessibilityRole="button" accessibilityLabel={`${chat.peer.displayName}${chat.unreadCount?`, непрочитанных ${chat.unreadCount}`:''}`} style={({pressed})=>({flexDirection:'row',gap:12,paddingLeft:16,paddingRight:16,paddingVertical:8,backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.05)'):'transparent'})}>{checked!==undefined?<View style={{justifyContent:'center'}}><Icon name={checked?'checkmark-circle':'ellipse-outline'} size={24} color={checked?t.accent:c.subtle}/></View>:null}{chat.peer.nameplate?<View pointerEvents="none" style={{position:'absolute',left:10,right:10,top:3,bottom:3}}><Nameplate plate={chat.peer.nameplate} radius={20}/></View>:null}<DecoratedAvatar user={chat.peer} api={api} size={60}/><View style={{flex:1,justifyContent:'center',gap:3,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:t.border,paddingBottom:8,marginBottom:-8,minHeight:68}}><View style={{flexDirection:'row',gap:5,alignItems:'center'}}><View style={{flex:1,flexDirection:'row',alignItems:'center',gap:5}}><PlatinaName user={chat.peer} animated={false} onDark={onPlate} style={{flexShrink:1,color:c.text,fontSize:16,fontWeight:'600',letterSpacing:-.2}}/><StatusEmoji user={chat.peer} size={15}/>{muted?<Icon name="volume-mute" size={13} color={c.subtle}/>:null}</View>{last?<Text style={{color:chat.unreadCount&&!muted?t.accent:c.muted,fontSize:14}}>{formatListTime(last.createdAt)}</Text>:null}</View><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={2} style={{flex:1,color:typing?t.accent:c.muted,fontSize:15,lineHeight:19,fontWeight:typing?'600':'400'}}>{preview}</Text>{chat.unreadCount>0?<View style={{minWidth:22,height:22,borderRadius:11,backgroundColor:muted?c.subtle:t.accent,alignItems:'center',justifyContent:'center',paddingHorizontal:6}}><Text maxFontSizeMultiplier={1} style={{color:t.onAccent,fontSize:12,fontWeight:'700'}}>{badgeText(chat.unreadCount)}</Text></View>:pinned?<Icon name="pin" size={14} color={c.subtle}/>:last?.senderId===userId?<Icon name={chat.peerLastReadMessageId>=last.id?'checkmark-done':'checkmark'} size={16} color={chat.peerLastReadMessageId>=last.id?t.accent:c.subtle}/>:null}</View></View></Pressable></View>;
}

function SavedRow({count,last,selected,onPress}:{count:number;last?:SavedItem;selected:boolean;onPress:()=>void}) {
  const t=useTheme();
  const preview=last?(listText(last.text)||(last.attachment?attachmentLabel(last.attachment):'Запись')):'Заметки, файлы и сохранённые сообщения';
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Избранное, записей: ${count}`} style={({pressed})=>({flexDirection:'row',gap:12,paddingLeft:16,paddingRight:16,paddingVertical:8,backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.05)'):'transparent'})}><View style={{width:60,height:60,borderRadius:Math.round(60*0.36),backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="bookmark" color={t.onAccent} size={26}/></View><View style={{flex:1,justifyContent:'center',gap:3,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:t.border,paddingBottom:8,marginBottom:-8,minHeight:68}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{flex:1,color:t.text,fontSize:16,fontWeight:'600',letterSpacing:-.2}}>Избранное</Text>{last?<Text style={{color:t.muted,fontSize:14}}>{formatListTime(last.savedAt)}</Text>:null}</View><Text numberOfLines={2} style={{color:t.muted,fontSize:15,lineHeight:19}}>{preview}</Text></View></Pressable>;
}

/** Long-press on a chat, as in Telegram: a card with the chat itself (header and the latest messages) above the menu. */
function ChatPeek({chat,api,userId,messages}:{chat:Chat;api:Api;userId:string;messages?:Message[]}) {
  const t=useTheme();const {height}=useWindowDimensions();
  const shown=(messages?.length?messages:chat.lastMessage?[chat.lastMessage]:[]).filter(m=>!isQuietAction(m)).slice(-14);
  return <View style={{height:Math.min(440,Math.round(height*0.5)),borderRadius:24,overflow:'hidden',backgroundColor:t.bg,borderWidth:StyleSheet.hairlineWidth,borderColor:t.border}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:14,paddingVertical:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:t.border}}>
      <Avatar user={chat.peer} api={api} size={36}/>
      <View style={{flex:1}}><Text numberOfLines={1} style={{color:t.text,fontSize:15,fontWeight:'700'}}>{chat.peer.displayName}</Text><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>@{chat.peer.username}</Text></View>
    </View>
    <View style={{flex:1,justifyContent:'flex-end',paddingHorizontal:10,paddingBottom:10,gap:4}}>
      {shown.length?shown.map(m=>{const mine=m.senderId===userId;return <View key={m.clientId||m.id} style={{alignSelf:mine?'flex-end':'flex-start',maxWidth:'82%',borderRadius:16,paddingHorizontal:10,paddingVertical:6,backgroundColor:mine?t.bubble:t.incoming}}>
        <Text numberOfLines={4} raw style={{color:t.text,fontSize:14,lineHeight:19}}>{listText(chatListText(m))||(m.attachment?attachmentLabel(m.attachment):'Сообщение')}</Text>
      </View>;}):<Text style={{color:t.muted,textAlign:'center',marginBottom:20}}>Сообщений пока нет</Text>}
    </View>
  </View>;
}

/** The row whose swipe buttons are open (one at a time, as in Telegram): opening another closes it. */
let closeOpenRow:(()=>void)|null=null;
const SWIPE_BUTTON=64,SWIPE_GAP=8,SWIPE_OPEN=2*SWIPE_BUTTON+3*SWIPE_GAP;

/** A Telegram swipe button: a coloured capsule with its label under it, growing in as the row slides. */
function SwipeButton({icon,label,color,iconColor,x,index,onPress}:{icon:React.ComponentProps<typeof Icon>['name'];label:string;color:string;iconColor:string;x:SharedValue<number>;index:number;onPress:()=>void}) {
  const t=useTheme();
  const style=useAnimatedStyle(()=>{const p=Math.min(1,Math.max(0,(-x.value-index*SWIPE_GAP*2)/(SWIPE_OPEN*0.75)));return {opacity:p,transform:[{scale:0.5+0.5*p}]};});
  return <Animated.View style={[{width:SWIPE_BUTTON,alignItems:'center',gap:4},style]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={({pressed})=>({width:SWIPE_BUTTON,height:42,borderRadius:21,backgroundColor:color,alignItems:'center',justifyContent:'center',opacity:pressed?.75:1})}><Icon name={icon} size={21} color={iconColor}/></Pressable>
    {/* The label sits on the row background, so it takes the theme's secondary text (a fixed grey read at 2.5:1 on the light theme). */}
    <Text numberOfLines={1} maxFontSizeMultiplier={1} style={{color:t.muted,fontSize:10,fontWeight:'600'}}>{label}</Text>
  </Animated.View>;
}
/** Telegram's orange for «Убрать звук»; the theme has no warning token, and the icon on it is white as there. */
const MUTE_ORANGE='#FF9500';

/**
 * Telegram swipes on a chat: left slides the row to reveal «Убрать звук» and «Удалить» (it stays open
 * until you tap one, tap the row or swipe back); right marks an unread chat as read.
 */
function SwipeRow({enabled,muted,unread,onMute,onDelete,onRead,children}:{enabled:boolean;muted:boolean;unread:boolean;onMute:()=>void;onDelete:()=>void;onRead:()=>void;children:React.ReactNode}) {
  const t=useTheme();const x=useSharedValue(0);const start=useSharedValue(0);const armed=useSharedValue(0);const [open,setOpen]=useState(false);
  const refs=useRef({onMute,onDelete,onRead});refs.current={onMute,onDelete,onRead};
  const SPRING={damping:24,stiffness:300,mass:0.8};
  const close=()=>{x.value=withSpring(0,SPRING);setOpen(false);if(closeOpenRow===closeSelf.current)closeOpenRow=null;};
  const closeSelf=useRef(close);closeSelf.current=close;
  const opened=()=>{if(closeOpenRow&&closeOpenRow!==closeSelf.current)closeOpenRow();closeOpenRow=()=>closeSelf.current();setOpen(true);};
  const read=()=>refs.current.onRead();
  const pan=Gesture.Pan().enabled(enabled).activeOffsetX([-12,12]).failOffsetY([-14,14])
    .onStart(()=>{start.value=x.value;})
    .onUpdate(e=>{
      let v=start.value+e.translationX;
      // Past the buttons the row moves with resistance; to the right only for an unread chat.
      if(v<-SWIPE_OPEN)v=-SWIPE_OPEN+(v+SWIPE_OPEN)*0.3;
      if(v>0)v=unread&&start.value===0?Math.min(110,v):0;
      x.value=v;const side=v>70?1:0;if(side!==armed.value){armed.value=side;if(side)runOnJS(lightFeedback)();}
    })
    .onEnd(e=>{
      if(armed.value){armed.value=0;x.value=withSpring(0,SPRING);runOnJS(read)();return;}
      const goOpen=x.value<-SWIPE_OPEN*0.4&&e.velocityX<400||e.velocityX<-500;
      x.value=withSpring(goOpen?-SWIPE_OPEN:0,{...SPRING,velocity:e.velocityX});
      if(goOpen)runOnJS(opened)();else runOnJS(close)();
    });
  const row=useAnimatedStyle(()=>({transform:[{translateX:x.value}]}));
  const readStyle=useAnimatedStyle(()=>({opacity:Math.min(1,Math.max(0,x.value/60)),transform:[{scale:0.5+0.5*Math.min(1,Math.max(0,x.value/70))}]}));
  const act=(fn:()=>void)=>()=>{close();fn();};
  return <GestureDetector gesture={pan}><View>
    <View style={{position:'absolute',top:0,bottom:0,right:0,flexDirection:'row',alignItems:'center',gap:SWIPE_GAP,paddingRight:SWIPE_GAP}}>
      <SwipeButton icon={muted?'volume-high':'volume-mute'} label={muted?'Включить звук':'Убрать звук'} color={MUTE_ORANGE} iconColor="#FFF" x={x} index={1} onPress={act(()=>refs.current.onMute())}/>
      {/* Dark themes have a light danger tone: the icon on it is dark, as text on the accent. */}
      <SwipeButton icon="trash" label="Удалить" color={t.danger} iconColor={t.dark?t.bg:'#FFF'} x={x} index={0} onPress={act(()=>refs.current.onDelete())}/>
    </View>
    {unread?<Animated.View pointerEvents="none" style={[{position:'absolute',top:0,bottom:0,left:16,justifyContent:'center',alignItems:'center',gap:4},readStyle]}><View style={{width:SWIPE_BUTTON,height:42,borderRadius:21,backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="chatbubble" size={20} color={t.onAccent}/></View><Text style={{color:t.muted,fontSize:10,fontWeight:'600'}}>Прочитано</Text></Animated.View>:null}
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
  const tabBadges=useTabBadges(unread);const badges:Record<string,number>=tabBadges;
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
