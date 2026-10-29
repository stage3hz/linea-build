import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { fromByteArray, toByteArray } from 'base64-js';
import type { Api } from '../api';
import type { Attachment, LocalFile } from '../types';
import { getSignalBridge } from './signal';
import { prepareMediaForUpload, type PreparedMedia } from '../media/pipeline';
import { sanitizePng } from '../photo/png';
import { sanitizeJpeg } from '../photo/jpeg';
import { sanitizeMp4 } from '../media/mp4';
import { makeThumbnail } from '../media/thumbnail';

const MAX_FILE=20*1024*1024;
const associatedData=(id:string)=>fromByteArray(new TextEncoder().encode(`linea-attachment-v1:${id}`));
const safeName=(name:string)=>name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g,'_').slice(-100)||'file';
export async function encryptAndUpload(api:Api,file:LocalFile):Promise<Attachment> {
  const bridge=getSignalBridge();
  if(Platform.OS==='web')throw new Error('Зашифрованные вложения доступны в приложении Android/iPhone.');
  const prepared=await prepareMediaForUpload(file);
  try{return await encryptPrepared(api,prepared,bridge);}
  finally{await prepared.dispose().catch(()=>{});}
}

async function uploadBytes(prepared:PreparedMedia):Promise<Uint8Array> {
  const file=prepared.file;
  const info=await FileSystem.getInfoAsync(file.uri);
  if(!info.exists||info.isDirectory)throw new Error('Не удалось прочитать файл.');
  if(info.size>MAX_FILE)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
  const bytes=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64}));
  if(bytes.length>MAX_FILE)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
  if(prepared.video)return sanitizeMp4(bytes,prepared.media?.hdr).bytes;
  if(!prepared.photo)return bytes;
  if(file.mimeType==='image/jpeg')return sanitizeJpeg(bytes).bytes;
  if(file.mimeType==='image/png')return sanitizePng(bytes).bytes;
  throw new Error('Обработка фото вернула неподдерживаемый формат.');
}

async function encryptPrepared(api:Api,prepared:PreparedMedia,bridge:ReturnType<typeof getSignalBridge>):Promise<Attachment> {
  const bytes=await uploadBytes(prepared),file=prepared.file;
  const preview=prepared.photo||prepared.video?await makeThumbnail(prepared).catch(()=>undefined):undefined;
  const fileKeyId=Crypto.randomUUID();const key=fromByteArray(await Crypto.getRandomBytesAsync(32));const nonce=fromByteArray(await Crypto.getRandomBytesAsync(12));
  const ciphertext=await bridge.seal(fromByteArray(bytes),key,nonce,associatedData(fileKeyId));
  const path=`${FileSystem.cacheDirectory}linea-encrypted-${fileKeyId}.bin`;
  try {
    await FileSystem.writeAsStringAsync(path,ciphertext,{encoding:FileSystem.EncodingType.Base64});
    const form=new FormData();form.append('file',{uri:path,name:'encrypted.bin',type:'application/octet-stream'} as unknown as Blob);
    const result=await api.request<{id:string;size:number}>('/e2ee/files',{method:'POST',body:form});
    return {id:result.id,name:file.name.slice(0,240)||'file',mimeType:file.mimeType.slice(0,150)||'application/octet-stream',size:bytes.length,encryption:{scheme:'aes-256-gcm-siv',key,nonce,fileKeyId},...(prepared.media?{media:prepared.media}:{}),...(preview?{preview}:{})};
  }finally{await FileSystem.deleteAsync(path,{idempotent:true}).catch(()=>{});}
}

function checkAbort(signal?:AbortSignal):void {if(signal?.aborted){const error=new Error('Загрузка отменена.');error.name='AbortError';throw error;}}

export async function decryptAttachment(api:Api,attachment:Attachment,signal?:AbortSignal):Promise<{uri:string;dispose:()=>Promise<void>}> {
  checkAbort(signal);
  const bridge=getSignalBridge();const encryption=attachment.encryption;
  if(!encryption||encryption.scheme!=='aes-256-gcm-siv')throw new Error('У вложения нет ключа сквозного шифрования.');
  if(!api.token)throw new Error('Нужно войти в аккаунт.');
  if(attachment.size>MAX_FILE)throw new Error('Файл превышает допустимый размер.');
  const response=await fetch(api.fileUrl(attachment.id),{headers:{Authorization:`Bearer ${api.token}`},credentials:'omit',cache:'no-store',redirect:'error',signal});
  if(!response.ok)throw new Error('Не удалось загрузить зашифрованный файл.');
  const claimedSize=Number(response.headers.get('content-length'));
  if(Number.isFinite(claimedSize)&&claimedSize>MAX_FILE+16)throw new Error('Размер зашифрованного файла превышает ограничение.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  checkAbort(signal);
  if(bytes.length>MAX_FILE+16||bytes.length!==attachment.size+16)throw new Error('Размер вложения не совпадает с сообщением.');
  let plain:string;
  try{plain=await bridge.open(fromByteArray(bytes),encryption.key,encryption.nonce,associatedData(encryption.fileKeyId));}
  catch{throw new Error('Проверка вложения не пройдена. Файл не будет открыт.');}
  checkAbort(signal);
  const path=`${FileSystem.cacheDirectory}linea-view-${Crypto.randomUUID()}-${safeName(attachment.name)}`;
  try{await FileSystem.writeAsStringAsync(path,plain,{encoding:FileSystem.EncodingType.Base64});checkAbort(signal);}
  catch(error){await FileSystem.deleteAsync(path,{idempotent:true}).catch(()=>{});throw error;}
  return {uri:path,dispose:()=>FileSystem.deleteAsync(path,{idempotent:true})};
}

export async function shareEncryptedAttachment(api:Api,attachment:Attachment):Promise<void> {
  if(!(await Sharing.isAvailableAsync()))throw new Error('На устройстве недоступно сохранение через меню отправки.');
  const decrypted=await decryptAttachment(api,attachment);
  try {await Sharing.shareAsync(decrypted.uri,{mimeType:attachment.mimeType,dialogTitle:attachment.name});}
  finally {await decrypted.dispose().catch(()=>{});}
}

export async function clearDecryptedAttachmentCache():Promise<void> {
  if(Platform.OS==='web'||!FileSystem.cacheDirectory)return;
  const files=await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
  await Promise.all(files.filter(name=>name.startsWith('linea-view-')).map(name=>FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${name}`,{idempotent:true})));
}
