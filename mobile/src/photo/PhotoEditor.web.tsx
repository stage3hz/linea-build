import React, { useState } from 'react';
import { Modal, View, Image } from 'react-native';
import { Text } from '../typography';
import { Button, Notice } from '../components';
import { useTheme } from '../theme';
import type { LocalFile } from '../types';
export function PhotoEditor({ file, onCancel, onReady }: { file:LocalFile;onCancel:()=>void;onReady:(file:LocalFile)=>Promise<void> }) {
 const t=useTheme(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[square,setSquare]=useState(false);
 const save=async()=>{setBusy(true);setError('');let uri;
  try {
   const response=await fetch(file.uri),bitmap=await createImageBitmap(await response.blob());
   const width=square?Math.min(bitmap.width,bitmap.height):bitmap.width,height=square?width:bitmap.height;
   const scale=Math.min(1,4096/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
   const context=canvas.getContext('2d');if(!context)throw new Error('Не удалось обработать фото.');
   context.fillStyle='#FFFFFF';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,(bitmap.width-width)/2,(bitmap.height-height)/2,width,height,0,0,canvas.width,canvas.height);bitmap.close();
   const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Не удалось обработать фото.')),'image/jpeg',.92));
   uri=URL.createObjectURL(blob);await onReady({uri,name:file.name.replace(/\.[^.]+$/,'')+'.jpg',mimeType:'image/jpeg',size:blob.size});
  }catch(e){setError(e instanceof Error?e.message:'Не удалось обработать фото.');}finally{if(uri)URL.revokeObjectURL(uri);setBusy(false);}
 };
 return <Modal visible onRequestClose={onCancel}><View style={{flex:1,backgroundColor:t.bg,padding:24,gap:14}}><Text style={{color:t.text,fontSize:22}}>Фото</Text><Image source={{uri:file.uri}} resizeMode="contain" style={{flex:1}}/>{error?<Notice error text={error}/>:null}<Button label={square?'Целиком':'Квадрат'} onPress={()=>setSquare(!square)}/><Button label="Сохранить" onPress={()=>void save()} disabled={busy}/><Button label="Отмена" onPress={onCancel} disabled={busy}/></View></Modal>;
}
