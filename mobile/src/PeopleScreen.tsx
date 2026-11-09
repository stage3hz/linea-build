import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, View } from 'react-native';
import { Text, TextInput } from './typography';
import { KeyboardSafeView } from './keyboard';
import type { Api } from './api';
import { Avatar, Empty, Icon, IconButton, Notice } from './components';
import { useTheme } from './theme';
import { GlassSurface } from './glass';
import type { Chat, User } from './types';
import { StatusEmoji } from './StatusEmoji';
import { UserProfile } from './UserProfile';
import { refreshFriendRequests, useFriendRequests } from './friendRequests';
import type { FriendRequest } from './types';
import { useTabInset } from './tabInset';
import { CallHistory } from './calls/CallHistory';
import { useCallHistory } from './calls/CallProvider';
import { unseenMissedCount } from './calls/callLog';

export function PeopleScreen({api,onBack,onOpen}: {api:Api;onBack:()=>void;onOpen:(chat:Chat)=>void}) {
  const tabInset = useTabInset();
  const t=useTheme();const [query,setQuery]=useState('');const [users,setUsers]=useState<User[]>([]);const [loading,setLoading]=useState(false);const [creating,setCreating]=useState<string|null>(null);const [error,setError]=useState('');const sequence=useRef(0);const [friends,setFriends]=useState<User[]>([]);const [profile,setProfile]=useState<User|null>(null);
  const loadFriends=()=>{api.contacts().then(result=>setFriends(result.users)).catch(()=>{});};
  const requests=useFriendRequests();
  // A request accepted on any device (or by the other person) changes the friends list too.
  useEffect(loadFriends,[api,requests.version]);
  useEffect(()=>{void refreshFriendRequests(api);},[api]);
  const [acting,setActing]=useState<string|null>(null);
  const act=async(id:string,run:()=>Promise<unknown>)=>{setActing(id);setError('');try{await run();}catch(e){setError(e instanceof Error?e.message:'Не получилось.');}finally{setActing(null);void refreshFriendRequests(api);}};
  const searching=query.trim().length>=2;
  useEffect(()=>{
    const seq=++sequence.current;
    if(query.trim().length<2){setUsers([]);setLoading(false);setError('');return;}
    setLoading(true);const timer=setTimeout(()=>{api.users(query.trim()).then(result=>{if(seq===sequence.current){setUsers(result.users);setError('');}}).catch(e=>{if(seq===sequence.current)setError(e.message);}).finally(()=>{if(seq===sequence.current)setLoading(false);});},300);
    return ()=>clearTimeout(timer);
  },[query,api]);
  useEffect(()=>()=>{sequence.current++;},[]);
  const open=async(user:User)=>{setCreating(user.id);setError('');try{const {chat}=await api.createChat(user.id);Keyboard.dismiss();onOpen(chat);}catch(e){setError(e instanceof Error?e.message:'Не удалось создать чат.');}finally{setCreating(null);}};
  // «Звонки» (F9): recent calls from the local history, with a badge for missed calls not read yet.
  const [tab,setTab]=useState<'friends'|'calls'>('friends');const missed=unseenMissedCount(useCallHistory());
  const segment=(id:'friends'|'calls',label:string,badge?:number)=><Pressable key={id} onPress={()=>{if(tab!==id){setTab(id);Keyboard.dismiss();}}} accessibilityRole="tab" accessibilityState={{selected:tab===id}} accessibilityLabel={badge?`${label}, пропущенных ${badge}`:label} style={{flex:1,height:36,borderRadius:18,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6,backgroundColor:tab===id?t.accent:'transparent'}}><Text style={{fontSize:13,fontWeight:'700',color:tab===id?t.onAccent:t.muted}}>{label}</Text>{badge?<View style={{minWidth:18,height:18,borderRadius:9,paddingHorizontal:5,alignItems:'center',justifyContent:'center',backgroundColor:tab===id?t.onAccent:t.danger}}><Text maxFontSizeMultiplier={1} style={{fontSize:11,fontWeight:'700',color:tab===id?t.accent:'#FFFFFF'}}>{badge>99?'99+':String(badge)}</Text></View>:null}</Pressable>;
  return <KeyboardSafeView style={{flex:1,backgroundColor:'transparent'}}>
    <GlassSurface material="clear" radius={27} style={{marginHorizontal:14,marginTop:12}} contentStyle={{flexDirection:'row',alignItems:'center',padding:10,gap:9,minHeight:72}}><View style={{flex:1,gap:4,paddingLeft:6}}><Text style={{fontSize:20,fontWeight:'700',letterSpacing:-.5,color:t.text}}>Люди</Text><Text style={{fontSize:11,color:t.muted}}>{tab==='calls'?'Недавние звонки':'Друзья, заявки и поиск по @имени'}</Text></View></GlassSurface>
    <GlassSurface material="regular" radius={22} shadow={false} style={{marginHorizontal:17,marginTop:14}} contentStyle={{flexDirection:'row',padding:4,gap:4}}>{segment('friends','Друзья')}{segment('calls','Звонки',missed)}</GlassSurface>
    {tab==='calls'?<View style={{flex:1,marginTop:14}}><CallHistory api={api} onOpen={onOpen} bottomInset={tabInset}/></View>:<>
    <GlassSurface material="regular" radius={24} shadow={false} style={{marginHorizontal:17,marginTop:14,marginBottom:17}} contentStyle={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:15,minHeight:54}}><Icon name="search-outline" color={t.accent} size={21}/><TextInput autoFocus={Platform.OS==='web'} autoCapitalize="none" autoCorrect={false} value={query} onChangeText={setQuery} accessibilityLabel="Ник или имя пользователя" placeholder="@имя или имя" placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} style={{flex:1,color:t.text,fontSize:15,paddingVertical:13}} maxLength={50}/>{loading?<ActivityIndicator color={t.accent} size="small"/>:query?<IconButton name="close-circle" label="Очистить поиск" onPress={()=>setQuery('')} color={t.muted} size={18} style={{width:30}}/>:null}</GlassSurface>
    {error?<View style={{paddingHorizontal:17,paddingBottom:12}}><Notice text={error} error/></View>:null}
    {(query.trim().length<2?friends:users).length?<Text style={{fontSize:10,fontWeight:'700',letterSpacing:1.7,color:t.muted,paddingHorizontal:26,paddingBottom:12}}>{query.trim().length<2?`ДРУЗЬЯ  ${friends.length}`:'РЕЗУЛЬТАТЫ ПОИСКА'}</Text>:null}
    <FlatList ListHeaderComponent={!searching&&(requests.incoming.length||requests.outgoing.length)?<View style={{gap:6,paddingBottom:12}}>{requests.incoming.length?<RequestSection title={`ЗАЯВКИ В ДРУЗЬЯ  ${requests.incoming.length}`} items={requests.incoming} api={api} acting={acting} onProfile={setProfile} actions={item=>[{label:'Принять',icon:'checkmark',primary:true,onPress:()=>void act(item.user.id,()=>api.acceptFriend(item.user.id))},{label:'Отклонить',icon:'close',onPress:()=>void act(item.user.id,()=>api.dropFriendRequest(item.user.id))}]}/>:null}{requests.outgoing.length?<RequestSection title={`ОТПРАВЛЕННЫЕ  ${requests.outgoing.length}`} items={requests.outgoing} api={api} acting={acting} onProfile={setProfile} note="Ждёт ответа" actions={item=>[{label:'Отменить заявку',icon:'close',onPress:()=>void act(item.user.id,()=>api.dropFriendRequest(item.user.id))}]}/>:null}</View>:null} keyboardDismissMode="on-drag" data={query.trim().length<2?friends:users} keyExtractor={u=>u.id} keyboardShouldPersistTaps="handled" contentContainerStyle={{paddingHorizontal:14,paddingBottom:24+tabInset,flexGrow:1}} ListEmptyComponent={!loading?<View style={{flex:1,justifyContent:'center',paddingBottom:35}}><Empty icon="people-outline" title={query.trim().length<2?'Кому напишем?':'Пока никого'} description={query.trim().length<2?'Введи @имя целиком или его первые 4 символа, либо имя полностью.':query.trim().replace(/^@/,'').length<4?'По началу @имени ищется с 4 символов. Введи ещё или напиши @имя целиком.':'По этому запросу никого нет. Проверь написание @имени.'}/></View>:null} renderItem={({item})=><Pressable disabled={!!creating} onPress={()=>void open(item)} accessibilityRole="button" style={({pressed})=>({flexDirection:'row',alignItems:'center',gap:14,padding:14,marginBottom:7,borderRadius:24,borderWidth:1,borderColor:pressed?t.border:'transparent',backgroundColor:pressed?(t.dark?'rgba(255,255,255,0.07)':'rgba(255,255,255,0.5)'):'transparent',opacity:creating&&creating!==item.id?.45:1})}><Avatar user={item} api={api}/><View style={{flex:1,gap:6}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{fontSize:16,color:t.text,fontWeight:'600',letterSpacing:-.2,flexShrink:1}}>{item.displayName}</Text><StatusEmoji user={item} size={15}/></View><Text style={{fontSize:12,color:t.muted}}>@{item.username}</Text></View><IconButton name="information-circle-outline" label={`Профиль ${item.displayName}`} onPress={()=>setProfile(item)} color={t.muted} size={22} style={{width:38,height:40}}/>{creating===item.id?<ActivityIndicator color={t.accent}/>:<View style={{height:38,width:38,borderRadius:18,backgroundColor:t.accentSoft,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:t.border}}><Icon name="chatbubble-outline" size={19} color={t.accent}/></View>}</Pressable>}/>
    </>}
    {profile?<UserProfile api={api} user={profile} onClose={()=>{setProfile(null);loadFriends();void refreshFriendRequests(api);}} onMessage={user=>void open(user)}/>:null}
  </KeyboardSafeView>;
}

