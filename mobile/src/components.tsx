import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View, type ImageStyle, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { Text, TextInput } from './typography';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, formatSize } from './theme';
import { GlassStage, GlassSurface } from './glass';
import type { Attachment, User } from './types';
import type { Api } from './api';
import { mediaPreviewKind } from './media/formats';
import { previewUri } from './media/previewModel';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];
export function Icon({name, size=22, color}:{name:IconName;size?:number;color?:string}) {
  const t=useTheme();return <Ionicons name={name} size={size} color={color||t.text}/>;
}

export function IconButton({name,onPress,label,color,disabled=false,size=23,style}:{name:IconName;onPress:()=>void;label:string;color?:string;disabled?:boolean;size?:number;style?:StyleProp<ViewStyle>}) {
  const t=useTheme();const flattened=StyleSheet.flatten(style);const radius=typeof flattened?.borderRadius==='number'?flattened.borderRadius:22;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress} hitSlop={3} style={({pressed})=>[{width:44,height:44,minWidth:44,minHeight:44,borderRadius:radius,opacity:disabled?.45:1,transform:[{scale:pressed?.95:1}]},style]}>
    <GlassSurface radius={radius} material="clear" interactive shadow={false} style={{width:'100%',height:'100%'}} contentStyle={{flex:1,alignItems:'center',justifyContent:'center'}}><Icon name={name} size={size} color={color||t.text}/></GlassSurface>
  </Pressable>;
}

export function Button({label,onPress,loading=false,disabled=false,secondary=false,icon,danger=false}:{label:string;onPress:()=>void;loading?:boolean;disabled?:boolean;secondary?:boolean;icon?:IconName;danger?:boolean}) {
  const t=useTheme();const fg=danger?t.danger:secondary?t.text:t.onAccent;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:disabled||loading,busy:loading}} disabled={disabled||loading} onPress={onPress} style={({pressed})=>({minHeight:54,borderRadius:21,opacity:disabled?.45:1,transform:[{scale:pressed?.985:1}]})}>
    <GlassSurface radius={21} material={secondary||danger?'regular':'clear'} interactive shadow={!secondary} style={{minHeight:54}} contentStyle={{minHeight:54,paddingHorizontal:21,flexDirection:'row',gap:10,alignItems:'center',justifyContent:'center'}}>
      {!secondary&&!danger?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:21,overflow:'hidden'}]}><LinearGradient colors={t.accentGradient} start={{x:0,y:0}} end={{x:.9,y:1}} style={[StyleSheet.absoluteFill,{opacity:.96}]}/><LinearGradient colors={['rgba(255,255,255,0.22)','transparent']} start={{x:0,y:0}} end={{x:.4,y:.65}} style={StyleSheet.absoluteFill}/><View style={[StyleSheet.absoluteFill,{borderRadius:21,borderWidth:1,borderColor:t.dark?'rgba(235,245,255,0.58)':'rgba(255,255,255,0.35)'}]}/></View>:danger?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:21,backgroundColor:t.dangerBg}]}/>:null}
      {loading?<ActivityIndicator color={fg}/>:icon?<Icon name={icon} size={20} color={fg}/>:null}<Text style={{color:fg,fontSize:16,fontWeight:'700',letterSpacing:-.15}}>{label}</Text>
    </GlassSurface>
  </Pressable>;
}

export function Field({label,error,style,onFocus,onBlur,...props}:TextInputProps&{label?:string;error?:string}) {
  const t=useTheme();const [focused,setFocused]=useState(false);
  return <View style={{gap:8}}>{label?<Text style={{fontSize:11,fontWeight:'700',letterSpacing:1,color:t.muted,textTransform:'uppercase',paddingLeft:2}}>{label}</Text>:null}
    <GlassSurface radius={18} material="regular" shadow={false}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:18,borderWidth:focused||error?1.4:0,borderColor:error?t.danger:t.accent}]}/>
      <TextInput {...props} placeholderTextColor={props.placeholderTextColor||t.subtle} keyboardAppearance={props.keyboardAppearance||(t.dark?'dark':'light')} selectionColor={t.accent} onFocus={event=>{setFocused(true);onFocus?.(event);}} onBlur={event=>{setFocused(false);onBlur?.(event);}} style={[{minHeight:54,paddingHorizontal:17,paddingVertical:14,borderRadius:18,backgroundColor:'transparent',color:t.text,fontSize:16},style]}/>
    </GlassSurface>{error?<Text style={{color:t.danger,fontSize:12,paddingLeft:3}}>{error}</Text>:null}
  </View>;
}

