import React,{useEffect,useState} from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, View } from 'react-native';
import { Text } from '../typography';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Image} from 'expo-image';
import {useEvent} from 'expo';
import {useVideoPlayer,VideoView} from 'expo-video';
import {setAudioModeAsync,useAudioPlayer,useAudioPlayerStatus} from 'expo-audio';
import * as Sharing from 'expo-sharing';
import type {Api} from '../api';
import type {Attachment} from '../types';
import {Button,Icon,IconButton,Notice} from '../components';
import {useTheme,formatSize} from '../theme';
import {GlassStage,GlassSurface} from '../glass';
import {useMusic} from '../music/MusicProvider';
import {decryptAttachment} from '../e2ee/attachments';
import {mediaPreviewKind} from './formats';
import {ViewSession,type ViewState} from './ViewSession';

const clock=(seconds:number)=>{const value=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;};

function VideoPlayer({uri}:{uri:string}){
  const t=useTheme(),player=useVideoPlayer(uri,value=>{value.loop=false;value.audioMixingMode='doNotMix';});
  const {status,error}=useEvent(player,'statusChange',{status:player.status});
  useEffect(()=>{
    player.play();const subscription=AppState.addEventListener('change',state=>{if(state!=='active')player.pause();});
    return()=>{subscription.remove();try{player.pause();}catch{/* The native hook may have disposed first. */}};
  },[player]);
  return <View style={{flex:1,justifyContent:'center'}}>
    <VideoView player={player} style={{width:'100%',height:'78%',minHeight:220}} contentFit="contain" nativeControls fullscreenOptions={{enable:true}} allowsPictureInPicture={false}/>
    {status==='loading'?<ActivityIndicator color={t.accent}/>:null}
    {status==='error'?<Notice error text={`Устройство не смогло воспроизвести это видео. ${error?.message||'Можно сохранить файл и открыть совместимым проигрывателем.'}`}/>:null}
  </View>;
}

function AudioPlayer({uri,name}:{uri:string;name:string}){
  const t=useTheme(),player=useAudioPlayer(uri,{updateInterval:250}),status=useAudioPlayerStatus(player);
  const [error,setError]=useState(''),[barWidth,setBarWidth]=useState(1);
  useEffect(()=>{const subscription=AppState.addEventListener('change',state=>{if(state!=='active')player.pause();});return()=>{subscription.remove();try{player.pause();}catch{/* Already released by native hook. */}};},[player]);
  const seek=async(seconds:number)=>{try{await player.seekTo(Math.max(0,Math.min(status.duration,seconds)));}catch{setError('Не удалось перемотать аудио.');}};
  const toggle=async()=>{setError('');try{
    if(status.playing){player.pause();return;}
    await setAudioModeAsync({playsInSilentMode:true,shouldPlayInBackground:true,interruptionMode:'doNotMix',allowsRecording:false});
    if(status.didJustFinish)await player.seekTo(0);player.play();
  }catch{setError('Устройство не смогло воспроизвести это аудио.');}};
  const fraction=status.duration>0?Math.max(0,Math.min(1,status.currentTime/status.duration)):0;
  return <View style={{flex:1,justifyContent:'center',gap:24,paddingHorizontal:16}}>
    <GlassSurface radius={40} contentStyle={{padding:30,alignItems:'center',gap:20}}>
      <Icon name="musical-notes-outline" size={58} color={t.accent}/><Text style={{color:t.text,fontSize:19,fontWeight:'700',textAlign:'center'}}>{name}</Text>
      {!status.isLoaded?<ActivityIndicator color={t.accent}/>:null}
      <View style={{width:'100%',gap:8}}>
        <Pressable accessibilityRole="adjustable" accessibilityLabel="Позиция воспроизведения" accessibilityValue={{min:0,max:Math.floor(status.duration),now:Math.floor(status.currentTime)}} accessibilityActions={[{name:'increment',label:'Вперёд 15 секунд'},{name:'decrement',label:'Назад 15 секунд'}]} onAccessibilityAction={event=>void seek(status.currentTime+(event.nativeEvent.actionName==='increment'?15:-15))} disabled={!status.isLoaded} onLayout={event=>setBarWidth(Math.max(1,event.nativeEvent.layout.width))} onPress={event=>void seek(event.nativeEvent.locationX/barWidth*status.duration)} style={{height:36,justifyContent:'center'}}>
          <View style={{height:6,borderRadius:3,backgroundColor:t.surface2,overflow:'hidden'}}><View style={{width:`${fraction*100}%`,height:6,backgroundColor:t.accent}}/></View>
        </Pressable>
        <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{color:t.muted,fontSize:12}}>{clock(status.currentTime)}</Text><Text style={{color:t.muted,fontSize:12}}>{clock(status.duration)}</Text></View>
      </View>
      <View style={{flexDirection:'row',gap:24,alignItems:'center'}}><IconButton name="play-back" label="Назад 15 секунд" disabled={!status.isLoaded} onPress={()=>void seek(status.currentTime-15)}/><IconButton name={status.playing?'pause':'play'} label={status.playing?'Пауза':'Воспроизвести'} size={30} disabled={!status.isLoaded} onPress={()=>void toggle()} style={{width:64,height:64,borderRadius:25}}/><IconButton name="play-forward" label="Вперёд 15 секунд" disabled={!status.isLoaded} onPress={()=>void seek(status.currentTime+15)}/></View>
    </GlassSurface>
    {error||status.error?<Notice error text={error||'Устройство не поддерживает этот аудиофайл. Можно сохранить его и открыть другим проигрывателем.'}/>:null}
  </View>;
}

