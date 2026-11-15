import type { NetworkTier } from './quality';
/** A TCP/WebSocket open is not authenticated service readiness. Slow links get a longer budget. */
export function messageHandshakeExpired(input:{ready:boolean;hasSocket:boolean;sinceStart:number;tier:NetworkTier}):boolean{
 const limit=input.tier==='slow'?90_000:input.tier==='medium'?45_000:25_000;
 return input.hasSocket&&!input.ready&&input.sinceStart>limit;
}
export function messageHeartbeatStale(tier:NetworkTier):number{return tier==='slow'?45_000:tier==='medium'?25_000:15_000;}
