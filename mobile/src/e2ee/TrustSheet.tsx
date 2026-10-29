import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '../typography';
import { Button, Icon, Notice, Sheet } from '../components';
import { useTheme } from '../theme';
import type { MessengerStore } from '../useMessenger';
import type { TrustSnapshot } from './types';

export function TrustSheet({visible,onClose,peerId,store}:{visible:boolean;onClose:()=>void;peerId:string;store:MessengerStore}) {
  const t=useTheme();const [snapshot,setSnapshot]=useState<TrustSnapshot|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [checked,setChecked]=useState(false);const revision=useRef(0);
  const refresh=async()=>{
    const current=++revision.current;setLoading(true);setError('');setChecked(false);
    try{const next=await store.trustSnapshot(peerId);if(current===revision.current)setSnapshot(next);}
    catch(e){if(current===revision.current)setError(e instanceof Error?e.message:'Не удалось получить ключи.');}
    finally{if(current===revision.current)setLoading(false);}
  };
  useEffect(()=>{setSnapshot(null);if(visible)void refresh();return()=>{++revision.current;};},[visible,peerId,store.trustSnapshot]);
  const approve=async()=>{
    if(!snapshot||!checked)return;const current=revision.current;setBusy(true);setError('');
    try{await store.approveDevices(snapshot);if(current===revision.current){setBusy(false);onClose();}}
    catch(e){if(current===revision.current)setError(e instanceof Error?e.message:'Не удалось сохранить проверку ключей.');}
    finally{if(current===revision.current)setBusy(false);}
  };
  const pending=snapshot?.devices.some(device=>!device.trusted);
  return <Sheet visible={visible} title="Защита чата" onClose={onClose}><View style={{gap:16}}>
    <Text style={{color:t.muted,fontSize:14,lineHeight:22}}>Сверь коды при личной встрече или по уже доверенному каналу связи. Для одной пары устройств код на обоих экранах должен совпадать. Приватные ключи здесь не показываются.</Text>
    {loading?<ActivityIndicator color={t.accent}/>:null}
    {error?<Notice text={error} error onRetry={()=>void refresh()}/>:null}
    {snapshot?.devices.map(device=><View key={`${device.userId}:${device.id}`} style={{padding:15,borderWidth:1,borderColor:device.trusted?t.border:t.accent,borderRadius:18,gap:10}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:9}}><Icon name={device.trusted?'shield-checkmark-outline':'shield-outline'} color={device.trusted?t.accent:t.danger}/><View style={{flex:1,gap:3}}><Text style={{color:t.text,fontWeight:'700',fontSize:15}}>{device.self?'Твоё другое устройство':'Устройство собеседника'}</Text><Text style={{color:t.muted,fontSize:12}}>{device.deviceName} · {device.trusted?'ты подтвердил этот ключ':'новый ключ'}</Text></View></View>
      <Text selectable style={{color:t.text,fontSize:15,lineHeight:24,fontVariant:['tabular-nums'],letterSpacing:.8}}>{device.code}</Text>
    </View>)}
    {pending?<><Pressable accessibilityRole="checkbox" accessibilityState={{checked}} onPress={()=>setChecked(value=>!value)} style={{flexDirection:'row',gap:10,paddingVertical:8,alignItems:'center'}}><Icon name={checked?'checkbox':'square-outline'} color={t.accent}/><Text style={{flex:1,color:t.text,fontSize:13,lineHeight:20}}>Я сверил все новые коды с собеседником и своими устройствами.</Text></Pressable><Button label="Подтвердить проверенные ключи" icon="shield-checkmark-outline" disabled={!checked||loading} loading={busy} onPress={()=>void approve()}/></>:snapshot?<Notice text="Ключи этих устройств подтверждены. При появлении нового устройства приложение снова запросит проверку."/>:null}
    <Text style={{color:t.muted,fontSize:12,lineHeight:19}}>Смена пароля не восстанавливает утраченные ключи истории. На новом телефоне сообщения, отправленные до добавления его ключа, могут быть недоступны.</Text>
  </View></Sheet>;
}
