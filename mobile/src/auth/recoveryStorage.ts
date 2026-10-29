import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { RecoveryChallenge } from '../types';

// A recovery grant is a short-lived credential. Never put it in AsyncStorage,
// URLs, logs, analytics, or the ordinary account-token key.
const KEY='linea.recovery.pending.v1';
type SavedRecovery={version:1;base:string;username:string;challenge:RecoveryChallenge};
let queue:Promise<unknown>=Promise.resolve();
function serial<T>(action:()=>Promise<T>):Promise<T> {
  const result=queue.then(action,action);queue=result.catch(()=>{});return result;
}
async function readRaw() {
  if(Platform.OS==='web')return typeof sessionStorage==='undefined'?null:sessionStorage.getItem(KEY);
  return SecureStore.getItemAsync(KEY);
}
async function removeRaw() {
  if(Platform.OS==='web'){if(typeof sessionStorage!=='undefined')sessionStorage.removeItem(KEY);return;}
  await SecureStore.deleteItemAsync(KEY);
}
function decode(raw:string|null):SavedRecovery|null {
  if(!raw)return null;
  try{
    const value=JSON.parse(raw),grant=value?.challenge;
    if(value?.version!==1||typeof value.base!=='string'||value.base.length>512||typeof value.username!=='string'
      ||!/^[a-z0-9_]{3,24}$/.test(value.username)||!grant||typeof grant.resetToken!=='string'
      ||!/^[A-Za-z0-9_-]{43}$/.test(grant.resetToken)||typeof grant.requestId!=='string'||grant.requestId.length>128
      ||!grant.requestId||!['readyAt','expiresAt','serverTime'].every(key=>typeof grant[key]==='string'&&Number.isFinite(Date.parse(grant[key]))))return null;
    if(Date.parse(grant.expiresAt)<=Date.parse(grant.readyAt))return null;
    return {version:1,base:value.base,username:value.username,challenge:{resetToken:grant.resetToken,requestId:grant.requestId,readyAt:grant.readyAt,expiresAt:grant.expiresAt,serverTime:grant.serverTime}};
  }catch{return null;}
}
export function readRecovery(base:string):Promise<SavedRecovery|null> {
  return serial(async()=>{const raw=await readRaw(),value=decode(raw);if(raw&&!value)await removeRaw();return value?.base===base?value:null;});
}
export function saveRecovery(base:string,username:string,challenge:RecoveryChallenge):Promise<void> {
  return serial(async()=>{
    const value:SavedRecovery={version:1,base,username,challenge:{resetToken:challenge.resetToken,requestId:challenge.requestId,readyAt:challenge.readyAt,expiresAt:challenge.expiresAt,serverTime:challenge.serverTime}};
    const raw=JSON.stringify(value);if(!decode(raw))throw new Error('Сервер вернул некорректное подтверждение восстановления.');
    if(Platform.OS==='web'){
      if(typeof sessionStorage==='undefined')throw new Error('Не удалось сохранить запрос восстановления на этом устройстве.');
      sessionStorage.setItem(KEY,raw);return;
    }
    await SecureStore.setItemAsync(KEY,raw,{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY});
  });
}
export function clearRecovery(base:string,resetToken?:string):Promise<void> {
  return serial(async()=>{
    const value=decode(await readRaw());
    if(value?.base===base&&(!resetToken||value.challenge.resetToken===resetToken))await removeRaw();
  });
}
