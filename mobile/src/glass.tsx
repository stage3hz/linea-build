import React, { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurTargetView, BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { LiquidGlassView } from 'react-native-liquid-glassmorphism';

/** Android 13+ can run the refraction shader (AGSL); older Android keeps the blur fallback. */
const androidLiquid=Platform.OS==='android'&&typeof Platform.Version==='number'&&Platform.Version>=33;
import { useTheme } from './theme';

type GlassContextValue = { targetRef:RefObject<View|null>|undefined; reduceTransparency:boolean };
const GlassContext=createContext<GlassContextValue>({targetRef:undefined,reduceTransparency:true});
/** True inside another GlassSurface: native glass cannot sample glass, so nested surfaces draw a flat fill. */
const NestedGlass=createContext(false);
export const useGlassTarget=()=>useContext(GlassContext).targetRef;
export const useReducedTransparency=()=>useContext(GlassContext).reduceTransparency;

function useTransparencyPreference() {
  // Stay opaque until the accessibility preference has been read.
  const [reduced,setReduced]=useState(Platform.OS==='ios');
  useEffect(()=>{
    if(Platform.OS==='ios'){
      let mounted=true;
      AccessibilityInfo.isReduceTransparencyEnabled().then(value=>{if(mounted)setReduced(value);}).catch(()=>{if(mounted)setReduced(true);});
      const sub=AccessibilityInfo.addEventListener('reduceTransparencyChanged',setReduced);
      return()=>{mounted=false;sub.remove();};
    }
    if(Platform.OS==='web'&&typeof window!=='undefined'&&typeof window.matchMedia==='function'){
      const media=window.matchMedia('(prefers-reduced-transparency: reduce)');
      const update=()=>setReduced(media.matches);update();
      media.addEventListener?.('change',update);
      return()=>media.removeEventListener?.('change',update);
    }
    setReduced(false);
  },[]);
  return reduced;
}

/** Ambient content only. Never put a glass surface inside this target. */
export function GlassBackdrop() {
  const t=useTheme();
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:t.bg}]}>
    <LinearGradient colors={t.bgGradient} start={{x:0,y:0}} end={{x:.8,y:1}} style={StyleSheet.absoluteFill}/>
    <LinearGradient colors={[t.ambientBlue,'transparent','transparent']} locations={[0,.62,1]} start={{x:1,y:0}} end={{x:0,y:.85}} style={StyleSheet.absoluteFill}/>
    <LinearGradient colors={['transparent',t.ambientLilac]} start={{x:.2,y:.15}} end={{x:.9,y:1}} style={StyleSheet.absoluteFill}/>
    <View style={{position:'absolute',top:'-26%',right:'-30%',width:'108%',aspectRatio:1,borderRadius:1000,borderWidth:1,borderColor:t.black?'rgba(255,255,255,0.035)':t.dark?'rgba(145,181,255,0.07)':'rgba(255,255,255,0.58)',overflow:'hidden',transform:[{rotate:'-24deg'}]}}>
      <LinearGradient colors={[t.black?'rgba(255,255,255,0.025)':t.dark?'rgba(89,130,222,0.09)':'rgba(255,255,255,0.34)','transparent']} start={{x:0,y:0}} end={{x:.6,y:1}} style={StyleSheet.absoluteFill}/>
    </View>
  </View>;
}

/** One background-only Android capture target shared by sibling surfaces. */
export function GlassStage({children}:{children:React.ReactNode}) {
  const targetRef=useRef<View|null>(null);
  const reduceTransparency=useTransparencyPreference();
  const value=useMemo(()=>({targetRef,reduceTransparency}),[reduceTransparency]);
  const t=useTheme();
  return <GlassContext.Provider value={value}><View style={{flex:1,backgroundColor:t.bg}}>
    {Platform.OS==='android'&&!androidLiquid?<BlurTargetView ref={targetRef} collapsable={false} pointerEvents="none" style={StyleSheet.absoluteFill}><GlassBackdrop/></BlurTargetView>:<GlassBackdrop/>}
    {children}
  </View></GlassContext.Provider>;
}

export type GlassSurfaceProps = {
  children?:React.ReactNode;
  style?:StyleProp<ViewStyle>;
  contentStyle?:StyleProp<ViewStyle>;
  radius?:number;
  material?:'regular'|'clear';
  interactive?:boolean;
  shadow?:boolean;
  targetRef?:RefObject<View|null>;
};

