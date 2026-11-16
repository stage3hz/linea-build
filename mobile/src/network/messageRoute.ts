// App-local dispatch only. Native players, other applications and global fetch are untouched.
import type { TransportBSessionRoute } from './transportB/route';
import { normalizeServer } from '../servers/list';
export type ReserveRecovery = { recover():Promise<boolean>; returnDirect():Promise<boolean>; stop():Promise<void>; reset?():Promise<void> };
type Registration = {handler:ReserveRecovery; busy:Promise<boolean>|null};
let registration:Registration|null=null;
let active:{owner:Registration;route:TransportBSessionRoute;off:()=>void}|null=null;
let revision=0;
const listeners=new Set<()=>void>();
const emit=(changed=false)=>{if(changed)revision++;for(const listener of listeners){try{listener();}catch{/* one subscriber cannot break routing */}}};
export const subscribeMessageRoute=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const messageRouteRevision=()=>revision;
export const reserveRouteStatus=(): 'ready'|'checking'|'off'=>active?.route.ready?'ready':registration?.busy?'checking':'off';
function clear(owner:Registration){if(active?.owner!==owner)return;const previous=active;active=null;previous.off();emit(true);void previous.route.stop();}

/** Generation-owned registration: old cleanup or late validation cannot replace a new account's route. */
export function registerReserveRecovery(handler:ReserveRecovery){
 if(registration){const previous=registration;clear(previous);void previous.handler.stop();}
 const owner:Registration={handler,busy:null};registration=owner;
 return {
  publish(route:TransportBSessionRoute){
   if(registration!==owner||!route.ready)return false;
   if(active?.route===route)return true;
   if(active)clear(active.owner);
   const off=route.onLost(()=>clear(owner));active={owner,route,off};emit(true);return true;
  },
  clear(){clear(owner);},
  dispose(){if(registration!==owner)return;registration=null;clear(owner);void handler.stop();emit();},
 };
}
export function updateReserveAvailability({enabled,allFailed,directStable}:{enabled:boolean;allFailed:boolean;directStable:boolean}){
 const owner=registration;if(!owner)return;
 if(!enabled){clear(owner);void (owner.handler.reset?.()??owner.handler.stop());return;}
 if(owner.busy)return;
 const action=active?.owner===owner?(directStable?()=>owner.handler.returnDirect():null):(allFailed?()=>owner.handler.recover():null);
 if(!action)return;
 const run=Promise.resolve().then(action).catch(()=>false).finally(()=>{if(owner.busy===run){owner.busy=null;if(registration===owner)emit();}});
 owner.busy=run;emit();
}
/** A failed authenticated message channel invalidates the route, not the account. */
export function reportMessageRouteFailure(){const selected=active;if(!selected)return false;clear(selected.owner);return true;}
export function resetReserveNetwork(){const owner=registration;if(!owner)return;clear(owner);void (owner.handler.reset?.()??owner.handler.stop());}
function target(address:string,websocket=false){
 const url=new URL(address),origin=websocket?url.origin.replace(/^wss:/,'https:'):url.origin;
 if(!normalizeServer(origin)||url.username||url.password||url.hash||url.protocol!==(websocket?'wss:':'https:'))throw Error('Invalid message route destination');
 return url.pathname+url.search;
}
export async function messageFetch(address:string,options:RequestInit={}):Promise<Response>{
 const selected=active;if(!selected)return fetch(address,options);
 const path=target(address);
 try{return await selected.route.fetch(selected.route.origin+path,options);}
 catch(error){if(!options.signal?.aborted&&!(error instanceof Error&&error.name==='ReserveTransferError')&&active===selected)clear(selected.owner);throw error;}
}
export function messageSocket(address:string):WebSocket{
 const selected=active;if(!selected)return new WebSocket(address);
 const path=target(address,true);
 return selected.route.openSocket(selected.route.origin.replace(/^https:/,'wss:')+path) as unknown as WebSocket;
}
