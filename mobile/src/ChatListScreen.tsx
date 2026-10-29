import React, { useMemo, useState } from 'react';
import { attachmentLabel } from './voice/voice';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Text, TextInput } from './typography';
import { MiniPlayer } from './music/PlayerControls';
import { Avatar, Button, Empty, Icon, IconButton, Notice } from './components';
import { GlassSurface } from './glass';
import { StatusEmoji } from './StatusEmoji';
import { formatListTime, useTheme } from './theme';
import type { Api } from './api';
import type { Chat, User } from './types';
import type { MessengerStore } from './useMessenger';
import type { SavedItem } from './saved/saved.ts';

export type MessengerTab = 'chats' | 'people' | 'music' | 'ai' | 'profile';
type Navigation = { onProfile:()=>void;onNewChat:()=>void;onMusic:()=>void;onAI:()=>void;onChats:()=>void;activeTab?:MessengerTab };

export function ChatListScreen({api,user,store,onProfile,onNewChat,onMusic,onAI,onQuickAI,onChats,onSaved,savedActive=false,activeTab='chats'}: {api:Api;user:User;store:MessengerStore;onQuickAI:()=>void;onSaved:()=>void;savedActive?:boolean}&Navigation) {
  const t=useTheme();const [query,setQuery]=useState('');const [refreshing,setRefreshing]=useState(false);
  const chats=useMemo(()=>store.chats.filter(c=>`${c.peer.displayName} ${c.peer.username}`.toLowerCase().includes(query.toLowerCase())),[store.chats,query]);
  const refresh=async()=>{setRefreshing(true);await store.refreshChats();setRefreshing(false);};
  return <View style={{flex:1,backgroundColor:'transparent'}}>
    <GlassSurface material="clear" radius={28} style={{marginHorizontal:14,marginTop:12,marginBottom:13}} contentStyle={{paddingHorizontal:18,paddingVertical:15,flexDirection:'row',alignItems:'center',gap:12}}>
      <View style={{flex:1,gap:6}}><Text style={{color:t.text,fontSize:29,fontWeight:'800',letterSpacing:-1.25}}>Инвиз</Text><View style={{flexDirection:'row',gap:6,alignItems:'center'}}><View style={{width:5,height:5,borderRadius:5,backgroundColor:store.connection==='connected'?t.accent:t.subtle}}/><Text style={{fontSize:11,color:t.muted}}>{store.connection==='connected'?'Твои личные разговоры':store.connection==='connecting'?'Подключаемся…':'Нет связи с сервером'}</Text></View></View>
      <IconButton name="sparkles-outline" label="Быстрый вопрос AI" onPress={onQuickAI} color={t.accent} style={{width:40,height:42,borderRadius:18,backgroundColor:t.accentSoft}}/>
      <Pressable onPress={onProfile} accessibilityRole="button" accessibilityLabel="Мой профиль" style={({pressed})=>({padding:4,borderRadius:22,borderWidth:1,borderColor:t.dark?'rgba(255,255,255,0.18)':'rgba(255,255,255,0.96)',backgroundColor:t.dark?'rgba(255,255,255,0.04)':'rgba(255,255,255,0.35)',opacity:pressed?.7:1})}><Avatar user={user} api={api} size={41}/></Pressable>
    </GlassSurface>
    <GlassSurface material="regular" radius={23} shadow={false} style={{marginHorizontal:17,marginBottom:14}} contentStyle={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:15,minHeight:48}}>
      <Icon name="search-outline" color={t.muted} size={19}/><TextInput accessibilityLabel="Поиск по чатам" placeholder="Поиск" value={query} onChangeText={setQuery} placeholderTextColor={t.muted} selectionColor={t.accent} style={{flex:1,fontSize:15,color:t.text,paddingVertical:12}} autoCorrect={false}/>{query?<IconButton name="close-circle" label="Очистить поиск" onPress={()=>setQuery('')} color={t.muted} size={18} style={{width:30,height:36}}/>:null}
    </GlassSurface>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:24,marginBottom:7}}><Text style={{color:t.muted,fontSize:10,fontWeight:'700',letterSpacing:1.7}}>СООБЩЕНИЯ{store.chats.length?`  ${store.chats.length}`:''}</Text><Pressable onPress={onNewChat} accessibilityRole="button" style={{flexDirection:'row',alignItems:'center',gap:5,paddingVertical:8}}><Icon name="create-outline" color={t.accent} size={17}/><Text style={{fontSize:12,color:t.accent,fontWeight:'700'}}>Новый чат</Text></Pressable></View>
    {store.error?<View style={{paddingHorizontal:17,paddingBottom:12}}><Notice text={store.error} error onRetry={()=>void refresh()}/></View>:null}
    {store.listLoading?<View style={{flex:1,justifyContent:'center'}}><ActivityIndicator color={t.accent}/></View>:<FlatList data={chats} keyExtractor={item=>item.id} contentContainerStyle={{paddingHorizontal:13,paddingBottom:12,flexGrow:1}} ListHeaderComponent={!query||'избранное'.includes(query.toLowerCase())?<SavedRow count={store.saved.items.length} last={store.saved.items[store.saved.items.length-1]} selected={savedActive} onPress={onSaved}/>:null} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>void refresh()} tintColor={t.accent}/>} ListEmptyComponent={<View style={{flex:1,justifyContent:'center',paddingBottom:20}}><Empty icon={query?'search-outline':'chatbubbles-outline'} title={query?'Чат не найден':'Начни разговор'} description={query?'Попробуй другое имя или найди человека по нику.':'Найди своего человека по нику. Всё начинается с простого «привет».'} action={<Button label="Найти собеседника" onPress={onNewChat} icon="add"/>}/></View>}
      renderItem={({item})=><ChatRow chat={item} api={api} userId={user.id} selected={store.selectedId===item.id} typing={!!store.typing[item.id]} onPress={()=>store.selectChat(item)}/>}/>}
    <MessengerTabs onProfile={onProfile} onNewChat={onNewChat} onMusic={onMusic} onAI={onAI} onChats={onChats} activeTab={activeTab}/>
  </View>;
}

