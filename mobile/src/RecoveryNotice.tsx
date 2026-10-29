import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from './typography';
import { Button, Icon, Notice, Sheet } from './components';
import { GlassSurface } from './glass';
import { useTheme } from './theme';
import type { RecoveryRequest } from './types';

export function RecoveryNotice({requests,error,onRefresh,onCancel}:{requests:RecoveryRequest[];error:string;onRefresh:()=>Promise<void>;onCancel:(id:string)=>Promise<void>}) {
  const t=useTheme();const [visible,setVisible]=useState(false);const [busy,setBusy]=useState('');const [failure,setFailure]=useState('');
  const live=useRef(true);useEffect(()=>()=>{live.current=false;},[]);
  const cancel=async(id:string)=>{setBusy(id);setFailure('');try{await onCancel(id);}catch(e){if(live.current)setFailure(e instanceof Error?e.message:'Не удалось отменить запрос.');}finally{if(live.current)setBusy('');}};
  if(!requests.length&&!error)return null;
  return <View style={{paddingHorizontal:12,paddingTop:8,paddingBottom:6}}>
    {requests.length?<GlassSurface radius={18} material="regular" shadow={false}><Pressable accessibilityRole="button" accessibilityLabel="Запрошено восстановление аккаунта. Проверить запрос" onPress={()=>setVisible(true)} style={{padding:13,flexDirection:'row',alignItems:'center',gap:12,minHeight:54}}>
      <Icon name="shield-outline" color={t.danger}/><View style={{flex:1,gap:3}}><Text style={{color:t.text,fontWeight:'700',fontSize:14}}>Запрошено восстановление аккаунта</Text><Text style={{color:t.muted,fontSize:12,lineHeight:17}}>Если это не ты — открой запрос и отмени смену пароля.</Text></View><Icon name="chevron-forward" size={18} color={t.muted}/>
    </Pressable></GlassSurface>:<Notice text="Не удалось проверить запросы на восстановление аккаунта." error onRetry={()=>void onRefresh()}/>}
    <Sheet visible={visible} title="Восстановление аккаунта" onClose={()=>setVisible(false)}>
      <View style={{gap:16}}>
        <Text style={{color:t.muted,fontSize:14,lineHeight:21}}>Другое устройство подтвердило слово восстановления. Пока пароль не изменён, ты можешь отменить запрос. Название устройства указано самим клиентом.</Text>
        {failure?<Notice text={failure} error/>:null}
        {error?<Notice text="Список запросов не удалось обновить. Проверь подключение." error onRetry={()=>void onRefresh()}/>:null}
        {requests.map(request=><View key={request.id} style={{gap:10,padding:14,borderWidth:1,borderColor:t.border,borderRadius:18}}>
          <Text style={{color:t.text,fontWeight:'700',fontSize:16}}>{request.deviceName||'Новое устройство'}</Text>
          <Text style={{color:t.muted,fontSize:13,lineHeight:20}}>Запрошено: {new Date(request.createdAt).toLocaleString()}{'\n'}Смена пароля разрешится после: {new Date(request.readyAt).toLocaleTimeString()}</Text>
          <Button label="Это не я — отменить" danger icon="close-circle-outline" loading={busy===request.id} disabled={!!busy} onPress={()=>void cancel(request.id)}/>
        </View>)}
        {!requests.length?<Notice text="Активных запросов на восстановление нет."/>:null}
      </View>
    </Sheet>
  </View>;
}