export function Notice({text,error=false,onRetry}:{text:string;error?:boolean;onRetry?:()=>void}) {
  const t=useTheme();return <View accessibilityRole="alert"><GlassSurface radius={18} shadow={false} contentStyle={{flexDirection:'row',gap:10,padding:14,alignItems:'flex-start'}}>
    {error?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:18,backgroundColor:t.dangerBg}]}/>:null}<Icon name={error?'alert-circle-outline':'information-circle-outline'} size={19} color={error?t.danger:t.accent}/><Text style={{flex:1,color:error?t.danger:t.text,fontSize:13,lineHeight:19}}>{text}</Text>{onRetry?<Pressable onPress={onRetry} accessibilityRole="button" hitSlop={10} style={{minHeight:28,justifyContent:'center'}}><Text style={{color:t.accent,fontWeight:'700',fontSize:12}}>Повторить</Text></Pressable>:null}
  </GlassSurface></View>;
}

export function Logo({size=58}:{size?:number}) {
  const t=useTheme();const radius=size*.32;
  return <GlassSurface radius={radius} material="clear" style={{width:size,height:size,transform:[{rotate:'-5deg'}]}} contentStyle={{flex:1,alignItems:'center',justifyContent:'center'}}>
    <View style={{width:size*.78,height:size*.78,borderRadius:radius*.79,overflow:'hidden',alignItems:'center',justifyContent:'center'}}><LinearGradient colors={t.accentGradient} start={{x:.1,y:0}} end={{x:.85,y:1}} style={StyleSheet.absoluteFill}/><LinearGradient colors={['rgba(255,255,255,0.3)','transparent']} style={StyleSheet.absoluteFill}/><Icon name="chatbubble-ellipses" size={size*.45} color={t.onAccent}/></View>
  </GlassSurface>;
}

export function Empty({icon,title,description,action}:{icon:IconName;title:string;description:string;action?:React.ReactNode}) {
  const t=useTheme();return <View style={{alignItems:'center',paddingHorizontal:28,paddingVertical:38,gap:13}}>
    <View style={{width:126,height:126,alignItems:'center',justifyContent:'center',marginBottom:8}}><View pointerEvents="none" style={{position:'absolute',width:126,height:126,borderRadius:47,borderWidth:1,borderColor:t.glassBorder,backgroundColor:t.accentSoft,transform:[{rotate:'-15deg'}]}}/><GlassSurface radius={34} material="clear" style={{width:94,height:94,transform:[{rotate:'-5deg'}]}} contentStyle={{flex:1,alignItems:'center',justifyContent:'center'}}><Icon name={icon} color={t.accent} size={35}/></GlassSurface></View>
    <Text style={{color:t.text,fontSize:23,fontWeight:'700',letterSpacing:-.6,textAlign:'center'}}>{title}</Text><Text style={{color:t.muted,fontSize:15,lineHeight:23,textAlign:'center',maxWidth:310}}>{description}</Text>{action?<View style={{marginTop:11,width:'100%',maxWidth:270}}>{action}</View>:null}
  </View>;
}

