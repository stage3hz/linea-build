import React, { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurTargetView, BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
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
    {Platform.OS==='android'?<BlurTargetView ref={targetRef} collapsable={false} pointerEvents="none" style={StyleSheet.absoluteFill}><GlassBackdrop/></BlurTargetView>:<GlassBackdrop/>}
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
  return <View style={[{borderRadius:radius},shadowStyle,style]}>
    <View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:radius,overflow:'hidden'}]}>
      {!reduceTransparency&&nativeGlass?<GlassView colorScheme={t.dark?'dark':'light'} glassEffectStyle={material} isInteractive={interactive} tintColor={t.glassTint} style={StyleSheet.absoluteFill}/>:hasBlur?<BlurView tint={t.dark?'dark':'light'} intensity={regular?64:35} blurMethod="dimezisBlurViewSdk31Plus" blurTarget={target} style={StyleSheet.absoluteFill}/>:null}
      <View style={[StyleSheet.absoluteFill,{backgroundColor:fill}]}/>
      {!reduceTransparency?<LinearGradient colors={[t.glassHighlight,'transparent',t.black?'rgba(255,255,255,0.025)':t.dark?'rgba(129,172,255,0.025)':'rgba(255,255,255,0.08)']} locations={[0,.36,1]} start={{x:.1,y:0}} end={{x:.65,y:1}} style={[StyleSheet.absoluteFill,{opacity:regular?.48:.66}]}/>:null}
      <View style={[StyleSheet.absoluteFill,{borderRadius:radius,borderWidth:1,borderColor:t.glassBorder,borderBottomColor:t.black?'rgba(255,255,255,0.10)':t.dark?'rgba(129,167,230,0.10)':'rgba(139,162,204,0.23)'}]}/>
      <View style={{position:'absolute',top:1,left:radius*.58,right:radius*.58,height:1,borderRadius:1,backgroundColor:t.glassHighlight,opacity:.7}}/>
    </View>
    <NestedGlass.Provider value={true}><View style={[{flexGrow:1},contentStyle]}>{children}</View></NestedGlass.Provider>
  </View>;
}
