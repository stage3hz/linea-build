import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';
import { decryptAttachment } from './attachments';

export function EncryptedImage({api,attachment,style,resizeMode='cover'}:{api:Api;attachment:Attachment;style:StyleProp<ImageStyle>;resizeMode?:'cover'|'contain'}) {
  const t=useTheme();const [uri,setUri]=useState<string|null>(null);const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let live=true;let dispose:(()=>Promise<void>)|undefined;
    setUri(null);setFailed(false);
    void decryptAttachment(api,attachment).then(result=>{
      dispose=result.dispose;
      if(live)setUri(result.uri);else void result.dispose();
    }).catch(()=>{if(live)setFailed(true);});
    return()=>{live=false;if(dispose)void dispose().catch(()=>{});};
  },[api,attachment.id,attachment.encryption?.key,attachment.encryption?.nonce]);
  if(!uri||failed)return <View accessibilityLabel={failed?'Не удалось проверить и расшифровать изображение':'Расшифровка изображения'} style={[style as StyleProp<ViewStyle>,{backgroundColor:t.surface2,alignItems:'center',justifyContent:'center'}]}>{failed?<Ionicons name="shield-outline" size={24} color={t.danger}/>:<ActivityIndicator color={t.accent}/>}</View>;
  return <Image source={{uri}} style={style} resizeMode={resizeMode} accessibilityLabel={attachment.name} onError={()=>setFailed(true)}/>;
}
