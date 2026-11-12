// The full-screen video player of the media gallery and the single-file viewer: our own controls over a bare
// expo-video surface, behaving like the YouTube phone player. One tap shows / hides the controls (they hide
// themselves while the video plays); a double tap on a side seeks ±10 s and further taps gather «20 секунд»,
// «30 секунд»; press and hold plays at 2×; the seek bar switches to precise seeking when the finger is pulled up;
// the gear opens a sheet (speed, screen lock, picture in picture, keep for offline, share).
// The decisions and numbers are in playerModel.ts (test/video-player.test.mjs).
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useEvent, useEventListener } from 'expo';
import { isPictureInPictureSupported, useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { Icon, Notice, type IconName } from '../components';
import { tr, useLanguage } from '../i18n';
import { animMs } from '../motion';
import { useTheme } from '../theme';
import { Pressable, Text } from '../typography';
import { keepMedia, useMedia } from './mediaCache';
import { DOUBLE_TAP_MS, HIDE_MS, HOLD_MS, HOLD_RATE, SCRUB_SEEK_MS, SEEK_BURST_MS, SEEK_STEP, SPEEDS, TAP_IDLE, burstActive, chevronOpacity, clock, fineEngaged, fraction, fractionAt, scrubMove, seekTarget, speedLabel, tapStep, thumbTime, tooltipCenter } from './playerModel';

// «Картинка в картинке»: leaving the app while a video plays moves it into the system's small window (a saved film
// keeps playing over other apps, with no network needed — the file is already decrypted on the device). Where the
// system has no such window, or it did not open (the video was paused), playback stops in the background as before.
const pipSupported=(()=>{try{return Platform.OS!=='web'&&isPictureInPictureSupported();}catch{return false;}})();
// The frame above the seek bar comes from the player itself (an in-memory image, nothing written to disk);
// expo-video cannot make one in a browser, where only the time is shown.
const FRAMES=Platform.OS!=='web';
const FRAME_CACHE=24;
const WHITE='#FFF',TRACK='rgba(255,255,255,0.22)',BUFFER='rgba(255,255,255,0.12)',SIDE='rgba(255,255,255,0.14)';
const LOCKED_NOTE='Экран заблокирован. Удерживай, чтобы снять';
const TOOLTIP_WIDTH=180;
const label={color:WHITE,fontSize:13,fontWeight:'500' as const};
const shadow={textShadowColor:'#000',textShadowOffset:{width:0,height:1},textShadowRadius:3};

export type VideoPlayerViewProps={
  uri:string;
  /** With both given, the settings sheet offers «Сохранить для просмотра без сети». */
  api?:Api;attachment?:Attachment;
  /** The chevron at the top left: closes the viewer the player is shown in. */
  onClose:()=>void;
  onShare?:()=>void;
  /** The neighbouring items of the gallery. One missing: its button is dimmed; both missing: no such buttons. */
  onPrev?:()=>void;onNext?:()=>void;
  /** True while the player needs every touch for itself (the seek bar is dragged, the settings sheet is open, the
   *  screen is locked): the viewer around it must then neither page nor start its swipe-to-close. */
  onScrubbing?:(busy:boolean)=>void;
};

export function VideoPlayerView({uri,api,attachment,onClose,onShare,onPrev,onNext,onScrubbing}:VideoPlayerViewProps){
  const t=useTheme(),insets=useSafeAreaInsets(),language=useLanguage();
  const player=useVideoPlayer(uri,value=>{value.loop=false;value.audioMixingMode='doNotMix';value.timeUpdateEventInterval=0.25;if(pipSupported)value.staysActiveInBackground=true;});
  const {status,error}=useEvent(player,'statusChange',{status:player.status});
  const {isPlaying}=useEvent(player,'playingChange',{isPlaying:player.playing});
  const inPip=useRef(false),view=useRef<VideoView>(null),alive=useRef(true);
  const [box,setBox]=useState({width:0,height:0});
  const [shown,setShown]=useState(true),[locked,setLocked]=useState(false),[sheet,setSheet]=useState<null|'main'|'speed'>(null);
  const [speed,setSpeed]=useState(1),[fill,setFill]=useState(false),[ended,setEnded]=useState(false),[holding,setHolding]=useState(false);
  const [time,setTime]=useState(0),[duration,setDuration]=useState(0);
  const [scrubbing,setScrubbing]=useState(false),[fine,setFine]=useState(false),[frame,setFrame]=useState<VideoThumbnail|null>(null);
  const [burst,setBurst]=useState<{side:-1|1;seconds:number}|null>(null),[note,setNote]=useState('');
  // What the timers and gesture callbacks read: they outlive the render that created them.
  const live=useRef({shown:true,locked:false,sheet:false,dragging:false,holding:false,speed:1,duration:0,width:0});
  live.current.speed=speed;live.current.width=box.width;
  const timers=useRef<{hide?:ReturnType<typeof setTimeout>;tap?:ReturnType<typeof setTimeout>;burst?:ReturnType<typeof setTimeout>;note?:ReturnType<typeof setTimeout>}>({});
  const taps=useRef(TAP_IDLE),spinning=useRef(false),lastSeek=useRef(0),settleUntil=useRef(0);
  const frames=useRef(new Map<number,VideoThumbnail>()),frameBusy=useRef(false),frameWanted=useRef<number|null>(null),framesOff=useRef(false);
  // The bar is drawn from shared values, so it follows the finger on the UI thread.
  const position=useSharedValue(0),buffered=useSharedValue(0),barWidth=useSharedValue(0),dragging=useSharedValue(0),startY=useSharedValue(0),fineOn=useSharedValue(0);
  const controls=useSharedValue(1),sheetOpen=useSharedValue(0),sheetHeight=useSharedValue(420),phase=useSharedValue(0);

  useEffect(()=>{
    player.play();
    // Something else letting go of the audio session right now (the music player stopping, a voice message ending)
    // pauses a video that has only just started: it is started again, twice at most, while it still stands at its
    // beginning. A pause the user makes later is never undone.
    const nudges=[300,700].map(delay=>setTimeout(()=>{try{if(!player.playing&&player.currentTime<0.4&&player.status!=='error')player.play();}catch{/* released */}},delay));
    let timer:ReturnType<typeof setTimeout>|null=null;
    const pause=()=>{try{player.pause();}catch{/* The native hook may have disposed first. */}};
    const subscription=AppState.addEventListener('change',state=>{
      if(timer){clearTimeout(timer);timer=null;}
      if(state==='active')return;
      if(!pipSupported){pause();return;}
      // The small window opens a moment after the app leaves the screen: if it has not, nothing may keep playing unseen.
      if(state==='background')timer=setTimeout(()=>{timer=null;if(!inPip.current)pause();},1500);
    });
    return()=>{subscription.remove();nudges.forEach(clearTimeout);if(timer)clearTimeout(timer);pause();};
  },[player]);
  useEffect(()=>{alive.current=true;const held=timers.current,cache=frames.current;return()=>{alive.current=false;Object.values(held).forEach(clearTimeout);cache.clear();};},[]);

  /** The player object throws once the native side has released it (a page turned away mid-gesture). */
  const safe=<T,>(read:()=>T,fallback:T):T=>{try{return read();}catch{return fallback;}};
  const say=(text:string)=>{setNote(text);clearTimeout(timers.current.note);timers.current.note=setTimeout(()=>setNote(''),1500);};
  const show=(on:boolean)=>{
    if(on&&live.current.locked){say(LOCKED_NOTE);return;}
    live.current.shown=on;setShown(on);clearTimeout(timers.current.hide);
    if(on&&safe(()=>player.playing,false)&&!live.current.dragging)timers.current.hide=setTimeout(()=>{if(!live.current.dragging&&!live.current.sheet)show(false);},HIDE_MS);
  };
  const readDuration=()=>{const value=safe(()=>player.duration,0);const length=Number.isFinite(value)&&value>0?value:0;if(length!==live.current.duration){live.current.duration=length;setDuration(length);}return length;};
  const seekTo=(seconds:number)=>{const length=readDuration();const target=Math.max(0,Math.min(length,seconds));safe(()=>{player.currentTime=target;},undefined);if(target<length-0.25)setEnded(false);return target;};

  useEventListener(player,'timeUpdate',payload=>{
    const length=readDuration();
    buffered.value=fraction(payload.bufferedPosition,length);
    // The bar belongs to the finger while it is dragged, and for a moment after: the player still reports where it
    // stood before the seek, which would throw the thumb back.
    if(live.current.dragging||Date.now()<settleUntil.current)return;
    position.value=fraction(payload.currentTime,length);setTime(Math.floor(payload.currentTime));
  });
  useEventListener(player,'playToEnd',()=>{setEnded(true);live.current.shown=true;setShown(true);clearTimeout(timers.current.hide);});
  // Playback that starts (the play button, a replay, the start nudges) arms the hide timer of controls already shown.
  useEffect(()=>{if(isPlaying){setEnded(false);if(live.current.shown)show(true);}},[isPlaying]);
  useEffect(()=>{readDuration();},[status]);
  useEffect(()=>{controls.value=withTiming(shown?1:0,{duration:animMs(180)});},[shown]);
  // Everything the viewer around must keep its hands off for (see onScrubbing).
  const busy=scrubbing||locked||sheet!==null,report=useRef(onScrubbing);report.current=onScrubbing;
  useEffect(()=>{report.current?.(busy);},[busy]);
  useEffect(()=>()=>{report.current?.(false);},[]);

  const toggle=()=>{
    if(ended){safe(()=>{player.replay();player.play();},undefined);setEnded(false);}
    else if(safe(()=>player.playing,false))safe(()=>player.pause(),undefined);
    else safe(()=>player.play(),undefined);
    show(true);
  };
  const startPip=()=>{try{void view.current?.startPictureInPicture()?.catch(()=>say('Окно не открылось'));}catch{say('Окно не открылось');}};
  const openSheet=(mode:'main'|'speed')=>{live.current.sheet=true;clearTimeout(timers.current.hide);setSheet(mode);sheetOpen.value=withTiming(1,{duration:animMs(220)});};
  const closeSheet=(then?:()=>void)=>{live.current.sheet=false;sheetOpen.value=withTiming(0,{duration:animMs(160)});setSheet(null);if(then)then();else show(true);};
  const lock=()=>closeSheet(()=>{live.current.locked=true;setLocked(true);live.current.shown=false;setShown(false);clearTimeout(timers.current.hide);say(LOCKED_NOTE);});
  const chooseSpeed=(value:number)=>{setSpeed(value);safe(()=>{player.playbackRate=value;},undefined);closeSheet();};

  // ─── Taps and the hold on the picture ───
  const seekTap=(side:-1|1,seconds:number)=>{
    // The controls step aside for the side highlight, as in the demo.
    live.current.shown=false;setShown(false);clearTimeout(timers.current.hide);
    const target=seekTo(seekTarget(safe(()=>player.currentTime,0),readDuration(),side*SEEK_STEP));
    position.value=fraction(target,live.current.duration);setTime(Math.floor(target));settleUntil.current=Date.now()+400;
    if(!spinning.current){spinning.current=true;phase.value=0;phase.value=withRepeat(withTiming(1,{duration:750,easing:Easing.linear}),-1,false);}
    setBurst({side,seconds});clearTimeout(timers.current.burst);
    timers.current.burst=setTimeout(()=>{setBurst(null);spinning.current=false;cancelAnimation(phase);taps.current={...taps.current,acc:0,side:0};},SEEK_BURST_MS);
  };
  const onTap=(x:number)=>{
    if(live.current.locked){say(LOCKED_NOTE);return;}
    const step=tapStep(taps.current,{x,time:Date.now(),width:live.current.width});taps.current=step.state;clearTimeout(timers.current.tap);
    if(step.seek!==0){seekTap(step.seek,step.state.acc);return;}
    // A lone tap: wait out the double-tap window before toggling the controls (never in the middle of a seek burst).
    timers.current.tap=setTimeout(()=>{if(!burstActive(taps.current,Date.now()))show(!live.current.shown);},DOUBLE_TAP_MS);
  };
  const holdStart=()=>{
    if(live.current.locked){live.current.locked=false;setLocked(false);say('Блокировка снята');return;}
    if(!safe(()=>player.playing,false))return;
    live.current.holding=true;setHolding(true);safe(()=>{player.playbackRate=HOLD_RATE;},undefined);
    live.current.shown=false;setShown(false);clearTimeout(timers.current.hide);
  };
  const holdEnd=()=>{if(!live.current.holding)return;live.current.holding=false;setHolding(false);safe(()=>{player.playbackRate=live.current.speed;},undefined);};
  // ─── The seek bar ───
  const requestFrame=(seconds:number)=>{
    if(!FRAMES||framesOff.current)return;
    const at=thumbTime(seconds,live.current.duration),cached=frames.current.get(at);
    if(cached){frameWanted.current=null;setFrame(cached);return;}
    frameWanted.current=at;if(frameBusy.current)return;
    // One decode at a time, always for the newest place asked: the drag never waits for it, and whatever the
    // finger passed in the meantime is skipped.
    frameBusy.current=true;
    void (async()=>{
      while(frameWanted.current!==null&&alive.current&&live.current.dragging){
        const wanted=frameWanted.current;frameWanted.current=null;
        try{
          const [image]=await player.generateThumbnailsAsync(wanted,{maxWidth:320,maxHeight:320});
          if(!image||!alive.current)break;
          if(frames.current.size>=FRAME_CACHE){const oldest=frames.current.keys().next().value;if(oldest!==undefined)frames.current.delete(oldest);}
          frames.current.set(wanted,image);if(live.current.dragging)setFrame(image);
        }catch{framesOff.current=true;break;/* this file gives no frames: the time alone is shown */}
      }
      frameBusy.current=false;
    })();
  };
  const scrubStart=(at:number)=>{
    live.current.dragging=true;clearTimeout(timers.current.hide);setFine(false);setFrame(null);setScrubbing(true);
    const seconds=at*readDuration();setTime(Math.floor(seconds));requestFrame(seconds);
  };
  const scrubTo=(at:number)=>{
    const seconds=at*live.current.duration,now=Date.now();setTime(Math.floor(seconds));
    if(now-lastSeek.current>=SCRUB_SEEK_MS){lastSeek.current=now;seekTo(seconds);}
    requestFrame(seconds);
  };
  const scrubEnd=(at:number)=>{
    const target=seekTo(at*live.current.duration);settleUntil.current=Date.now()+400;setTime(Math.floor(target));
    live.current.dragging=false;setScrubbing(false);setFine(false);show(true);
  };
  const fineStart=()=>setFine(true);
  // The gestures are built once and reach the handlers above through a ref: the player re-renders several times a
  // second (the clock), and a detector whose gesture is replaced under a finger is the last thing a drag needs.
  const handlers=useRef({onTap,holdStart,holdEnd,scrubStart,scrubTo,scrubEnd,fineStart});handlers.current={onTap,holdStart,holdEnd,scrubStart,scrubTo,scrubEnd,fineStart};
  const [gestures]=useState(()=>{
    const call=(name:keyof typeof handlers.current,value:number)=>handlers.current[name](value);
    // A tap ends before the hold begins, so the two never both fire for one touch. A finger that drifts further than
    // a tap allows is left to the viewer around (swipe down to close, sideways to the next item).
    const tap=Gesture.Tap().maxDuration(HOLD_MS-60).maxDistance(12).onEnd((event,success)=>{if(success)runOnJS(call)('onTap',event.x);});
    const hold=Gesture.LongPress().minDuration(HOLD_MS).maxDistance(24).onStart(()=>{runOnJS(call)('holdStart',0);}).onFinalize(()=>{runOnJS(call)('holdEnd',0);});
    // onBegin is the finger going down (a drag starts there, and a plain tap on the bar seeks too); onFinalize ends it
    // however the touch finished. minDistance 0: the pan is taken on the first movement, ahead of the viewer's own pans.
    const scrub=Gesture.Pan().minDistance(0).maxPointers(1).shouldCancelWhenOutside(false)
      .onBegin(event=>{dragging.value=1;fineOn.value=0;startY.value=event.absoluteY;position.value=fractionAt(event.x,barWidth.value);runOnJS(call)('scrubStart',position.value);})
      .onChange(event=>{
        if(dragging.value!==1)return;
        if(fineOn.value===0&&fineEngaged(startY.value,event.absoluteY,false)){fineOn.value=1;runOnJS(call)('fineStart',0);}
        position.value=scrubMove(position.value,event.changeX,barWidth.value,fineOn.value===1);runOnJS(call)('scrubTo',position.value);
      })
      .onFinalize(()=>{if(dragging.value!==1)return;dragging.value=0;runOnJS(call)('scrubEnd',position.value);});
    return {surface:Gesture.Race(hold,tap),scrub};
  });

  const controlsStyle=useAnimatedStyle(()=>({opacity:controls.value}));
  const trackStyle=useAnimatedStyle(()=>({height:withTiming(dragging.value?5:3,{duration:100}),top:withTiming(dragging.value?12:13,{duration:100})}));
  const playedStyle=useAnimatedStyle(()=>({width:`${position.value*100}%`}));
  const bufferedStyle=useAnimatedStyle(()=>({width:`${buffered.value*100}%`}));
  const thumbStyle=useAnimatedStyle(()=>({transform:[{translateX:position.value*barWidth.value-6.5},{scale:withTiming(dragging.value?1.6:1,{duration:100})}]}));
  const tooltipStyle=useAnimatedStyle(()=>({transform:[{translateX:tooltipCenter(position.value,barWidth.value)-TOOLTIP_WIDTH/2}]}));
  const sheetStyle=useAnimatedStyle(()=>({transform:[{translateY:(1-sheetOpen.value)*(sheetHeight.value+16)}]}));
  const dimStyle=useAnimatedStyle(()=>({opacity:sheetOpen.value}));

  const playing=isPlaying&&!ended,neighbours=!!onPrev||!!onNext;
  const frameSize=frame&&frame.width>frame.height?{width:160,height:90}:{width:120,height:160};
  const sides={paddingLeft:insets.left,paddingRight:insets.right};
  const round=(size:number)=>({width:size,height:size,borderRadius:size/2,backgroundColor:'rgba(0,0,0,0.3)',alignItems:'center' as const,justifyContent:'center' as const});
  const plain={width:48,height:48,alignItems:'center' as const,justifyContent:'center' as const};
  return <View style={{flex:1,backgroundColor:'#000',overflow:'hidden'}} onLayout={event=>setBox({width:event.nativeEvent.layout.width,height:event.nativeEvent.layout.height})}>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <VideoView ref={view} player={player} style={StyleSheet.absoluteFill} contentFit={fill?'cover':'contain'} nativeControls={false} allowsPictureInPicture={pipSupported} startsPictureInPictureAutomatically={pipSupported} onPictureInPictureStart={()=>{inPip.current=true;}} onPictureInPictureStop={()=>{inPip.current=false;}}/>
    </View>
    {/* The touch surface is a sheet of its own over the video, and the controls are its siblings above it: a press
        on a button never reaches the tap / hold gestures. */}
    <GestureDetector gesture={gestures.surface}><View collapsable={false} style={StyleSheet.absoluteFill} accessible accessibilityRole="button" accessibilityLabel={tr(shown?'Скрыть управление':'Показать управление',language)} onAccessibilityTap={()=>show(!live.current.shown)}/></GestureDetector>
    {burst?<SeekSide side={burst.side} seconds={burst.seconds} width={box.width} height={box.height} phase={phase} unit={tr('секунд',language)}/>:null}
    {status==='loading'?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{alignItems:'center',justifyContent:'center'}]}><ActivityIndicator color={t.accent} size="large"/></View>:null}
    {status==='error'?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{justifyContent:'center',padding:16}]}><Notice error text={`Устройство не смогло воспроизвести это видео. ${error?.message||'Можно сохранить файл и открыть совместимым проигрывателем.'}`}/></View>:null}

    <Reanimated.View pointerEvents={shown&&!locked?'box-none':'none'} style={[StyleSheet.absoluteFill,controlsStyle]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:'rgba(0,0,0,0.5)'}]}/>
      <View pointerEvents="box-none" style={[{position:'absolute',top:0,left:0,right:0,flexDirection:'row',alignItems:'center',paddingTop:insets.top+6,paddingHorizontal:6},{marginLeft:insets.left,marginRight:insets.right}]}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть просмотр" style={plain}><Icon name="chevron-down" color={WHITE} size={28}/></Pressable>
        <View pointerEvents="none" style={{flex:1}}/>
        {pipSupported?<Pressable onPress={startPip} accessibilityRole="button" accessibilityLabel="Картинка в картинке" style={plain}><PipGlyph/></Pressable>:null}
        <Pressable onPress={()=>openSheet('main')} accessibilityRole="button" accessibilityLabel="Настройки" style={plain}><Icon name="settings-outline" color={WHITE} size={24}/></Pressable>
      </View>
      {scrubbing?null:<View pointerEvents="box-none" style={[StyleSheet.absoluteFill,{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:52}]}>
        {neighbours?<Pressable onPress={onPrev} disabled={!onPrev} accessibilityRole="button" accessibilityLabel="Предыдущее" style={[round(56),{opacity:onPrev?1:0.35}]}><Icon name="play-skip-back" color={WHITE} size={28}/></Pressable>:null}
        <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={ended?'Смотреть сначала':playing?'Пауза':'Воспроизвести'} style={round(72)}><Icon name={ended?'refresh':playing?'pause':'play'} color={WHITE} size={42}/></Pressable>
        {neighbours?<Pressable onPress={onNext} disabled={!onNext} accessibilityRole="button" accessibilityLabel="Следующее" style={[round(56),{opacity:onNext?1:0.35}]}><Icon name="play-skip-forward" color={WHITE} size={28}/></Pressable>:null}
      </View>}
      <View pointerEvents="box-none" style={[{position:'absolute',left:0,right:0,bottom:0,paddingBottom:insets.bottom+4},sides]}>
        <View pointerEvents="box-none" style={{flexDirection:'row',alignItems:'center',paddingHorizontal:12}}>
          <View pointerEvents="none" style={{paddingVertical:5,paddingHorizontal:8,borderRadius:14,backgroundColor:'rgba(0,0,0,0.3)'}}><Text raw style={{color:WHITE,fontSize:12.5,fontWeight:'500',fontVariant:['tabular-nums']}}>{clock(time)}<Text raw style={{color:'rgba(255,255,255,0.7)'}}> / {clock(duration)}</Text></Text></View>
          <View pointerEvents="none" style={{flex:1}}/>
          <Pressable onPress={()=>{const next=!fill;setFill(next);say(next?'Масштаб по экрану':'Исходный размер');show(true);}} accessibilityRole="button" accessibilityLabel={fill?'Исходный размер':'Масштаб по экрану'} style={plain}><Icon name={fill?'contract':'expand'} color={WHITE} size={22}/></Pressable>
        </View>
        <GestureDetector gesture={gestures.scrub}><View collapsable={false} onLayout={event=>{barWidth.value=event.nativeEvent.layout.width;}} style={{height:30,marginHorizontal:12}} accessible accessibilityRole="adjustable" accessibilityLabel={tr('Позиция воспроизведения',language)} accessibilityValue={{min:0,max:Math.floor(duration),now:Math.min(time,Math.floor(duration))}} accessibilityActions={[{name:'increment',label:tr('Вперёд на 10 секунд',language)},{name:'decrement',label:tr('Назад на 10 секунд',language)}]} onAccessibilityAction={event=>{const target=seekTo(seekTarget(safe(()=>player.currentTime,0),readDuration(),event.nativeEvent.actionName==='increment'?SEEK_STEP:-SEEK_STEP));setTime(Math.floor(target));}}>
          <Reanimated.View pointerEvents="none" style={[{position:'absolute',left:0,right:0,backgroundColor:TRACK,overflow:'hidden'},trackStyle]}>
            <Reanimated.View style={[{position:'absolute',left:0,top:0,bottom:0,backgroundColor:BUFFER},bufferedStyle]}/>
            <Reanimated.View style={[{position:'absolute',left:0,top:0,bottom:0,backgroundColor:WHITE},playedStyle]}/>
          </Reanimated.View>
          <Reanimated.View pointerEvents="none" style={[{position:'absolute',left:0,top:8,width:13,height:13,borderRadius:6.5,backgroundColor:WHITE},thumbStyle]}/>
          {scrubbing?<Reanimated.View pointerEvents="none" style={[{position:'absolute',left:0,bottom:44,width:TOOLTIP_WIDTH,alignItems:'center',gap:6},tooltipStyle]}>
            {FRAMES&&frame?<Image source={frame} contentFit="cover" style={[frameSize,{borderRadius:8,borderWidth:2,borderColor:WHITE,backgroundColor:'#000'}]}/>:null}
            <Text raw style={[label,shadow,{fontVariant:['tabular-nums']}]}>{clock(time)}</Text>
          </Reanimated.View>:null}
        </View></GestureDetector>
      </View>
      {scrubbing?<View pointerEvents="none" style={{position:'absolute',left:0,right:0,bottom:insets.bottom+250,alignItems:'center'}}><Text style={[label,shadow]}>{fine?'Точная перемотка':'Потяни вверх для точной перемотки'}</Text></View>:null}
    </Reanimated.View>

    {/* With the controls away, a hairline at the very bottom still tells how far the video has gone. */}
    {shown?null:<View pointerEvents="none" style={{position:'absolute',left:0,right:0,bottom:0,height:2,backgroundColor:'rgba(255,255,255,0.2)'}}><Reanimated.View style={[{height:2,backgroundColor:WHITE},playedStyle]}/></View>}
    {holding?<View pointerEvents="none" style={{position:'absolute',left:0,right:0,top:insets.top+16,alignItems:'center'}}><View style={{flexDirection:'row',alignItems:'center',gap:6,paddingVertical:7,paddingHorizontal:14,borderRadius:18,backgroundColor:'rgba(0,0,0,0.6)'}}><Text raw style={{color:WHITE,fontSize:14,fontWeight:'500'}}>{HOLD_RATE}×</Text><Icon name="play-forward" color={WHITE} size={15}/></View></View>:null}
    {note?<View pointerEvents="none" style={{position:'absolute',left:16,right:16,top:'30%',alignItems:'center'}}><View style={{paddingVertical:8,paddingHorizontal:14,borderRadius:18,backgroundColor:'rgba(0,0,0,0.65)'}}><Text style={[label,{textAlign:'center'}]}>{note}</Text></View></View>:null}

    {sheet?<>
      <Reanimated.View style={[StyleSheet.absoluteFill,{backgroundColor:'rgba(0,0,0,0.4)'},dimStyle]}><Pressable onPress={()=>closeSheet()} accessibilityRole="button" accessibilityLabel="Закрыть" style={StyleSheet.absoluteFill}/></Reanimated.View>
      <Reanimated.View onLayout={event=>{sheetHeight.value=event.nativeEvent.layout.height;}} style={[{position:'absolute',left:8+insets.left,right:8+insets.right,bottom:8,maxHeight:Math.max(160,box.height-insets.top-24),backgroundColor:'#212121',borderRadius:14,paddingTop:8,paddingBottom:insets.bottom+8},sheetStyle]}>
        <View style={{width:40,height:4,borderRadius:2,backgroundColor:'#555',alignSelf:'center',marginTop:2,marginBottom:8}}/>
        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          {sheet==='speed'?SPEEDS.map(value=><SheetRow key={value} icon={value===speed?'checkmark':null} label={speedLabel(value)} current={value===speed} onPress={()=>chooseSpeed(value)}/>):<>
            <SheetRow icon="speedometer-outline" label="Скорость воспроизведения" value={speedLabel(speed)} onPress={()=>openSheet('speed')}/>
            <SheetRow icon="lock-closed-outline" label="Заблокировать экран" onPress={lock}/>
            {pipSupported?<SheetRow icon={<PipGlyph/>} label="Картинка в картинке" onPress={()=>closeSheet(startPip)}/>:null}
            {api&&attachment?<KeepRow api={api} attachment={attachment} onDone={kept=>{closeSheet();say(kept?'Сохранено':'Убрано из сохранённых');}}/>:null}
            {onShare?<SheetRow icon="share-outline" label="Поделиться" onPress={()=>closeSheet(()=>{show(true);onShare();})}/>:null}
          </>}
        </ScrollView>
      </Reanimated.View>
    </>:null}
  </View>;
}