export function AuthImage({api,id,style,resizeMode='cover'}:{api:Api;id:string;style:StyleProp<ImageStyle>;resizeMode?:'cover'|'contain'}) {
  const t=useTheme();const [uri,setUri]=useState<string|null>(null);const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let active=true,objectUrl:string|undefined;const abort=new AbortController();setUri(null);setFailed(false);
    if(Platform.OS==='web'){
      fetch(api.fileUrl(id),{headers:{Authorization:`Bearer ${api.token}`},signal:abort.signal}).then(response=>{if(!response.ok)throw new Error('image');return response.blob();}).then(blob=>{if(!active||!blob)return;objectUrl=URL.createObjectURL(blob);setUri(objectUrl);}).catch(()=>{if(active)setFailed(true);});
    }else setUri(api.fileUrl(id));
    return()=>{active=false;abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[api.base,api.token,id]);
  if(failed)return <View style={[style as StyleProp<ViewStyle>,{backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}]}><Icon name="image-outline" color={t.muted}/></View>;
  if(!uri)return <View style={[style as StyleProp<ViewStyle>,{backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}]}><ActivityIndicator size="small" color={t.accent}/></View>;
  return <Image source={{uri,...(Platform.OS==='web'?{}:{headers:{Authorization:`Bearer ${api.token}`}})}} style={style} resizeMode={resizeMode} onError={()=>setFailed(true)} accessibilityLabel="Изображение"/>;
}

function avatarTextColor(color:string) {
  if(!/^#[0-9a-f]{6}$/i.test(color))return '#FFFFFF';
  const channels=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16)/255);
  return channels[0]*.299+channels[1]*.587+channels[2]*.114>.68?'#14243D':'#FFFFFF';
}
export function Avatar({user,api,size=54}:{user:User;api:Api;size?:number}) {
  const t=useTheme();const radius=size*.36;
  if(user.avatarId)return <View style={{width:size,height:size,borderRadius:radius,borderWidth:1,borderColor:t.glassBorder,overflow:'hidden'}}><AuthImage api={api} id={user.avatarId} style={{width:size,height:size,borderRadius:radius}}/></View>;
  const initials=user.displayName.trim().split(/\s+/).slice(0,2).map(word=>word[0]||'').join('').toUpperCase();const color=user.avatarColor||'#4B73BB';
  return <View accessibilityLabel={user.displayName} style={{width:size,height:size,borderRadius:radius,backgroundColor:color,overflow:'hidden',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:t.glassBorder}}><LinearGradient colors={['rgba(255,255,255,0.27)','rgba(255,255,255,0.02)','rgba(4,15,50,0.12)']} start={{x:0,y:0}} end={{x:1,y:1}} style={StyleSheet.absoluteFill}/><Text style={{fontSize:size*.32,fontWeight:'700',letterSpacing:-.5,color:avatarTextColor(color)}}>{initials}</Text></View>;
}

