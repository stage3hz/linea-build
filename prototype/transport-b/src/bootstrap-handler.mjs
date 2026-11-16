// Experimental owned ingress. Bind to loopback behind trusted TLS, never expose
// a generic reverse proxy. No production routes or credentials are installed here.
import {createHash} from 'node:crypto';
import {makeSessionHandler} from './session-handler.mjs';
const LOCAL=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const PROOF=new Set(['/auth/device/challenge','/auth/device/bind','/auth/device/proof']);
const HEADERS=['authorization','content-type','x-linea-client','x-linea-attest','x-linea-proof'];
const fail=(res,status,error)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store, private','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(JSON.stringify({error}));};
async function bounded(stream,limit=16_384){const parts=[];let length=0;for await(const part of stream){length+=part.length;if(length>limit)throw Error('too large');parts.push(part);}return Buffer.concat(parts);}

export function makeBootstrapHandler({pool,issuer,apiOrigin='https://api.invizent.com',apiFetch=fetch,now=Date.now}){
 const origin=new URL(apiOrigin);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw TypeError('A fixed trusted HTTPS API origin is required');
 const windows=new Map();let globalWindow={until:0,count:0};
 function permitted(token){const time=now(),key=createHash('sha256').update(token).digest('hex');let window=windows.get(key);
  if(!window||window.until<=time){if(windows.size>=10000){for(const[k,v]of windows)if(v.until<=time)windows.delete(k);if(windows.size>=10000)return false;}window={until:time+60000,count:0};windows.set(key,window);}return ++window.count<=60;
 }
 async function upstream(path,options){
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000);
  try {const response=await apiFetch(origin.origin+path,{...options,redirect:'error',credentials:'omit',cache:'no-store',signal:abort.signal});
   if(response.status>=300&&response.status<400)throw Error('redirect');
   const data=await bounded(response.body);return {status:response.status,data};
  }finally{clearTimeout(timer);}
 }
 const session=makeSessionHandler({pool,issuer,authenticate:async(authorization,proof,client)=>{
  if(typeof client!=='string'||client.length>256||/[\r\n]/.test(client))return null;
  const answer=await upstream('/auth/sessions',{method:'GET',headers:{Authorization:authorization,'X-Linea-Proof':proof,'X-Linea-Client':client}});
  if(answer.status!==200)return null;
  const rows=JSON.parse(answer.data.toString()).sessions;
  if(!Array.isArray(rows))return null;
  const current=rows.filter(row=>row?.isCurrent===true);
  if(current.length!==1||!['hardware','software'].includes(current[0].deviceKey)||typeof current[0].id!=='string'||!/^[A-Za-z0-9_-]{8,96}$/.test(current[0].id))return null;
  // Bound authenticated session, not an asserted device id supplied by a client.
  return {deviceId:current[0].id,realm:issuer.realm};
 }});
 return async(req,res)=>{
  if(!LOCAL.has(req.socket?.remoteAddress))return fail(res,403,'forbidden');
  if(req.url==='/health'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end('{"status":"ok"}');return;}
  if(req.method!=='POST'||(!PROOF.has(req.url)&&req.url!=='/v1/transport-b/session'))return fail(res,404,'not_found');
  const token=req.headers.authorization;
  if(typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{16,4096}$/.test(token))return fail(res,401,'unauthorized');
  const time=now();if(globalWindow.until<=time)globalWindow={until:time+60000,count:0};
  if(++globalWindow.count>120||!permitted(token))return fail(res,429,'rate_limited');
  if(req.url==='/v1/transport-b/session')return session(req,res);
  try{
   const body=await bounded(req,8192);const decoded=JSON.parse(body.length?body.toString():'{}');
   if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))return fail(res,400,'invalid_request');
   const headers={};for(const name of HEADERS){const value=req.headers[name];if(typeof value==='string'&&value.length<=8192&&!/[\r\n]/.test(value))headers[name]=value;}
   headers['content-type']='application/json';
   const answer=await upstream(req.url,{method:'POST',headers,body:body.length?body:Buffer.from('{}')});
   res.writeHead(answer.status,{'content-type':'application/json','cache-control':'no-store, private','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(answer.data);
  }catch{return fail(res,503,'verification_unavailable');}
 };
}