function PhotoPlayer({uri,name}:{uri:string;name:string}){
  const t=useTheme(),[failed,setFailed]=useState(false);
  return <View style={{flex:1}}><ScrollView contentContainerStyle={{flexGrow:1}} maximumZoomScale={4} minimumZoomScale={1} centerContent><Image source={{uri}} style={{flex:1,minHeight:300,width:'100%'}} contentFit="contain" accessibilityLabel={name} onError={()=>setFailed(true)}/></ScrollView>{failed?<Notice error text="Устройство не смогло показать изображение. Файл можно сохранить."/>:null}<Text style={{color:t.muted,fontSize:11,textAlign:'center',padding:8}}>Файл расшифрован только на этом устройстве.</Text></View>;
}

export function AttachmentViewer({api,attachment,onClose}:{api:Api;attachment:Attachment|null;onClose:()=>void}){
  const t=useTheme(),music=useMusic();
  const owner=attachment?`${api.base}|${api.token}|${attachment.id}|${attachment.encryption?.fileKeyId}`:'';
  const [snapshot,setSnapshot]=useState<{owner:string;state:ViewState}>({owner:'',state:{phase:'closed'}}),[retry,setRetry]=useState(0),[saveError,setSaveError]=useState(''),[saving,setSaving]=useState(false);
  const state:ViewState=snapshot.owner===owner?snapshot.state:{phase:'loading'};
  useEffect(()=>{
    if(!attachment)return;
    if(['video','audio'].includes(mediaPreviewKind(attachment)))music.stop();setSaveError('');let live=true;
    const session=new ViewSession(next=>{if(live)setSnapshot({owner,state:next});});
    void session.open(signal=>decryptAttachment(api,attachment,signal));
    return()=>{live=false;session.close();};
  },[api,attachment,owner,retry,music.stop]);
  const save=async()=>{
    if(!state.uri||!attachment)return;setSaving(true);setSaveError('');
    try{if(!await Sharing.isAvailableAsync())throw new Error('На устройстве недоступно меню сохранения.');await Sharing.shareAsync(state.uri,{mimeType:attachment.mimeType,dialogTitle:attachment.name});}
    catch(error){setSaveError(error instanceof Error?error.message:'Не удалось сохранить файл.');}finally{setSaving(false);}
  };
  const kind=attachment?mediaPreviewKind(attachment):'file';
  return <Modal visible={!!attachment} animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen">
    <GlassStage><SafeAreaView style={{flex:1,paddingHorizontal:16}}>
      <View style={{flexDirection:'row',gap:12,alignItems:'center',paddingVertical:12}}><IconButton name="close" label="Закрыть просмотр" onPress={onClose}/><View style={{flex:1,gap:4}}><Text numberOfLines={1} style={{color:t.text,fontWeight:'700',fontSize:16}}>{attachment?.name}</Text><Text style={{color:t.muted,fontSize:12}}>{attachment?formatSize(attachment.size):''}{attachment?.media?.hdr&&attachment.media.hdr!=='sdr'?` · HDR ${attachment.media.hdr.toUpperCase()}`:''}</Text></View><IconButton name="share-outline" label="Сохранить или поделиться файлом" disabled={state.phase!=='ready'||saving} onPress={()=>void save()}/></View>
      {state.phase==='loading'?<View style={{flex:1,justifyContent:'center',alignItems:'center',gap:18}}><ActivityIndicator color={t.accent}/><Text style={{color:t.muted}}>Загрузка и проверка вложения…</Text><Text style={{color:t.subtle,fontSize:12}}>Закрытие отменит загрузку.</Text></View>:null}
      {state.phase==='error'?<View style={{flex:1,justifyContent:'center',gap:18}}><Notice error text={state.error||'Не удалось открыть файл.'}/><Button label="Повторить загрузку" onPress={()=>setRetry(value=>value+1)}/></View>:null}
      {state.phase==='ready'&&state.uri&&attachment?<React.Fragment key={state.uri}>
        {kind==='photo'?<PhotoPlayer uri={state.uri} name={attachment.name}/>:kind==='video'?<VideoPlayer uri={state.uri}/>:kind==='audio'?<AudioPlayer uri={state.uri} name={attachment.name}/>:<View style={{flex:1,justifyContent:'center',gap:16}}><Notice text="Файл проверен и расшифрован. Сохрани его или открой в подходящем приложении."/><Button label="Открыть файл" onPress={()=>void save()} loading={saving}/></View>}
      </React.Fragment>:null}
      {saveError?<Notice error text={saveError}/>:null}
    </SafeAreaView></GlassStage>
  </Modal>;
}
