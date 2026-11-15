import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { CLIENT_HEADER, type Api } from '../../api';
import { attestHeaders } from '../../attest/index';
import { deviceKey } from '../../deviceKey';
import { autoReserve, measureServers } from '../../servers/pool';
import { registerReserveRecovery, updateReserveAvailability } from '../messageRoute';
import { acquireBootstrap } from './bootstrap';
import { TRANSPORT_B_BOOTSTRAPS, TRANSPORT_B_LEASE_KEYS } from './config';
import { TransportBController } from './controller';
import { loadTransportBNetworkModule } from './native';
import { TransportBSessionRoute, verifyMessageService } from './route';

/** Signed-in, foreground text route. No production enablement without verified ingress trust material. */
export function attachAutomaticTransportB(api:Api,userId:string):()=>void{
 if(!api.token||!TRANSPORT_B_BOOTSTRAPS.length||!TRANSPORT_B_LEASE_KEYS.length)return()=>{};
 const native=loadTransportBNetworkModule();if(!native||!deviceKey())return()=>{};
 let generation=0,abort:AbortController|null=null,controller:TransportBController|null=null,route:TransportBSessionRoute|null=null;
 let expires:ReturnType<typeof setTimeout>|undefined,retryAfter=0,failures=0,disposed=false;
 const headers=(method:string,path:string)=>({'X-Linea-Client':CLIENT_HEADER,...attestHeaders(method,path)});
 const stop=async()=>{
  generation++;abort?.abort();abort=null;if(expires)clearTimeout(expires);expires=undefined;
  const held=controller;controller=null;route=null;controls.clear();await held?.stop();
 };
 const controls=registerReserveRecovery({
  stop,
  reset:async()=>{retryAfter=0;failures=0;await stop();},
  recover:async()=>{
   if(disposed||!autoReserve())return false;if(route?.ready)return true;if(Date.now()<retryAfter)return false;
   await stop();const epoch=++generation,attempt=new AbortController();abort=attempt;
   try{
    const offer=await acquireBootstrap({origins:TRANSPORT_B_BOOTSTRAPS,token:api.token!,key:deviceKey,headers},attempt.signal);
    if(disposed||attempt.signal.aborted||generation!==epoch)return false;
    const current=new TransportBSessionRoute(native,randomUUID(),api.base,verifyMessageService(userId,async()=>({
     headers:{...headers('GET','/me'),Authorization:`Bearer ${api.token}`,'X-Linea-Proof':offer.proof},
     auth:{type:'auth',token:api.token,proof:offer.proof,lean:true},
    })));
    route=current;
    const store=`invizent.transport-b.sequence.v1:${encodeURIComponent(api.base)}:${offer.deviceId}`;
    const next=new TransportBController({deviceId:offer.deviceId,realm:api.base,publicKeys:TRANSPORT_B_LEASE_KEYS,
     acquire:async()=>offer.signed,joiner:current,
     loadSequence:async()=>{const raw=await AsyncStorage.getItem(store);if(raw===null)return 0;if(!/^\d{1,16}$/.test(raw))throw Error('Invalid sequence');const n=Number(raw);if(!Number.isSafeInteger(n))throw Error('Invalid sequence');return n;},
     saveSequence:async n=>{await AsyncStorage.setItem(store,String(n));},
    });controller=next;
    if(!await next.start()||disposed||generation!==epoch||attempt.signal.aborted)throw Error('Route unavailable');
    const until=JSON.parse(offer.signed.payload).expiresAt as number;
    if(until<=Date.now()||!controls.publish(current))throw Error('Stale route');
    failures=0;retryAfter=0;
    expires=setTimeout(()=>{void stop().finally(()=>{if(!disposed)void measureServers();});},until-Date.now());
    return true;
   }catch{
    if(generation===epoch){failures++;retryAfter=Date.now()+Math.min(300_000,15_000*2**Math.min(failures-1,5));await stop();}
    return false;
   }
  },
  returnDirect:async()=>{
   if(disposed||!route?.ready)return false;
   const epoch=generation,attempt=new AbortController();abort=attempt;
   const timer=setTimeout(()=>attempt.abort(),15_000);
   try{
    const target=api.endpoint;
    const verify=verifyMessageService(userId,async()=>{await api.ensureProof(false,attempt.signal);return {
     headers:{...headers('GET','/me'),...api.authHeaders},auth:{type:'auth',token:api.token,...(api.proof?{proof:api.proof}:{}),lean:true},
    };});
    await verify({origin:target,fetch:(url,options)=>fetch(url,{credentials:'omit',cache:'no-store',redirect:'error',...options}),openSocket:url=>new WebSocket(url)},attempt.signal);
    if(disposed||generation!==epoch||attempt.signal.aborted)return false;
    await stop();return true;
   }catch{return false;}finally{clearTimeout(timer);if(abort===attempt)abort=null;}
  },
 });
 // Starting after the pool's initial measurements must still trigger recovery.
 void measureServers().then(()=>updateReserveAvailability({enabled:autoReserve(),allFailed:false,directStable:false}));
 return()=>{disposed=true;controls.dispose();};
}
