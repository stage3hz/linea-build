import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderEditor, FolderTabs, matchesFolder, useChatFolders, type ChatFolder, type FolderFilter } from './ChatFolders';
import { attachmentLabel } from './voice/voice';
import { motionEnabled } from './motion';
import { ActivityIndicator, FlatList, LayoutAnimation, Platform, Pressable, RefreshControl, UIManager, View } from 'react-native';
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) UIManager.setLayoutAnimationEnabledExperimental(true);
import { Text, TextInput } from './typography';
import { MiniPlayer } from './music/PlayerControls';
import { Avatar, Button, Empty, Icon, IconButton, Notice, Sheet, SheetAction } from './components';
import { GlassSurface } from './glass';
import { StatusEmoji } from './StatusEmoji';
import { formatListTime, useTheme } from './theme';
import type { Api } from './api';
import type { Chat, User } from './types';
import type { MessengerStore } from './useMessenger';
import type { SavedItem } from './saved/saved.ts';
import { ContextMenu, MenuItem } from './ContextMenu';
import { impactFeedback, lightFeedback } from './haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

export type MessengerTab = 'chats' | 'people' | 'music' | 'ai' | 'profile';
type Navigation = { onProfile:()=>void;onNewChat:()=>void;onMusic:()=>void;onAI:()=>void;onChats:()=>void;activeTab?:MessengerTab };

