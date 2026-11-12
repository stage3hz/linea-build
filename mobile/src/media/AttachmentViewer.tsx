import React,{useEffect,useRef,useState} from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import {Image} from 'expo-image';
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
import {ZoomableImage} from './ZoomableImage';
import {useSwipeDismiss} from './useSwipeDismiss';
import {VideoPlayerView} from './VideoPlayerView';
import {Gesture,GestureDetector,GestureHandlerRootView} from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';

const clock=(seconds:number)=>{const value=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;};

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

function PhotoPlayer({uri,name,onZoomChange}:{uri:string;name:string;onZoomChange:(zoomed:boolean)=>void}){
  const t=useTheme(),[failed,setFailed]=useState(false);
  // Pinch / double tap zoom on every platform (the ScrollView zoom props are iOS-only). The Modal's own
  // GestureHandlerRootView (AttachmentViewer) serves it; while zoomed, swipe-to-close is off.
  return <View style={{flex:1}}><ZoomableImage uri={uri} style={{flex:1,minHeight:300,width:'100%'}} accessibilityLabel={name} onError={()=>setFailed(true)} onZoomChange={onZoomChange}/>{failed?<Notice error text="Устройство не смогло показать изображение. Файл можно сохранить."/>:null}<Text style={{color:t.muted,fontSize:11,textAlign:'center',padding:8}}>Файл расшифрован только на этом устройстве.</Text></View>;
}

/**
 * Audio files and documents: opened from the local cache once loaded (no second download).
 * Telegram: the whole page follows the finger up or down and closes when let go far enough (the chat
 * shows through as it goes); a photo pinches and double-taps to zoom, and while zoomed its pan wins.
 */