export function MessengerTabs({onProfile,onNewChat,onMusic,onAI,onChats,activeTab='chats'}: Navigation) {
  const t=useTheme();
  // The music screen shows its own player above the same tab bar; everywhere else it sits here, above the tabs.
  return <>{activeTab!=='music'?<MiniPlayer onOpen={onMusic}/>:null}<GlassSurface material="clear" radius={29} style={{marginHorizontal:16,marginBottom:10,marginTop:5}} contentStyle={{minHeight:67,flexDirection:'row',alignItems:'center',paddingHorizontal:6,paddingVertical:6}}>
    {([{id:'chats',label:'Чаты',icon:'chatbubbles-outline',onPress:onChats},{id:'people',label:'Люди',icon:'people-outline',onPress:onNewChat},{id:'music',label:'Музыка',icon:'headset-outline',onPress:onMusic},{id:'ai',label:'AI',icon:'sparkles-outline',onPress:onAI},{id:'profile',label:'Профиль',icon:'person-circle-outline',onPress:onProfile}] as const).map(item=><Pressable key={item.id} onPress={item.onPress} accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{selected:activeTab===item.id}} style={({pressed})=>({flex:1,alignItems:'center',opacity:pressed?.6:1})}><View style={{width:'100%',gap:5,alignItems:'center',paddingVertical:8,borderRadius:20,backgroundColor:activeTab===item.id?t.accentSoft:'transparent',borderWidth:1,borderColor:activeTab===item.id?t.glassBorder:'transparent'}}><Icon name={item.icon} color={activeTab===item.id?t.accent:t.muted} size={21}/><Text style={{fontSize:10,color:activeTab===item.id?t.accent:t.muted,fontWeight:activeTab===item.id?'700':'600'}}>{item.label}</Text></View></Pressable>)}
  </GlassSurface></>;
}

