import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type TextInputProps } from 'react-native';
import { Text, TextInput } from '../typography';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { isManualEdit } from './manualEdit';

type Props = Omit<TextInputProps, 'value'|'onChangeText'> & {
  value:string; onChangeText:(value:string)=>void; label?:string;
};

/** Local entry policy requested by the product owner. This is not a server-side
 * security control and cannot prove how text was produced by an input method. */
export function ManualField({value,onChangeText,label,style,onFocus,onBlur,onSelectionChange,...props}:Props) {
  const t=useTheme();
  const input=useRef<TextInput>(null),accepted=useRef(value),selection=useRef({start:0,end:0});
  const [focused,setFocused]=useState(false),[rejected,setRejected]=useState(false);
  accepted.current=value;
  useEffect(()=>{if(!value)setRejected(false);},[value]);
  const restore=()=>{
    const text=accepted.current;
    const caret={start:Math.min(selection.current.start,text.length),end:Math.min(selection.current.end,text.length)};
    if(Platform.OS==='web'){
      const node=input.current as unknown as HTMLInputElement|null;
      if(node){node.value=text;try{node.setSelectionRange(caret.start,caret.end);}catch{}}
    }else input.current?.setNativeProps({text,selection:caret});
    setRejected(true);
  };
  useEffect(()=>{
    if(Platform.OS!=='web')return;
    const node=input.current as unknown as HTMLInputElement|null;
    if(!node)return;
    const block=(event:Event)=>{event.preventDefault();setRejected(true);};
    const beforeInput=(event:Event)=>{
      const edit=event as InputEvent;
      const kind=typeof edit.inputType==='string'?edit.inputType:'';
      if(['insertFromPaste','insertFromDrop','insertReplacementText','insertFromYank'].includes(kind)
        ||(kind.startsWith('insert')&&typeof edit.data==='string'&&Array.from(edit.data).length>1))block(event);
    };
    node.setAttribute('autocomplete','off');node.setAttribute('data-1p-ignore','true');node.setAttribute('data-lpignore','true');
    node.addEventListener('paste',block);node.addEventListener('drop',block);node.addEventListener('beforeinput',beforeInput);
    return()=>{node.removeEventListener('paste',block);node.removeEventListener('drop',block);node.removeEventListener('beforeinput',beforeInput);};
  },[]);
  return <View style={{gap:8}}>
    {label?<Text style={{fontSize:11,fontWeight:'700',letterSpacing:1,color:t.muted,textTransform:'uppercase',paddingLeft:2}}>{label}</Text>:null}
    <GlassSurface radius={18} material="regular" shadow={false}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:18,borderWidth:focused?1.4:0,borderColor:t.accent}]}/>
      <TextInput {...props} ref={input} value={value} accessibilityLabel={props.accessibilityLabel||label}
        onChangeText={next=>{if(!isManualEdit(accepted.current,next)){restore();return;}accepted.current=next;setRejected(false);onChangeText(next);}}
        onSelectionChange={event=>{selection.current=event.nativeEvent.selection;onSelectionChange?.(event);}}
        autoComplete="off" textContentType="none" importantForAutofill="noExcludeDescendants" contextMenuHidden
        autoCapitalize="none" autoCorrect={false} spellCheck={false} smartInsertDelete={false}
        placeholderTextColor={props.placeholderTextColor||t.subtle} keyboardAppearance={t.dark?'dark':'light'} selectionColor={t.accent}
        onFocus={event=>{setFocused(true);onFocus?.(event);}} onBlur={event=>{setFocused(false);onBlur?.(event);}}
        style={[{minHeight:54,paddingHorizontal:17,paddingVertical:14,borderRadius:18,backgroundColor:'transparent',color:t.text,fontSize:16},style]}/>
    </GlassSurface>
    {rejected?<Text accessibilityLiveRegion="polite" style={{color:t.muted,fontSize:11,lineHeight:16,paddingLeft:2}}>Введи по одному символу. Вставка и автозаполнение отключены.</Text>:null}
  </View>;
}