export function AttachmentViewer({api,attachment,onClose}:{api:Api;attachment:Attachment|null;onClose:()=>void}){
  const t=useTheme(),music=useMusic();
  const media=useMedia(api,attachment,true);
  const [saveError,setSaveError]=useState(''),[saving,setSaving]=useState(false);
  const [zoomed,setZoomed]=useState(false);
  // The video player keeps every touch while its seek bar is dragged, its sheet is open or its screen is locked.
  const [playerBusy,setPlayerBusy]=useState(false);
  const swipe=useSwipeDismiss({onDismiss:onClose,enabled:!zoomed&&!playerBusy,minScale:0.9});
  // A new file opens in place (the page may have flown off with the previous one); reset only on open,
  // so a swiped-away page does not jump back while the Modal fades out.
  useEffect(()=>{if(attachment)swipe.reset();setZoomed(false);setPlayerBusy(false);},[attachment?.id]);
  useEffect(()=>{if(attachment&&mediaPreviewKind(attachment)==='audio')music.stop();setSaveError('');},[attachment?.id]);
  const save=async()=>{
    if(!media.uri||!attachment)return;setSaving(true);setSaveError('');
    try{if(!await Sharing.isAvailableAsync())throw new Error('На устройстве недоступно меню сохранения.');await Sharing.shareAsync(media.uri,{mimeType:attachment.mimeType,dialogTitle:attachment.name});}
    catch(error){setSaveError(error instanceof Error?error.message:'Не удалось сохранить файл.');}finally{setSaving(false);}
  };
  const kind=attachment?mediaPreviewKind(attachment):'file';
  // A loaded video takes the whole screen: the player's own controls close, keep and share, so the header is not
  // drawn a second time above them.
  const video=kind==='video'&&media.status==='ready'&&!!media.uri&&!!attachment;
  // Transparent so the chat shows behind a page being swiped away; the dim behind it fades with the drag.
  return <Modal visible={!!attachment} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
    <GestureHandlerRootView style={{flex:1}}>
    <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:'rgba(0,0,0,0.6)'},swipe.backdropStyle]}/>
    <GestureDetector gesture={swipe.gesture}><Reanimated.View style={[{flex:1,overflow:'hidden'},swipe.contentStyle]}>
    {video&&media.uri&&attachment?<View style={{flex:1,backgroundColor:'#000'}}>
      <VideoPlayerView key={media.uri} uri={media.uri} api={api} attachment={attachment} onClose={onClose} onShare={()=>void save()} onScrubbing={setPlayerBusy}/>
      {saveError?<InsetView pointerEvents="box-none" style={{position:'absolute',left:16,right:16,top:60}}><Notice error text={saveError}/></InsetView>:null}
    </View>:<GlassStage><InsetView style={{flex:1,paddingHorizontal:16}}>
      <View style={{flexDirection:'row',gap:12,alignItems:'center',paddingVertical:12}}><IconButton name="close" label="Закрыть просмотр" onPress={onClose}/><View style={{flex:1,gap:4}}><Text numberOfLines={1} style={{color:t.text,fontWeight:'700',fontSize:16}}>{attachment?.name}</Text><Text style={{color:t.muted,fontSize:12}}>{attachment?formatSize(attachment.size):''}</Text></View><IconButton name="share-outline" label="Сохранить или поделиться файлом" disabled={media.status!=='ready'||saving} onPress={()=>void save()}/></View>
      {media.status==='loading'||media.status==='idle'?<View style={{flex:1,justifyContent:'center',alignItems:'center',gap:18}}><View style={{width:64,height:64,alignItems:'center',justifyContent:'center'}}><ProgressRing progress={media.progress} size={64} color={t.accent} track={t.surface2}/><Text style={{color:t.text,fontSize:13,fontWeight:'700'}}>{Math.round(media.progress*100)}%</Text></View><Text style={{color:t.muted}}>Загрузка и проверка…</Text></View>:null}
      {media.status==='error'?<View style={{flex:1,justifyContent:'center',gap:18}}><Notice error text={media.error||'Не удалось открыть файл.'}/><Button label="Повторить загрузку" onPress={()=>void media.start().catch(()=>{})}/></View>:null}
      {media.status==='ready'&&media.uri&&attachment?<React.Fragment key={media.uri}>
        {kind==='photo'?<PhotoPlayer uri={media.uri} name={attachment.name} onZoomChange={setZoomed}/>:kind==='audio'?<AudioPlayer uri={media.uri} name={attachment.name}/>:<View style={{flex:1,justifyContent:'center',gap:16,alignItems:'center'}}><Icon name="document-text-outline" size={64} color={t.accent}/><Text style={{color:t.muted,fontSize:13,textAlign:'center'}}>Файл загружен и проверен. Открой его в подходящем приложении или сохрани.</Text><View style={{alignSelf:'stretch'}}><Button label="Открыть в…" icon="open-outline" onPress={()=>void save()} loading={saving}/></View></View>}
      </React.Fragment>:null}
      {saveError?<Notice error text={saveError}/>:null}
    </InsetView></GlassStage>}
    </Reanimated.View></GestureDetector>
    </GestureHandlerRootView>
  </Modal>;
}