/** The half-ellipse a double tap lights on its side, with the gathered seconds and three running chevrons. */
function SeekSide({side,seconds,width,height,phase,unit}:{side:-1|1;seconds:number;width:number;height:number;phase:SharedValue<number>;unit:string}){
  // The demo's shape: a band 19 % of the width at the edge, then a bulge 23 % wide whose curve is half an ellipse
  // 120 % of the height tall. React Native corners are circular, so the bulge is half of a circle squeezed sideways;
  // the band and the bulge do not overlap (two translucent layers would show a seam).
  const band=width*0.19,bulge=width*0.23,diameter=height*1.2,left=side<0;
  if(!(width>0&&height>0))return null;
  return <View pointerEvents="none" style={[{position:'absolute',top:0,bottom:0,width:band+bulge,flexDirection:left?'row':'row-reverse'},left?{left:0}:{right:0}]}>
    <View style={{width:band,backgroundColor:SIDE}}/>
    <View style={{width:bulge,overflow:'hidden'}}><View style={[{position:'absolute',top:(height-diameter)/2,width:diameter,height:diameter,borderRadius:diameter/2,backgroundColor:SIDE,transform:[{scaleX:bulge/(diameter/2)}]},left?{left:-diameter/2}:{right:-diameter/2}]}/></View>
    <View style={[StyleSheet.absoluteFill,{alignItems:'center',justifyContent:'center',gap:8}]}>
      <View style={{flexDirection:'row'}}>{[0,1,2].map(index=><Chevron key={index} index={index} forward={!left} phase={phase}/>)}</View>
      <Text raw style={label}>{seconds} {unit}</Text>
    </View>
  </View>;
}
function Chevron({index,forward,phase}:{index:number;forward:boolean;phase:SharedValue<number>}){
  const style=useAnimatedStyle(()=>({opacity:chevronOpacity(phase.value,index,forward)}));
  return <Reanimated.View style={style}><Icon name={forward?'caret-forward':'caret-back'} color={WHITE} size={16}/></Reanimated.View>;
}