export function ChatListScreen({api,user,store,onProfile,onNewChat,onMusic,onAI,onQuickAI,onChats,onSaved,savedActive=false,activeTab='chats'}: {api:Api;user:User;store:MessengerStore;onQuickAI:()=>void;onSaved:()=>void;savedActive?:boolean}&Navigation) {
  const t=useTheme();const [query,setQuery]=useState('');const [refreshing,setRefreshing]=useState(false);
  const [archive,setArchive]=useState(false);const [editing,setEditing]=useState<Set<string>|null>(null);const [removeAsk,setRemoveAsk]=useState<Chat[]|null>(null);const [menu,setMenu]=useState<{chat:Chat;y:number}|null>(null);const [menuError,setMenuError]=useState('');
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
  const readChat=(chat:Chat)=>{if(chat.unreadCount&&chat.lastMessage)void store.readChat(chat.id,chat.lastMessage.id);};
  const toggleEdit=(chat:Chat)=>{lightFeedback();setEditing(current=>{const next=new Set(current||[]);if(next.has(chat.id))next.delete(chat.id);else next.add(chat.id);return next;});};
  const selectedChats=editing?chats.filter(c=>editing.has(c.id)):[];
  const bulk=(fn:(chat:Chat)=>void)=>{const list=selectedChats.length?selectedChats:chats;list.forEach(fn);setEditing(null);lightFeedback();};
  const refresh=async()=>{setRefreshing(true);await store.refreshChats();setRefreshing(false);};
  return <View style={{flex:1,backgroundColor:'transparent'}}>
    <GlassSurface material="clear" radius={28} style={{marginHorizontal:14,marginTop:12,marginBottom:13}} contentStyle={{paddingHorizontal:18,paddingVertical:15,flexDirection:'row',alignItems:'center',gap:12}}>
      <View style={{flex:1,gap:6}}><Text style={{color:t.text,fontSize:29,fontWeight:'800',letterSpacing:-1.25}}>Инвиз</Text><View style={{flexDirection:'row',gap:6,alignItems:'center'}}><View style={{width:5,height:5,borderRadius:5,backgroundColor:store.connection==='connected'?t.accent:t.subtle}}/><Text style={{fontSize:11,color:t.muted}}>{store.connection==='connected'?'Твои личные разговоры':store.connection==='connecting'?'Подключаемся…':'Нет связи с сервером'}</Text></View></View>
      <Pressable onPress={()=>{lightFeedback();setEditing(current=>current?null:new Set());}} accessibilityRole="button" hitSlop={6} style={{paddingHorizontal:12,height:38,borderRadius:19,justifyContent:'center',backgroundColor:t.surface2}}><Text style={{color:t.accent,fontSize:14,fontWeight:'700'}}>{editing?'Готово':'Изм.'}</Text></Pressable>
      <IconButton name="sparkles-outline" label="Быстрый вопрос AI" onPress={onQuickAI} color={t.accent} style={{width:40,height:42,borderRadius:18,backgroundColor:t.accentSoft}}/>
      <Pressable onPress={onProfile} accessibilityRole="button" accessibilityLabel="Мой профиль" style={({pressed})=>({padding:4,borderRadius:22,borderWidth:1,borderColor:t.dark?'rgba(255,255,255,0.18)':'rgba(255,255,255,0.96)',backgroundColor:t.dark?'rgba(255,255,255,0.04)':'rgba(255,255,255,0.35)',opacity:pressed?.7:1})}><Avatar user={user} api={api} size={41}/></Pressable>
    </GlassSurface>
    <GlassSurface material="regular" radius={23} shadow={false} style={{marginHorizontal:17,marginBottom:14}} contentStyle={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:15,minHeight:48}}>
      <Icon name="search-outline" color={t.muted} size={19}/><TextInput accessibilityLabel="Поиск по чатам" placeholder="Поиск" value={query} onChangeText={setQuery} placeholderTextColor={t.muted} selectionColor={t.accent} style={{flex:1,fontSize:15,color:t.text,paddingVertical:12}} autoCorrect={false}/>{query?<IconButton name="close-circle" label="Очистить поиск" onPress={()=>setQuery('')} color={t.muted} size={18} style={{width:30,height:36}}/>:null}
    </GlassSurface>
    {!archive?<FolderTabs folders={folders.folders} filter={filter} unread={unread} onChange={setFilter} onCreate={()=>setEditor({folder:null})} onEdit={folder=>setEditor({folder})}/>:null}
    <FolderEditor visible={!!editor} folder={editor?.folder||null} chats={store.chats} api={api} onClose={()=>setEditor(null)} onSave={folder=>{folders.upsert(folder);setFilter(folder.id);setEditor(null);}} onDelete={id=>{folders.remove(id);setEditor(null);}}/>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:24,marginBottom:7}}><Text style={{color:t.muted,fontSize:10,fontWeight:'700',letterSpacing:1.7}}>СООБЩЕНИЯ{store.chats.length?`  ${store.chats.length}`:''}</Text><Pressable onPress={onNewChat} accessibilityRole="button" style={{flexDirection:'row',alignItems:'center',gap:5,paddingVertical:8}}><Icon name="create-outline" color={t.accent} size={17}/><Text style={{fontSize:12,color:t.accent,fontWeight:'700'}}>Новый чат</Text></Pressable></View>
    {store.error?<View style={{paddingHorizontal:17,paddingBottom:12}}><Notice text={store.error} error onRetry={()=>void refresh()}/></View>:null}
    {store.listLoading?<View style={{flex:1,justifyContent:'center'}}><ActivityIndicator color={t.accent}/></View>:<FlatList data={chats} keyExtractor={item=>item.id} contentContainerStyle={{paddingHorizontal:13,paddingBottom:12,flexGrow:1}} ListHeaderComponent={archive?<Pressable onPress={()=>setArchive(false)} accessibilityRole="button" style={{flexDirection:'row',alignItems:'center',gap:8,padding:12}}><Icon name="chevron-back" size={18} color={t.accent}/><Text style={{color:t.accent,fontSize:15,fontWeight:'700'}}>Архив</Text></Pressable>:<>{menuError?<View style={{paddingBottom:8}}><Notice text={menuError} error/></View>:null}{filter==='all'&&(!query||'избранное'.includes(query.toLowerCase()))?<SavedRow count={store.saved.items.length} last={store.saved.items[store.saved.items.length-1]} selected={savedActive} onPress={onSaved}/>:null}{archivedCount&&!query&&filter==='all'?<Pressable onPress={()=>setArchive(true)} accessibilityRole="button" accessibilityLabel={`Архив, чатов: ${archivedCount}`} style={({pressed})=>({flexDirection:'row',gap:13,alignItems:'center',paddingHorizontal:12,paddingVertical:12,borderRadius:24,marginBottom:6,backgroundColor:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent'})}><View style={{width:54,height:54,borderRadius:19,backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}}><Icon name="archive" color={t.muted} size={24}/></View><View style={{flex:1}}><Text style={{color:t.text,fontSize:15,fontWeight:'700'}}>Архив</Text><Text style={{color:t.muted,fontSize:12}}>{archivedCount} {archivedCount===1?'чат':archivedCount<5?'чата':'чатов'}</Text></View></Pressable>:null}</>} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>void refresh()} tintColor={t.accent}/>} ListEmptyComponent={<View style={{flex:1,justifyContent:'center',paddingBottom:20}}><Empty icon={query?'search-outline':'chatbubbles-outline'} title={query?'Чат не найден':'Начни разговор'} description={query?'Попробуй другое имя или найди человека по нику.':'Найди своего человека по нику. Всё начинается с простого «привет».'} action={<Button label="Найти собеседника" onPress={onNewChat} icon="add"/>}/></View>}
      renderItem={({item})=><SwipeRow enabled={!editing} archived={!!item.settings?.archived} unread={item.unreadCount>0} onArchive={()=>change(item,{archived:!item.settings?.archived})} onRead={()=>readChat(item)}><ChatRow chat={item} api={api} userId={user.id} selected={store.selectedId===item.id} typing={!!store.typing[item.id]} checked={editing?editing.has(item.id):undefined} onPress={()=>editing?toggleEdit(item):store.selectChat(item)} onLongPress={y=>{impactFeedback();setMenu({chat:item,y});}}/></SwipeRow>}/>}
    {editing?<GlassSurface material="regular" radius={26} style={{marginHorizontal:16,marginBottom:6}} contentStyle={{flexDirection:'row',justifyContent:'space-around',alignItems:'center',minHeight:52}}>
      <Pressable onPress={()=>bulk(readChat)} accessibilityRole="button" style={{padding:10}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{selectedChats.length?'Прочитать':'Прочитать все'}</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>bulk(chat=>change(chat,{archived:!archive}))} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>{archive?'Из архива':'В архив'}</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>bulk(chat=>change(chat,{muted:!chat.settings?.muted}))} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.accent,fontSize:14,fontWeight:'600'}}>Звук</Text></Pressable>
      <Pressable disabled={!selectedChats.length} onPress={()=>setRemoveAsk(selectedChats)} accessibilityRole="button" style={{padding:10,opacity:selectedChats.length?1:.4}}><Text style={{color:t.danger,fontSize:14,fontWeight:'600'}}>Удалить</Text></Pressable>
    </GlassSurface>:null}
    <Sheet visible={!!removeAsk} title={removeAsk&&removeAsk.length>1?`Удалить чаты (${removeAsk.length})?`:'Удалить чат?'} onClose={()=>setRemoveAsk(null)}>
      <SheetAction icon="trash-outline" label="Удалить у меня" description="Чат и загруженные сообщения исчезнут на этом устройстве. Если собеседник напишет снова, чат вернётся." danger onPress={()=>{const list=removeAsk||[];setRemoveAsk(null);setEditing(null);lightFeedback();list.forEach(chat=>store.removeChat(chat));}}/>
    </Sheet>
    <ContextMenu visible={!!menu} y={menu?.y||0} onClose={()=>setMenu(null)} preview={menu?.chat.peer.displayName}>
      {menu?<>
        <MenuItem icon={menu.chat.settings?.pinnedAt?'pin':'pin-outline'} label={menu.chat.settings?.pinnedAt?'Открепить':'Закрепить'} onPress={()=>change(menu.chat,{pinned:!menu.chat.settings?.pinnedAt})}/>
        <MenuItem icon={menu.chat.settings?.muted?'notifications-outline':'notifications-off-outline'} label={menu.chat.settings?.muted?'Включить звук':'Выключить звук'} onPress={()=>change(menu.chat,{muted:!menu.chat.settings?.muted})}/>
        <MenuItem icon="archive-outline" label={menu.chat.settings?.archived?'Вернуть из архива':'В архив'} onPress={()=>change(menu.chat,{archived:!menu.chat.settings?.archived})}/>
        <MenuItem icon="trash-outline" label="Удалить чат" danger onPress={()=>{const chat=menu.chat;setMenu(null);setRemoveAsk([chat]);}}/>
      </>:null}
    </ContextMenu>
    {editing?null:<MessengerTabs onProfile={onProfile} onNewChat={onNewChat} onMusic={onMusic} onAI={onAI} onChats={onChats} activeTab={activeTab}/>}
  </View>;
}

export function MessengerTabs({onProfile,onNewChat,onMusic,onAI,onChats,activeTab='chats'}: Navigation) {
  const t=useTheme();
  // The music screen shows its own player above the same tab bar; everywhere else it sits here, above the tabs.
  return <>{activeTab!=='music'?<MiniPlayer onOpen={onMusic}/>:null}<GlassSurface material="clear" radius={29} style={{marginHorizontal:16,marginBottom:10,marginTop:5}} contentStyle={{minHeight:67,flexDirection:'row',alignItems:'center',paddingHorizontal:6,paddingVertical:6}}>
    {([{id:'chats',label:'Чаты',icon:'chatbubbles-outline',onPress:onChats},{id:'people',label:'Люди',icon:'people-outline',onPress:onNewChat},{id:'music',label:'Музыка',icon:'headset-outline',onPress:onMusic},{id:'ai',label:'AI',icon:'sparkles-outline',onPress:onAI},{id:'profile',label:'Профиль',icon:'person-circle-outline',onPress:onProfile}] as const).map(item=><Pressable key={item.id} onPress={item.onPress} accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{selected:activeTab===item.id}} style={({pressed})=>({flex:1,alignItems:'center',opacity:pressed?.6:1})}><View style={{width:'100%',gap:5,alignItems:'center',paddingVertical:8,borderRadius:20,backgroundColor:activeTab===item.id?t.accentSoft:'transparent',borderWidth:1,borderColor:activeTab===item.id?t.glassBorder:'transparent'}}><Icon name={item.icon} color={activeTab===item.id?t.accent:t.muted} size={21}/><Text style={{fontSize:10,color:activeTab===item.id?t.accent:t.muted,fontWeight:activeTab===item.id?'700':'600'}}>{item.label}</Text></View></Pressable>)}
  </GlassSurface></>;
}