function GalleryPage({api,attachment,width,height,active,onTap,onZoom,onClose,onShare,onPrev,onNext,onScrubbing}:{api:Api;attachment:Attachment;width:number;height:number;active:boolean;onTap:()=>void;onZoom:(zoomed:boolean)=>void;onClose:()=>void;onShare:()=>void;onPrev?:()=>void;onNext?:()=>void;onScrubbing:(busy:boolean)=>void}){
  const kind=mediaPreviewKind(attachment),media=useMedia(api,attachment,active||kind==='photo');
  const thumb=attachment.preview?`data:${attachment.preview.mimeType};base64,${attachment.preview.base64}`:null;
  const photo=media.status==='ready'&&!!media.uri&&kind==='photo';
  // A ready photo handles its own taps (single: chrome, double: zoom) and so does a playing video (its own
  // controls); everything else toggles the chrome on a tap.
  const own=photo||(active&&kind==='video'&&media.status==='ready'&&!!media.uri);
  return <Pressable onPress={own?undefined:onTap} disabled={own} style={{width,height,alignItems:'center',justifyContent:'center'}}>
    {media.status!=='ready'&&thumb?<Image source={{uri:thumb}} style={{position:'absolute',width,height:height*0.8}} contentFit="contain" blurRadius={kind==='photo'?16:0}/>:null}
    {media.status==='ready'&&media.uri?(kind==='photo'?<ZoomableImage uri={media.uri} style={{width,height}} transition={150} onTap={onTap} onZoomChange={onZoom}/>:active?<View style={{width,height}}><VideoPlayerView uri={media.uri} api={api} attachment={attachment} onClose={onClose} onShare={onShare} onPrev={onPrev} onNext={onNext} onScrubbing={onScrubbing}/></View>:<Icon name="play-circle" size={64} color="#FFF"/>):null}
    {media.status==='loading'||media.status==='idle'?<Pressable onPress={()=>media.status==='loading'?media.cancel():void media.start().catch(()=>{})} accessibilityRole="button" accessibilityLabel={media.status==='loading'?'Отменить загрузку':'Загрузить'} style={{width:60,height:60,borderRadius:30,backgroundColor:'rgba(0,0,0,0.5)',alignItems:'center',justifyContent:'center'}}>{media.status==='loading'?<><ProgressRing progress={media.progress} size={60}/><Icon name="close" color="#FFF" size={24}/></>:<Icon name="arrow-down" color="#FFF" size={26}/>}</Pressable>:null}
    {media.status==='error'?<Pressable onPress={()=>void media.start().catch(()=>{})} style={{padding:16,alignItems:'center',gap:8}}><Icon name="refresh" color="#FFF" size={30}/><Text style={{color:'#FFF',textAlign:'center'}}>{media.error||'Не удалось загрузить.'} Нажми, чтобы повторить.</Text></Pressable>:null}
  </Pressable>;
}

/** Telegram-style full-screen media: black background, swipe left/right between
 * the chat's photos and videos, swipe down to close, pinch to zoom a photo. */