/** The usual picture-in-picture mark (a screen with a small window in its corner): the icon font has none. */
function PipGlyph(){
  return <View style={{width:24,height:24,alignItems:'center',justifyContent:'center'}}><View style={{width:21,height:16,borderRadius:3,borderWidth:1.8,borderColor:WHITE}}><View style={{position:'absolute',right:1.5,bottom:1.5,width:9,height:6,borderRadius:1,backgroundColor:WHITE}}/></View></View>;
}

function SheetRow({icon,label:text,value,current=false,disabled=false,onPress}:{icon:IconName|React.ReactElement|null;label:string;value?:string;current?:boolean;disabled?:boolean;onPress:()=>void}){
  const color=current?'#3EA6FF':WHITE;
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{selected:current,disabled}} style={({pressed})=>({flexDirection:'row',alignItems:'center',gap:20,paddingVertical:13,paddingHorizontal:20,opacity:disabled?0.5:1,backgroundColor:pressed?'rgba(255,255,255,0.08)':'transparent'})}>
    <View style={{width:24,height:24,alignItems:'center',justifyContent:'center'}}>{typeof icon==='string'?<Icon name={icon} color={color} size={24}/>:icon}</View>
    <Text style={{flex:1,color,fontSize:16}}>{text}</Text>
    {value?<Text style={{color:'#AAA',fontSize:16}}>{value}</Text>:null}
  </Pressable>;
}

/** «Сохранить для просмотра без сети»: a loaded video is kept on the device outside the cache's size limit (a film
 *  is a gigabyte or more and would otherwise be the first file evicted). Offered once the video has loaded. */
function KeepRow({api,attachment,onDone}:{api:Api;attachment:Attachment;onDone:(kept:boolean)=>void}){
  const media=useMedia(api,attachment,false);const [busy,setBusy]=useState(false);
  if(media.status!=='ready')return null;
  const kept=!!media.kept;
  return <SheetRow icon={kept?'checkmark-circle':'cloud-download-outline'} label={kept?'Сохранено для просмотра без сети':'Сохранить для просмотра без сети'} disabled={busy} onPress={()=>{if(busy)return;setBusy(true);void keepMedia(attachment,!kept).then(onDone,()=>onDone(kept));}}/>;
}