type RequestAction = { label: string; icon: React.ComponentProps<typeof Icon>['name']; onPress: () => void; primary?: boolean };
function RequestSection({title,items,api,acting,actions,onProfile,note}:{title:string;items:FriendRequest[];api:Api;acting:string|null;actions:(item:FriendRequest)=>RequestAction[];onProfile:(user:User)=>void;note?:string}) {
  const t=useTheme();
  return <View>
    <Text style={{fontSize:10,fontWeight:'700',letterSpacing:1.7,color:t.muted,paddingHorizontal:12,paddingBottom:10,paddingTop:4}}>{title}</Text>
    {items.map(item=><View key={item.user.id} style={{flexDirection:'row',alignItems:'center',gap:12,padding:12,marginBottom:6,borderRadius:22,borderWidth:1,borderColor:t.border,backgroundColor:t.dark?'rgba(255,255,255,0.04)':'rgba(255,255,255,0.45)',opacity:acting&&acting!==item.user.id?.5:1}}>
      <Pressable onPress={()=>onProfile(item.user)} accessibilityRole="button" accessibilityLabel={`Профиль ${item.user.displayName}`} style={{flexDirection:'row',alignItems:'center',gap:12,flex:1}}>
        <Avatar user={item.user} api={api}/>
        <View style={{flex:1,gap:4}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{fontSize:15,color:t.text,fontWeight:'600',flexShrink:1}}>{item.user.displayName}</Text><StatusEmoji user={item.user} size={14}/></View><Text numberOfLines={1} style={{fontSize:12,color:t.muted}}>{note?`@${item.user.username} · ${note}`:`@${item.user.username}`}</Text></View>
      </Pressable>
      {acting===item.user.id?<ActivityIndicator color={t.accent}/>:actions(item).map(a=><Pressable key={a.label} disabled={!!acting} onPress={a.onPress} accessibilityRole="button" accessibilityLabel={`${a.label}: ${item.user.displayName}`} style={({pressed})=>({height:38,width:38,borderRadius:19,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:a.primary?'transparent':t.border,backgroundColor:a.primary?t.accent:'transparent',opacity:pressed?.6:1})}><Icon name={a.icon} size={19} color={a.primary?t.onAccent:t.muted}/></Pressable>)}
    </View>)}
  </View>;
}
