import React,{useEffect,useRef,useState} from 'react';
import { ActivityIndicator, Animated, AppState, FlatList, Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import {Image} from 'expo-image';
import {useEvent} from 'expo';
import {useVideoPlayer,VideoView} from 'expo-video';
import {setAudioModeAsync,useAudioPlayer,useAudioPlayerStatus} from 'expo-audio';
import * as Sharing from 'expo-sharing';
import type {Api} from '../api';
import type {Attachment} from '../types';
import {Button,Icon,InsetView,IconButton,Notice} from '../components';
import {useTheme,formatSize} from '../theme';
import {GlassStage,GlassSurface} from '../glass';
import {useMusic} from '../music/MusicProvider';
import {mediaPreviewKind} from './formats';
import {loadMedia,useMedia} from './mediaCache';
import {ProgressRing} from './MediaBubble';
import {Gesture,GestureDetector,GestureHandlerRootView} from 'react-native-gesture-handler';
import Reanimated,{interpolate,runOnJS,useAnimatedStyle,useSharedValue,withSpring,withTiming} from 'react-native-reanimated';

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

/** Audio files and documents: opened from the local cache once loaded (no second download). */
export function AttachmentViewer({api,attachment,onClose}:{api:Api;attachment:Attachment|null;onClose:()=>void}){
  const t=useTheme(),music=useMusic();
  const media=useMedia(api,attachment,true);
  const [saveError,setSaveError]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>{if(attachment&&mediaPreviewKind(attachment)==='audio')music.stop();setSaveError('');},[attachment?.id]);
  const save=async()=>{
    if(!media.uri||!attachment)return;setSaving(true);setSaveError('');
    try{if(!await Sharing.isAvailableAsync())throw new Error('На устройстве недоступно меню сохранения.');await Sharing.shareAsync(media.uri,{mimeType:attachment.mimeType,dialogTitle:attachment.name});}
    catch(error){setSaveError(error instanceof Error?error.message:'Не удалось сохранить файл.');}finally{setSaving(false);}
  };
  const kind=attachment?mediaPreviewKind(attachment):'file';
  return <Modal visible={!!attachment} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
    <GlassStage><InsetView style={{flex:1,paddingHorizontal:16}}>
      <View style={{flexDirection:'row',gap:12,alignItems:'center',paddingVertical:12}}><IconButton name="close" label="Закрыть просмотр" onPress={onClose}/><View style={{flex:1,gap:4}}><Text numberOfLines={1} style={{color:t.text,fontWeight:'700',fontSize:16}}>{attachment?.name}</Text><Text style={{color:t.muted,fontSize:12}}>{attachment?formatSize(attachment.size):''}</Text></View><IconButton name="share-outline" label="Сохранить или поделиться файлом" disabled={media.status!=='ready'||saving} onPress={()=>void save()}/></View>
      {media.status==='loading'||media.status==='idle'?<View style={{flex:1,justifyContent:'center',alignItems:'center',gap:18}}><View style={{width:64,height:64,alignItems:'center',justifyContent:'center'}}><ProgressRing progress={media.progress} size={64} color={t.accent} track={t.surface2}/><Text style={{color:t.text,fontSize:13,fontWeight:'700'}}>{Math.round(media.progress*100)}%</Text></View><Text style={{color:t.muted}}>Загрузка и проверка…</Text></View>:null}
      {media.status==='error'?<View style={{flex:1,justifyContent:'center',gap:18}}><Notice error text={media.error||'Не удалось открыть файл.'}/><Button label="Повторить загрузку" onPress={()=>void media.start().catch(()=>{})}/></View>:null}
      {media.status==='ready'&&media.uri&&attachment?<React.Fragment key={media.uri}>
        {kind==='photo'?<PhotoPlayer uri={media.uri} name={attachment.name}/>:kind==='video'?<VideoPlayer uri={media.uri}/>:kind==='audio'?<AudioPlayer uri={media.uri} name={attachment.name}/>:<View style={{flex:1,justifyContent:'center',gap:16,alignItems:'center'}}><Icon name="document-text-outline" size={64} color={t.accent}/><Text style={{color:t.muted,fontSize:13,textAlign:'center'}}>Файл загружен и проверен. Открой его в подходящем приложении или сохрани.</Text><View style={{alignSelf:'stretch'}}><Button label="Открыть в…" icon="open-outline" onPress={()=>void save()} loading={saving}/></View></View>}
      </React.Fragment>:null}
      {saveError?<Notice error text={saveError}/>:null}
    </InsetView></GlassStage>
  </Modal>;
}