export function AttachmentCard({attachment,api,onPress,compact=false}:{attachment:Attachment;api:Api;onPress:()=>void;compact?:boolean}) {
  const t=useTheme(),kind=mediaPreviewKind(attachment),thumb=useMemo(()=>previewUri(attachment.preview),[attachment.preview]);
  const visual=kind==='photo'||kind==='video';
  const icon:IconName=kind==='photo'?'image-outline':kind==='video'?'videocam-outline':kind==='audio'?'musical-notes-outline':'document-outline';
  const seconds=Math.floor((attachment.media?.durationMs||0)/1000),duration=seconds?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'';
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Загрузить и открыть ${attachment.name}`} style={({pressed})=>({opacity:pressed?.76:1})}>
    {visual&&!compact?<View style={{width:230,height:190,borderRadius:16,overflow:'hidden',backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}}>
      {thumb?<Image source={{uri:thumb}} style={StyleSheet.absoluteFill} resizeMode="cover" blurRadius={0}/>:<Icon name={icon} size={46} color={t.muted}/>}
      <View style={{width:46,height:46,borderRadius:23,backgroundColor:'rgba(10,20,35,0.62)',alignItems:'center',justifyContent:'center'}}><Icon name={kind==='video'?'play':'arrow-down'} color="#FFF" size={24}/></View>
      <View style={{position:'absolute',left:10,bottom:9,right:10,flexDirection:'row',justifyContent:'space-between'}}><Text style={{color:'#FFF',fontSize:11,paddingHorizontal:7,paddingVertical:4,borderRadius:8,backgroundColor:'rgba(10,20,35,0.68)'}}>{formatSize(attachment.size)} · загрузить</Text>{duration?<Text style={{color:'#FFF',fontSize:11,paddingHorizontal:7,paddingVertical:4,borderRadius:8,backgroundColor:'rgba(10,20,35,0.68)'}}>{duration}</Text>:null}</View>
    </View>:<View style={{flexDirection:'row',gap:10,alignItems:'center',paddingVertical:7,minWidth:180,maxWidth:270}}><View style={{width:42,height:46,borderRadius:15,backgroundColor:t.accentSoft,borderWidth:1,borderColor:t.glassBorder,alignItems:'center',justifyContent:'center'}}><Icon name={icon} color={t.accent}/></View><View style={{flex:1,gap:4}}><Text numberOfLines={2} style={{fontSize:14,fontWeight:'600',color:t.text}}>{attachment.name}</Text><Text style={{fontSize:12,color:t.muted}}>{formatSize(attachment.size)}{duration?` · ${duration}`:''} · открыть</Text></View><Icon name={kind==='audio'?'play':'arrow-down-outline'} size={17} color={t.muted}/></View>}
  </Pressable>;
}

export function Sheet({visible,title,onClose,children}:{visible:boolean;title:string;onClose:()=>void;children:React.ReactNode}) {
  const t=useTheme();const insets=useSafeAreaInsets();return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <GlassStage><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}><View style={{flex:1,justifyContent:'flex-end',backgroundColor:t.black?'rgba(0,0,0,0.45)':t.dark?'rgba(0,5,19,0.36)':'rgba(43,63,103,0.12)',paddingHorizontal:12,paddingBottom:Math.max(12,insets.bottom)}}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть"/>
      <GlassSurface radius={32} material="regular" style={{width:'100%',maxWidth:580,maxHeight:'88%',alignSelf:'center'}} contentStyle={{padding:22,paddingBottom:25,flexShrink:1}}>
        <View style={{width:36,height:4,backgroundColor:t.subtle,opacity:.45,borderRadius:2,alignSelf:'center',marginBottom:17}}/><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:13}}><Text style={{fontSize:21,fontWeight:'700',letterSpacing:-.45,color:t.text,flex:1}}>{title}</Text><IconButton name="close" label="Закрыть" onPress={onClose}/></View><ScrollView style={{flexGrow:0,flexShrink:1}} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{children}</ScrollView>
      </GlassSurface>
    </View></KeyboardAvoidingView></GlassStage>
  </Modal>;
}

export function SheetAction({icon,label,description,onPress,danger=false}:{icon:IconName;label:string;description?:string;onPress:()=>void;danger?:boolean}) {
  const t=useTheme();return <Pressable onPress={onPress} accessibilityRole="button" style={({pressed})=>({flexDirection:'row',alignItems:'center',gap:14,minHeight:76,paddingVertical:13,paddingHorizontal:10,borderRadius:19,backgroundColor:pressed?t.surface2:'transparent'})}><GlassSurface radius={16} material="clear" shadow={false} style={{width:46,height:46}} contentStyle={{flex:1,alignItems:'center',justifyContent:'center'}}><Icon name={icon} color={danger?t.danger:t.accent}/></GlassSurface><View style={{flex:1,gap:5}}><Text style={{fontSize:16,fontWeight:'600',color:danger?t.danger:t.text}}>{label}</Text>{description?<Text style={{fontSize:12,lineHeight:18,color:t.muted}}>{description}</Text>:null}</View><Icon name="chevron-forward" color={t.subtle} size={18}/></Pressable>;
}

export function SectionLabel({children}:{children:React.ReactNode}) {
  const t=useTheme();return <Text style={{fontSize:10,fontWeight:'700',letterSpacing:1.65,color:t.muted,marginBottom:13,paddingLeft:2,textTransform:'uppercase'}}>{children}</Text>;
}
