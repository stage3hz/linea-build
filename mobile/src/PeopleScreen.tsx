import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, View } from 'react-native';
import { Text, TextInput } from './typography';
import { KeyboardSafeView } from './keyboard';
import type { Api } from './api';
import { Avatar, Empty, Icon, IconButton, Notice } from './components';
import { useTheme } from './theme';
import { GlassSurface } from './glass';
import type { Chat, User } from './types';
import { StatusEmoji } from './StatusEmoji';

export function PeopleScreen({api,onBack,onOpen}: {api:Api;onBack:()=>void;onOpen:(chat:Chat)=>void}) {
  const t=useTheme();const [query,setQuery]=useState('');const [users,setUsers]=useState<User[]>([]);const [loading,setLoading]=useState(false);const [creating,setCreating]=useState<string|null>(null);const [error,setError]=useState('');const sequence=useRef(0);
  useEffect(()=>{
    const seq=++sequence.current;
    if(query.trim().length<2){setUsers([]);setLoading(false);setError('');return;}
    setLoading(true);const timer=setTimeout(()=>{api.users(query.trim()).then(result=>{if(seq===sequence.current){setUsers(result.users);setError('');}}).catch(e=>{if(seq===sequence.current)setError(e.message);}).finally(()=>{if(seq===sequence.current)setLoading(false);});},300);
    return ()=>clearTimeout(timer);
  },[query,api]);
  useEffect(()=>()=>{sequence.current++;},[]);
  const open=async(user:User)=>{setCreating(user.id);setError('');try{const {chat}=await api.createChat(user.id);Keyboard.dismiss();onOpen(chat);}catch(e){setError(e instanceof Error?e.message:'Не удалось создать чат.');}finally{setCreating(null);}};
  return <KeyboardSafeView style={{flex:1,backgroundColor:'transparent'}}>
    <GlassSurface material="clear" radius={27} style={{marginHorizontal:14,marginTop:12}} contentStyle={{flexDirection:'row',alignItems:'center',padding:10,gap:9,minHeight:72}}><IconButton name="chevron-back" label="Назад" onPress={onBack}/><View style={{flex:1,gap:4}}><Text style={{fontSize:20,fontWeight:'700',letterSpacing:-.5,color:t.text}}>Новый разговор</Text><Text style={{fontSize:11,color:t.muted}}>Найди своего человека</Text></View></GlassSurface>
    <GlassSurface material="regular" radius={24} shadow={false} style={{marginHorizontal:17,marginTop:19,marginBottom:17}} contentStyle={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:15,minHeight:54}}><Icon name="search-outline" color={t.accent} size={21}/><TextInput autoCapitalize="none" autoCorrect={false} value={query} onChangeText={setQuery} accessibilityLabel="Ник или имя пользователя" placeholder="Ник или имя" placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark?'dark':'light'} style={{flex:1,color:t.text,fontSize:15,paddingVertical:13}} maxLength={50}/>{loading?<ActivityIndicator color={t.accent} size="small"/>:query?<IconButton name="close-circle" label="Очистить поиск" onPress={()=>setQuery('')} color={t.muted} size={18} style={{width:30}}/>:null}</GlassSurface>
    {error?<View style={{paddingHorizontal:17,paddingBottom:12}}><Notice text={error} error/></View>:null}
    {users.length?<Text style={{fontSize:10,fontWeight:'700',letterSpacing:1.7,color:t.muted,paddingHorizontal:26,paddingBottom:12}}>РЕЗУЛЬТАТЫ ПОИСКА</Text>:null}
    <FlatList data={users} keyExtractor={u=>u.id} keyboardShouldPersistTaps="handled" contentContainerStyle={{paddingHorizontal:14,paddingBottom:24,flexGrow:1}} ListEmptyComponent={!loading?<View style={{flex:1,justifyContent:'center',paddingBottom:35}}><Empty icon="people-outline" title={query.trim().length<2?'Кому напишем?':'Пока никого'} description={query.trim().length<2?'Введи хотя бы 2 символа ника или имени. Собеседник должен быть зарегистрирован на этом же сервере.':'По этому запросу нет пользователей. Проверь написание ника.'}/></View>:null} renderItem={({item})=><Pressable disabled={!!creating} onPress={()=>void open(item)} accessibilityRole="button" style={({pressed})=>({flexDirection:'row',alignItems:'center',gap:14,padding:14,marginBottom:7,borderRadius:24,borderWidth:1,borderColor:pressed?t.border:'transparent',backgroundColor:pressed?(t.dark?'rgba(255,255,255,0.07)':'rgba(255,255,255,0.5)'):'transparent',opacity:creating&&creating!==item.id?.45:1})}><Avatar user={item} api={api}/><View style={{flex:1,gap:6}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text numberOfLines={1} style={{fontSize:16,color:t.text,fontWeight:'600',letterSpacing:-.2,flexShrink:1}}>{item.displayName}</Text><StatusEmoji user={item} size={15}/></View><Text style={{fontSize:12,color:t.muted}}>@{item.username}</Text></View>{creating===item.id?<ActivityIndicator color={t.accent}/>:<View style={{height:38,width:38,borderRadius:18,backgroundColor:t.accentSoft,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:t.border}}><Icon name="chatbubble-outline" size={19} color={t.accent}/></View>}</Pressable>}/>
  </KeyboardSafeView>;
}