function GalleryPage({api,attachment,width,height,active}:{api:Api;attachment:Attachment;width:number;height:number;active:boolean}){
  const kind=mediaPreviewKind(attachment),media=useMedia(api,attachment,active||kind==='photo');
  const thumb=attachment.preview?`data:${attachment.preview.mimeType};base64,${attachment.preview.base64}`:null;
  return <View style={{width,height,alignItems:'center',justifyContent:'center'}}>
    {media.status!=='ready'&&thumb?<Image source={{uri:thumb}} style={{position:'absolute',width,height:height*0.8}} contentFit="contain" blurRadius={kind==='photo'?16:0}/>:null}
    {media.status==='ready'&&media.uri?(kind==='photo'?<ScrollView style={{width,height}} contentContainerStyle={{width,height,alignItems:'center',justifyContent:'center'}} maximumZoomScale={5} minimumZoomScale={1} centerContent showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} bouncesZoom><Image source={{uri:media.uri}} style={{width,height}} contentFit="contain" transition={150}/></ScrollView>:active?<View style={{width,height}}><VideoPlayer uri={media.uri}/></View>:<Icon name="play-circle" size={64} color="#FFF"/>):null}
    {media.status==='loading'||media.status==='idle'?<Pressable onPress={()=>media.status==='loading'?media.cancel():void media.start().catch(()=>{})} accessibilityRole="button" accessibilityLabel={media.status==='loading'?'Отменить загрузку':'Загрузить'} style={{width:60,height:60,borderRadius:30,backgroundColor:'rgba(0,0,0,0.5)',alignItems:'center',justifyContent:'center'}}>{media.status==='loading'?<><ProgressRing progress={media.progress} size={60}/><Icon name="close" color="#FFF" size={24}/></>:<Icon name="arrow-down" color="#FFF" size={26}/>}</Pressable>:null}
    {media.status==='error'?<Pressable onPress={()=>void media.start().catch(()=>{})} style={{padding:16,alignItems:'center',gap:8}}><Icon name="refresh" color="#FFF" size={30}/><Text style={{color:'#FFF',textAlign:'center'}}>{media.error||'Не удалось загрузить.'} Нажми, чтобы повторить.</Text></Pressable>:null}
  </View>;
}

/** Telegram-style full-screen media: black background, swipe left/right between
 * the chat's photos and videos, swipe down to close, pinch to zoom a photo. */