function ChatRow({chat,api,userId,selected,typing,onPress}: {chat:Chat;api:Api;userId:string;selected:boolean;typing:boolean;onPress:()=>void}) {
  const t=useTheme();const last=chat.lastMessage;
  const preview=typing?'Печатает…':last?`${last.senderId===userId?'Ты: ':''}${last.text|| (last.attachment?attachmentLabel(last.attachment):'Сообщение')}`:'Напиши первое сообщение';
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${chat.peer.displayName}${chat.unreadCount?`, непрочитанных ${chat.unreadCount}`:''}`} style={({pressed})=>({flexDirection:'row',gap:13,paddingHorizontal:12,paddingVertical:14,borderRadius:24,marginBottom:6,borderWidth:1,borderColor:selected?(t.black?'rgba(255,255,255,0.24)':t.dark?'rgba(155,181,255,0.28)':'rgba(255,255,255,0.98)'):'transparent',backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent',shadowColor:t.shadow,shadowOpacity:selected?.06:0,shadowRadius:12,shadowOffset:{width:0,height:4}})}><Avatar user={chat.peer} api={api}/><View style={{flex:1,justifyContent:'center',gap:8}}><View style={{flexDirection:'row',gap:5,alignItems:'center'}}><View style={{flex:1,flexDirection:'row',alignItems:'center',gap:5}}><Text numberOfLines={1} style={{flexShrink:1,color:t.text,fontSize:15,fontWeight:'700',letterSpacing:-.2}}>{chat.peer.displayName}</Text><StatusEmoji user={chat.peer} size={15}/></View>{last?<Text style={{color:chat.unreadCount?t.accent:t.muted,fontSize:10}}>{formatListTime(last.createdAt)}</Text>:null}</View><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{flex:1,color:typing?t.accent:t.muted,fontSize:12,fontWeight:typing?'600':'400'}}>{preview}</Text>{chat.unreadCount>0?<View style={{minWidth:21,height:21,borderRadius:11,backgroundColor:t.accent,alignItems:'center',justifyContent:'center',paddingHorizontal:6}}><Text style={{color:t.onAccent,fontSize:10,fontWeight:'700'}}>{chat.unreadCount>99?'99+':chat.unreadCount}</Text></View>:last?.senderId===userId?<Icon name={chat.peerLastReadMessageId>=last.id?'checkmark-done':'checkmark'} size={16} color={chat.peerLastReadMessageId>=last.id?t.accent:t.subtle}/>:null}</View></View></Pressable>;
}

function SavedRow({count,last,selected,onPress}:{count:number;last?:SavedItem;selected:boolean;onPress:()=>void}) {
  const t=useTheme();
  const preview=last?(last.text||(last.attachment?attachmentLabel(last.attachment):'Запись')):'Заметки, файлы и сохранённые сообщения';
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Избранное, записей: ${count}`} style={({pressed})=>({flexDirection:'row',gap:13,paddingHorizontal:12,paddingVertical:14,borderRadius:24,marginBottom:6,borderWidth:1,borderColor:selected?t.glassBorder:'transparent',backgroundColor:selected?t.accentSoft:pressed?(t.dark?'rgba(255,255,255,0.09)':'rgba(255,255,255,0.62)'):'transparent'})}><View style={{width:54,height:54,borderRadius:19,backgroundColor:t.accent,alignItems:'center',justifyContent:'center'}}><Icon name="bookmark" color={t.onAccent} size={25}/></View><View style={{flex:1,justifyContent:'center',gap:8}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{flex:1,color:t.text,fontSize:15,fontWeight:'700',letterSpacing:-.2}}>Избранное</Text>{last?<Text style={{color:t.muted,fontSize:10}}>{formatListTime(last.savedAt)}</Text>:null}</View><Text numberOfLines={1} style={{color:t.muted,fontSize:12}}>{preview}</Text></View></Pressable>;
}