function ChatRow({chat,api,userId,selected,typing,checked,onPress,onLongPress}: {chat:Chat;api:Api;userId:string;selected:boolean;typing:boolean;checked?:boolean;onPress:()=>void;onLongPress:(y:number)=>void}) {
  const t=useTheme();const last=chat.lastMessage;
  const preview=typing?'Печатает…':last?`${last.senderId===userId?'Ты: ':''}${last.text|| (last.attachment?attachmentLabel(last.attachment):'Сообщение')}`:'Напиши первое сообщение';
  const muted=!!chat.settings?.muted,pinned=!!chat.settings?.pinnedAt;
  return <Pressable onPress={onPress} onLongPress={event=>onLongPress(event.nativeEvent.pageY)} delayLongPress={450} accessibilityRole="button" accessibilityLabel={`${chat.peer.displayName}${chat.unreadCount?`, непрочитанных ${chat.unreadCount}`:''}`} style={({pressed})=>({flexDirection:'row',gap:13,paddingHorizontal:12,paddingVertical:14,borderRadius:24,marginBottom:6,borderWidth:1,borderColor:selected?(t.black?'rgba(255,255,255,0.24)':t.dark?'rgba(155,181,255,0.28)':'rgba(255,255,255,0.98)'):'transparent',backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent',shadowColor:t.shadow,shadowOpacity:selected?.06:0,shadowRadius:12,shadowOffset:{width:0,height:4}})}>{checked!==undefined?<View style={{justifyContent:'center'}}><Icon name={checked?'checkmark-circle':'ellipse-outline'} size={24} color={checked?t.accent:t.subtle}/></View>:null}<Avatar user={chat.peer} api={api}/><View style={{flex:1,justifyContent:'center',gap:8}}><View style={{flexDirection:'row',gap:5,alignItems:'center'}}><View style={{flex:1,flexDirection:'row',alignItems:'center',gap:5}}><Text numberOfLines={1} style={{flexShrink:1,color:t.text,fontSize:15,fontWeight:'700',letterSpacing:-.2}}>{chat.peer.displayName}</Text><StatusEmoji user={chat.peer} size={15}/>{muted?<Icon name="volume-mute" size={13} color={t.subtle}/>:null}</View>{last?<Text style={{color:chat.unreadCount?t.accent:t.muted,fontSize:10}}>{formatListTime(last.createdAt)}</Text>:null}</View><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{flex:1,color:typing?t.accent:t.muted,fontSize:12,fontWeight:typing?'600':'400'}}>{preview}</Text>{chat.unreadCount>0?<View style={{minWidth:21,height:21,borderRadius:11,backgroundColor:muted?t.subtle:t.accent,alignItems:'center',justifyContent:'center',paddingHorizontal:6}}><Text style={{color:t.onAccent,fontSize:10,fontWeight:'700'}}>{chat.unreadCount>99?'99+':chat.unreadCount}</Text></View>:pinned?<Icon name="pin" size={14} color={t.subtle}/>:last?.senderId===userId?<Icon name={chat.peerLastReadMessageId>=last.id?'checkmark-done':'checkmark'} size={16} color={chat.peerLastReadMessageId>=last.id?t.accent:t.subtle}/>:null}</View></View></Pressable>;
}

function SavedRow({count,last,selected,onPress}:{count:number;last?:SavedItem;selected:boolean;onPress:()=>void}) {
  const t=useTheme();
  const preview=last?(last.text||(last.attachment?attachmentLabel(last.attachment):'Запись')):'Заметки, файлы и сохранённые сообщения';
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Избранное, записей: ${count}`} style={({pressed})=>({flexDirection:'row',gap:13,paddingHorizontal:12,paddingVertical:14,borderRadius:24,marginBottom:6,borderWidth:1,borderColor:selected?t.glassBorder:'transparent',backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent'})}><View style={{width:54,height:54,borderRadius:19,backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="bookmark" color={t.onAccent} size={25}/></View><View style={{flex:1,justifyContent:'center',gap:8}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{flex:1,color:t.text,fontSize:15,fontWeight:'700',letterSpacing:-.2}}>Избранное</Text>{last?<Text style={{color:t.muted,fontSize:10}}>{formatListTime(last.savedAt)}</Text>:null}</View><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>{preview}</Text></View></Pressable>;
}

/** Telegram swipes on a chat: left — archive, right — mark as read. UI thread. */
function SwipeRow({enabled,archived,unread,onArchive,onRead,children}:{enabled:boolean;archived:boolean;unread:boolean;onArchive:()=>void;onRead:()=>void;children:React.ReactNode}) {
  const t=useTheme();const x=useSharedValue(0);const armed=useSharedValue(0);
  const archiveRef=useRef(onArchive);archiveRef.current=onArchive;const readRef=useRef(onRead);readRef.current=onRead;
  const fire=(side:number)=>{if(side<0)archiveRef.current();else readRef.current();};
  const pan=Gesture.Pan().enabled(enabled).activeOffsetX([-12,12]).failOffsetY([-14,14])
    .onUpdate(e=>{const v=Math.max(-150,Math.min(unread?120:0,e.translationX));x.value=v;const side=v<-90?-1:v>70?1:0;if(side!==armed.value){armed.value=side;if(side)runOnJS(lightFeedback)();}})
    .onEnd(()=>{if(armed.value)runOnJS(fire)(armed.value);})
    .onFinalize(()=>{armed.value=0;x.value=withSpring(0,{damping:20,stiffness:280});});
  const row=useAnimatedStyle(()=>({transform:[{translateX:x.value}]}));
  const left=useAnimatedStyle(()=>({opacity:x.value<-20?1:0}));const right=useAnimatedStyle(()=>({opacity:x.value>20?1:0}));
  return <GestureDetector gesture={pan}><View>
    <Animated.View pointerEvents="none" style={[{position:'absolute',top:0,bottom:6,right:0,left:0,borderRadius:24,backgroundColor:t.subtle,alignItems:'flex-end',justifyContent:'center',paddingRight:24},left]}><Icon name={archived?'arrow-undo-outline':'archive'} size={22} color="#FFF"/><Text style={{color:'#FFF',fontSize:10,fontWeight:'600',marginTop:3}}>{archived?'Вернуть':'В архив'}</Text></Animated.View>
    <Animated.View pointerEvents="none" style={[{position:'absolute',top:0,bottom:6,right:0,left:0,borderRadius:24,backgroundColor:t.accent,alignItems:'flex-start',justifyContent:'center',paddingLeft:24},right]}><Icon name="chatbubble" size={22} color={t.onAccent}/><Text style={{color:t.onAccent,fontSize:10,fontWeight:'600',marginTop:3}}>Прочитано</Text></Animated.View>
    <Animated.View style={[{backgroundColor:'transparent'},row]}>{children}</Animated.View>
  </View></GestureDetector>;
}
