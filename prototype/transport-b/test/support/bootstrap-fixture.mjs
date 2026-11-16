// Protocol fixture, not a real platform/Creator session. P-256 and Ed25519 are real.
import {generateKeyPairSync,randomBytes,sign,verify} from 'node:crypto';
import {createServer} from 'node:http';
import {makeBootstrapHandler} from '../../src/bootstrap-handler.mjs';
import {makeLeaseIssuer} from '../../src/lease-issuer.mjs';
export async function bootstrapFixture(){
 const sessionId='bound_session_fixture_123',token=randomBytes(32).toString('base64url');
 const device=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=device.publicKey.export({format:'jwk'});
 const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url');
 const signing=generateKeyPairSync('ed25519');let sequence=0,challenge='',proof='';
 const issuer=makeLeaseIssuer({privateKey:signing.privateKey.export({type:'pkcs8',format:'pem'}),nextSequence:async()=>++sequence});
 const primaryCalls=[],allocations=[];let bound=true;
 const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 const handler=makeBootstrapHandler({pool:{acquire:async id=>{allocations.push(id);return {joinLink:'wbstream://fixture_room_123',expiresAt:Date.now()+60_000};}},issuer,
  apiFetch:async(address,options)=>{
   const url=new URL(address);if(url.origin!=='https://api.invizent.com')throw Error('unexpected upstream');primaryCalls.push(url.pathname);
   const headers=new Headers(options.headers);
   if(headers.get('authorization')!==`Bearer ${token}`)return response(401,{error:'unauthorized'});
   if(url.pathname==='/auth/device/challenge'){challenge=randomBytes(32).toString('base64url');return response(200,{sessionId,challenge,bound:true});}
   if(url.pathname==='/auth/device/proof'){
    const {signature}=JSON.parse(String(options.body));
    if(!challenge||!verify('sha256',Buffer.from(`invizent-device-proof-v1\n${sessionId}\n${challenge}`),device.publicKey,Buffer.from(signature,'base64url')))return response(403,{code:'device_signature'});
    challenge='';proof=randomBytes(32).toString('base64url');return response(200,{proof,expiresIn:600});
   }
   if(url.pathname==='/auth/sessions'){
    if(!proof||headers.get('x-linea-proof')!==proof)return response(401,{error:'unauthorized'});
    return response(200,{sessions:[{id:sessionId,isCurrent:true,deviceKey:bound?'software':null}]});
   }
   return response(404,{});
  }});
 const server=createServer((req,res)=>{void handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint=`http://127.0.0.1:${server.address().port}`,origin='https://bootstrap.invizent.com';
 const key={ensure:async()=>({publicKey,kind:'software'}),sign:async message=>sign('sha256',Buffer.from(message),device.privateKey).toString('base64url')};
 const fetcher=(address,options)=>{const url=new URL(address);if(url.origin!==origin)throw Error('client attempted a non-bootstrap origin');return fetch(endpoint+url.pathname+url.search,options);};
 return {sessionId,token,issuer,origin,endpoint,key,fetcher,primaryCalls,allocations,setBound:value=>{bound=value;},
  proof:()=>proof,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