export function GlassSurface({children,style,contentStyle,radius=26,material='regular',interactive=false,shadow=true,targetRef}:GlassSurfaceProps) {
  const t=useTheme();const context=useContext(GlassContext);const target=targetRef||context.targetRef;
  const nested=useContext(NestedGlass);
  const nativeGlass=useMemo(()=>{
    if(Platform.OS!=='ios'||nested)return false;
    try{return isGlassEffectAPIAvailable()&&isLiquidGlassAvailable();}catch{return false;}
  },[nested]);
  const reduceTransparency=context.reduceTransparency;
  const hasBlur=!nested&&!reduceTransparency&&(Platform.OS!=='android'||!!target);
  const regular=material==='regular';
  const fill=reduceTransparency?t.glassOpaque:regular?t.glass:t.glassClear;
  const shadowStyle:ViewStyle=shadow?Platform.OS==='web'?{boxShadow:`0 10px 34px ${t.black?'rgba(0,0,0,0.24)':t.dark?'rgba(0,4,18,0.24)':'rgba(38,66,125,0.09)'}, 0 2px 5px ${t.black?'rgba(0,0,0,0.13)':t.dark?'rgba(0,4,18,0.13)':'rgba(38,66,125,0.035)'}`}:{shadowColor:t.shadow,shadowOffset:{width:0,height:8},shadowOpacity:t.dark?.19:.09,shadowRadius:18,elevation:0}:{};
  // iOS 26: only the system Liquid Glass, rounded by the glass itself. Our own fill, gradient and
  // two-colour border on top of it were clipped together with the glass and showed stepped edges.
  if(nativeGlass&&!reduceTransparency)return <View style={[{borderRadius:radius},style]}>
    <GlassView pointerEvents="none" colorScheme={t.dark?'dark':'light'} glassEffectStyle={material} isInteractive={interactive} tintColor={t.glassTint} style={[StyleSheet.absoluteFill,{borderRadius:radius}]}/>
    <NestedGlass.Provider value={true}><View style={[{flexGrow:1},contentStyle]}>{children}</View></NestedGlass.Provider>
  </View>;
  // Android 13+: the same Liquid Glass look as iOS 26 — the real content behind is blurred and
  // bent at the edges by a shader, with a light rim. No fill or gradient layers on top.
  // Light theme: no dark legibility veil (it scales up over bright backdrops and turned the glass grey),
  // a milky white tint and a small lift instead — closer to iOS 26. Small round buttons (clear)
  // get a thinner lens: full refraction bent the text behind them and made the circle look uneven.
  if(androidLiquid&&!nested&&!reduceTransparency)return <LiquidGlassView variant={material} borderRadius={radius} tintColor={t.dark?t.glassTint:regular?'rgba(255,255,255,0.34)':'rgba(255,255,255,0.18)'} brightness={t.dark?1:1.06} blurRadius={regular?14:10} thickness={regular?1:.45} edgeReflectionStrength={regular?1:.6} legibilityFloor={t.dark?.12:0} interactive={false} tilt={false} style={[{borderRadius:radius},style]}>
    {/* Content lives inside the glass: the shader excludes it from the backdrop, so icons do not bleed into the blur. */}
    <NestedGlass.Provider value={true}><View style={[{flexGrow:1},contentStyle]}>{children}</View></NestedGlass.Provider>
  </LiquidGlassView>;
  return <View style={[{borderRadius:radius},shadowStyle,style]}>
    <View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:radius,overflow:'hidden'}]}>
      {hasBlur?<BlurView tint={t.dark?'dark':'light'} intensity={regular?64:35} blurMethod="dimezisBlurViewSdk31Plus" blurTarget={target} style={StyleSheet.absoluteFill}/>:null}
      <View style={[StyleSheet.absoluteFill,{backgroundColor:fill}]}/>
      {!reduceTransparency?<LinearGradient colors={[t.glassHighlight,'transparent',t.black?'rgba(255,255,255,0.025)':t.dark?'rgba(129,172,255,0.025)':'rgba(255,255,255,0.08)']} locations={[0,.36,1]} start={{x:.1,y:0}} end={{x:.65,y:1}} style={[StyleSheet.absoluteFill,{opacity:regular?.48:.66}]}/>:null}
      <View style={[StyleSheet.absoluteFill,{borderRadius:radius,borderWidth:1,borderColor:t.glassBorder,borderBottomColor:t.black?'rgba(255,255,255,0.10)':t.dark?'rgba(129,167,230,0.10)':'rgba(139,162,204,0.23)'}]}/>
      <View style={{position:'absolute',top:1,left:radius*.58,right:radius*.58,height:1,borderRadius:1,backgroundColor:t.glassHighlight,opacity:.7}}/>
    </View>
    <NestedGlass.Provider value={true}><View style={[{flexGrow:1},contentStyle]}>{children}</View></NestedGlass.Provider>
  </View>;
}