export function MediaGallery({api,items,index,onClose}:{api:Api;items:Attachment[];index:number;onClose:()=>void}){
  const {width,height}=useWindowDimensions();
  const [current,setCurrent]=useState(index);const [chrome,setChrome]=useState(true);const [saving,setSaving]=useState(false);
  const music=useMusic();
  const y=useSharedValue(0);
  useEffect(()=>{setCurrent(index);y.value=0;},[index,items]);
  const visible=items.length>0;
  const item=items[current];
  useEffect(()=>{if(item&&mediaPreviewKind(item)==='video')music.stop();},[item?.id]);
  const close=useRef(onClose);close.current=onClose;
  const finish=()=>close.current();
  // Swipe up or down to close (UI thread); horizontal swipes page through the album.
  const pan=Gesture.Pan().activeOffsetY([-14,14]).failOffsetX([-16,16])
    .onUpdate(event=>{y.value=event.translationY;})
    .onEnd(event=>{
      if(Math.abs(event.translationY)>120||Math.abs(event.velocityY)>900){y.value=withTiming(event.translationY>0?height:-height,{duration:170},done=>{if(done)runOnJS(finish)();});}
      else y.value=withSpring(0,{damping:20,stiffness:260});
    });
  const pageStyle=useAnimatedStyle(()=>({transform:[{translateY:y.value},{scale:interpolate(Math.abs(y.value),[0,height/2],[1,0.86],'clamp')}]}));
  const backdropStyle=useAnimatedStyle(()=>({opacity:interpolate(Math.abs(y.value),[0,height/2],[1,0.15],'clamp')}));
  const chromeStyle=useAnimatedStyle(()=>({opacity:interpolate(Math.abs(y.value),[0,90],[1,0],'clamp')}));
  const share=async()=>{
    if(!item)return;setSaving(true);
    try{const uri=await loadMedia(api,item);if(await Sharing.isAvailableAsync())await Sharing.shareAsync(uri,{mimeType:item.mimeType,dialogTitle:item.name});}catch{}finally{setSaving(false);}
  };
  const kind=mediaPreviewKind(item||{name:'',mimeType:''});
  const title=kind==='video'?'Видео':'Фото';
  const circle={width:48,height:48,alignItems:'center' as const,justifyContent:'center' as const};
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait','landscape']}>
    <GestureHandlerRootView style={{flex:1}}>
    <Reanimated.View style={[StyleSheet.absoluteFill,{backgroundColor:'#000'},backdropStyle]}/>
    <GestureDetector gesture={pan}><Reanimated.View style={[{flex:1},pageStyle]}>
      <FlatList data={items} horizontal pagingEnabled keyExtractor={a=>a.id} initialScrollIndex={Math.min(index,Math.max(0,items.length-1))} getItemLayout={(_d,i)=>({length:width,offset:width*i,index:i})} showsHorizontalScrollIndicator={false} windowSize={3} initialNumToRender={1} maxToRenderPerBatch={2}
        onMomentumScrollEnd={e=>setCurrent(Math.round(e.nativeEvent.contentOffset.x/width))}
        renderItem={({item:page,index:i})=><Pressable onPress={()=>setChrome(v=>!v)} style={{width,height}}><GalleryPage api={api} attachment={page} width={width} height={height} active={i===current}/></Pressable>}/>
    </Reanimated.View></GestureDetector>
    {chrome?<Reanimated.View pointerEvents="box-none" style={[{position:'absolute',top:0,left:0,right:0},chromeStyle]}><InsetView bottom={false} pointerEvents="box-none">
      {/* Telegram-style floating controls: back, title pill, share. */}
      <View pointerEvents="box-none" style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12,paddingTop:6}}>
        <GlassSurface material="regular" radius={24} interactive contentStyle={circle}><Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" hitSlop={6} style={circle}><Icon name="chevron-back" color="#FFF" size={26}/></Pressable></GlassSurface>
        <View pointerEvents="box-none" style={{flex:1,alignItems:'center'}}><GlassSurface material="regular" radius={24} contentStyle={{minHeight:48,justifyContent:'center',alignItems:'center',paddingHorizontal:18}}>
          <Text style={{color:'#FFF',fontSize:15,fontWeight:'700'}}>{items.length>1?`${title} ${current+1} из ${items.length}`:title}</Text>
          {item?<Text style={{color:'rgba(255,255,255,0.7)',fontSize:11}}>{formatSize(item.size)}</Text>:null}
        </GlassSurface></View>
        <GlassSurface material="regular" radius={24} interactive contentStyle={circle}><Pressable onPress={()=>void share()} disabled={saving} accessibilityRole="button" accessibilityLabel="Сохранить или поделиться" hitSlop={6} style={[circle,{opacity:saving?.5:1}]}>{saving?<ActivityIndicator color="#FFF"/>:<Icon name="share-outline" color="#FFF" size={22}/>}</Pressable></GlassSurface>
      </View>
    </InsetView></Reanimated.View>:null}
    {chrome&&items.length>1?<Reanimated.View pointerEvents="none" style={[{position:'absolute',bottom:34,left:0,right:0,flexDirection:'row',justifyContent:'center',gap:6},chromeStyle]}>{items.slice(0,12).map((a,i)=><View key={a.id} style={{width:i===current?8:6,height:i===current?8:6,borderRadius:4,backgroundColor:i===current?'#FFF':'rgba(255,255,255,0.4)'}}/>)}</Reanimated.View>:null}
    </GestureHandlerRootView>
  </Modal>;
}