export function MediaGallery({api,items,index,onClose}:{api:Api;items:Attachment[];index:number;onClose:()=>void}){
  const {width,height}=useWindowDimensions();
  const [current,setCurrent]=useState(index);const [chrome,setChrome]=useState(true);const [saving,setSaving]=useState(false);
  // While a photo is zoomed in, its own pan moves the picture: no album paging and no swipe-to-close.
  const [zoomed,setZoomed]=useState(false);
  // The same while the video player needs every touch: its seek bar is dragged, its sheet is open, its screen is locked.
  const [playerBusy,setPlayerBusy]=useState(false);
  const list=useRef<FlatList<Attachment>>(null);
  const music=useMusic();
  // Swipe up or down to close (UI thread, shared with AttachmentViewer); horizontal swipes page through the album.
  const swipe=useSwipeDismiss({onDismiss:onClose,enabled:!zoomed&&!playerBusy});
  useEffect(()=>{setCurrent(index);swipe.reset();setZoomed(false);setPlayerBusy(false);},[index,items]);
  const visible=items.length>0;
  const item=items[current];
  useEffect(()=>{if(item&&mediaPreviewKind(item)==='video')music.stop();},[item?.id]);
  const pan=swipe.gesture,pageStyle=swipe.contentStyle,backdropStyle=swipe.backdropStyle,chromeStyle=swipe.chromeStyle;
  const share=async()=>{
    if(!item)return;setSaving(true);
    try{const uri=await loadMedia(api,item);if(await Sharing.isAvailableAsync())await Sharing.shareAsync(uri,{mimeType:item.mimeType,dialogTitle:item.name});}catch{}finally{setSaving(false);}
  };
  const kind=mediaPreviewKind(item||{name:'',mimeType:''});
  const title=kind==='video'?'Видео':'Фото';
  // A loaded video is shown by the player, whose own controls close, keep and share: the floating controls and the
  // page dots (they would lie on its seek bar) are for photos and for a video that is still loading.
  const currentMedia=useMedia(api,item,false);
  const playerOn=kind==='video'&&currentMedia.status==='ready'&&!!currentMedia.uri;
  // The player's previous / next buttons turn the album like a swipe does.
  const go=(to:number)=>{if(to<0||to>=items.length)return;list.current?.scrollToIndex({index:to,animated:true});setCurrent(to);};
  const circle={width:48,height:48,alignItems:'center' as const,justifyContent:'center' as const};
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait','landscape']}>
    <GestureHandlerRootView style={{flex:1}}>
    <Reanimated.View style={[StyleSheet.absoluteFill,{backgroundColor:'#000'},backdropStyle]}/>
    <GestureDetector gesture={pan}><Reanimated.View style={[{flex:1},pageStyle]}>
      <FlatList ref={list} data={items} horizontal pagingEnabled scrollEnabled={!zoomed&&!playerBusy} keyExtractor={a=>a.id} initialScrollIndex={Math.min(index,Math.max(0,items.length-1))} getItemLayout={(_d,i)=>({length:width,offset:width*i,index:i})} showsHorizontalScrollIndicator={false} windowSize={3} initialNumToRender={1} maxToRenderPerBatch={2}
        onMomentumScrollEnd={e=>setCurrent(Math.round(e.nativeEvent.contentOffset.x/width))}
        renderItem={({item:page,index:i})=><GalleryPage api={api} attachment={page} width={width} height={height} active={i===current} onTap={()=>setChrome(v=>!v)} onZoom={setZoomed} onClose={onClose} onShare={()=>void share()} onPrev={i>0?()=>go(i-1):undefined} onNext={i<items.length-1?()=>go(i+1):undefined} onScrubbing={setPlayerBusy}/>}/>
    </Reanimated.View></GestureDetector>
    {chrome&&!playerOn?<Reanimated.View pointerEvents="box-none" style={[{position:'absolute',top:0,left:0,right:0},chromeStyle]}><InsetView bottom={false} pointerEvents="box-none">
      {/* Telegram-style floating controls: back, title pill, share. */}
      <View pointerEvents="box-none" style={{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12,paddingTop:6}}>
        <GlassSurface material="regular" radius={24} interactive contentStyle={circle}><Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" hitSlop={6} style={circle}><Icon name="chevron-back" color="#FFF" size={26}/></Pressable></GlassSurface>
        <View pointerEvents="box-none" style={{flex:1,alignItems:'center'}}><GlassSurface lens material="regular" radius={24} contentStyle={{minHeight:48,justifyContent:'center',alignItems:'center',paddingHorizontal:18}}>
          <Text style={{color:'#FFF',fontSize:15,fontWeight:'700'}}>{items.length>1?`${title} ${current+1} из ${items.length}`:title}</Text>
          {item?<Text style={{color:'rgba(255,255,255,0.7)',fontSize:11}}>{formatSize(item.size)}</Text>:null}
        </GlassSurface></View>
        <GlassSurface material="regular" radius={24} interactive contentStyle={circle}><Pressable onPress={()=>void share()} disabled={saving} accessibilityRole="button" accessibilityLabel="Сохранить или поделиться" hitSlop={6} style={[circle,{opacity:saving?.5:1}]}>{saving?<ActivityIndicator color="#FFF"/>:<Icon name="share-outline" color="#FFF" size={22}/>}</Pressable></GlassSurface>
      </View>
    </InsetView></Reanimated.View>:null}
    {chrome&&!playerOn&&items.length>1?<Reanimated.View pointerEvents="none" style={[{position:'absolute',bottom:34,left:0,right:0,flexDirection:'row',justifyContent:'center',gap:6},chromeStyle]}>{items.slice(0,12).map((a,i)=><View key={a.id} style={{width:i===current?8:6,height:i===current?8:6,borderRadius:4,backgroundColor:i===current?'#FFF':'rgba(255,255,255,0.4)'}}/>)}</Reanimated.View>:null}
    </GestureHandlerRootView>
  </Modal>;
}
