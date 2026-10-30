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
  const y=useRef(new Animated.Value(0)).current;
  useEffect(()=>{setCurrent(index);y.setValue(0);},[index,items]);
  const visible=items.length>0;
  const item=items[current];
  useEffect(()=>{if(item&&mediaPreviewKind(item)==='video')music.stop();},[item?.id]);
  const close=useRef(onClose);close.current=onClose;
  const pan=useRef(PanResponder.create({
    onMoveShouldSetPanResponder:(_e,g)=>Math.abs(g.dy)>14&&Math.abs(g.dy)>Math.abs(g.dx)*1.6,
    onPanResponderMove:(_e,g)=>y.setValue(g.dy),
    onPanResponderRelease:(_e,g)=>{if(Math.abs(g.dy)>130||Math.abs(g.vy)>1.1)Animated.timing(y,{toValue:g.dy>0?height:-height,duration:170,useNativeDriver:true}).start(()=>close.current());else Animated.spring(y,{toValue:0,useNativeDriver:true,bounciness:5}).start();},
    onPanResponderTerminate:()=>Animated.spring(y,{toValue:0,useNativeDriver:true}).start(),
  })).current;
  const backdrop=y.interpolate({inputRange:[-height/2,0,height/2],outputRange:[0.2,1,0.2],extrapolate:'clamp'});
  const share=async()=>{
    if(!item)return;setSaving(true);
    try{const uri=await loadMedia(api,item);if(await Sharing.isAvailableAsync())await Sharing.shareAsync(uri,{mimeType:item.mimeType,dialogTitle:item.name});}catch{}finally{setSaving(false);}
  };
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait','landscape']}>
    <Animated.View style={[StyleSheet.absoluteFill,{backgroundColor:'#000',opacity:backdrop}]}/>
    <Animated.View style={{flex:1,transform:[{translateY:y}]}} {...pan.panHandlers}>
      <FlatList data={items} horizontal pagingEnabled keyExtractor={a=>a.id} initialScrollIndex={Math.min(index,Math.max(0,items.length-1))} getItemLayout={(_d,i)=>({length:width,offset:width*i,index:i})} showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e=>setCurrent(Math.round(e.nativeEvent.contentOffset.x/width))}
        renderItem={({item:page,index:i})=><Pressable onPress={()=>setChrome(v=>!v)} style={{width,height}}><GalleryPage api={api} attachment={page} width={width} height={height} active={i===current}/></Pressable>}/>
    </Animated.View>
    {chrome?<InsetView bottom={false} pointerEvents="box-none" style={{position:'absolute',top:0,left:0,right:0}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:10,paddingVertical:8,backgroundColor:'rgba(0,0,0,0.35)'}}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" style={{width:42,height:42,alignItems:'center',justifyContent:'center'}}><Icon name="chevron-back" color="#FFF" size={26}/></Pressable>
        <View style={{flex:1}}><Text style={{color:'#FFF',fontSize:16,fontWeight:'700'}}>{items.length>1?`${current+1} из ${items.length}`:mediaPreviewKind(item||{name:'',mimeType:''})==='video'?'Видео':'Фото'}</Text>{item?<Text style={{color:'rgba(255,255,255,0.7)',fontSize:12}}>{formatSize(item.size)}</Text>:null}</View>
        <Pressable onPress={()=>void share()} disabled={saving} accessibilityRole="button" accessibilityLabel="Сохранить или поделиться" style={{width:42,height:42,alignItems:'center',justifyContent:'center',opacity:saving?.5:1}}><Icon name="share-outline" color="#FFF" size={23}/></Pressable>
      </View>
    </InsetView>:null}
  </Modal>;
}
