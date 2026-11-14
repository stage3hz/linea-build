/**
 * INVIZENT controlled allowlist laboratory, NOT an SFU or an operator DPI model.
 * Docker separates the origin and allowed carrier at the actual network layer.
 */
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIMIT=4096, ID=/^[a-zA-Z0-9_-]{1,96}$/;
function listen(server,host,port) {
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,host,()=>{server.off('error',reject);resolve(server.address());});
  });
}
export async function startTestApi({key,cert,host='127.0.0.1',port=0}={}) {
  if(!key||!cert)throw new TypeError('ephemeral TLS key and certificate required');
  const seen=new Map();
  const server=tls.createServer({key,cert,minVersion:'TLSv1.2'},socket=>{
    socket.setTimeout(10000,()=>socket.destroy());
    let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk.toString('utf8');
      if(buffer.length>LIMIT)return socket.destroy();
      let nl;
      while((nl=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);
        let req;
        try{req=JSON.parse(line);}catch{socket.write('{"error":"malformed"}\n');continue;}
        if(req?.type!=='message'||typeof req.clientId!=='string'||!ID.test(req.clientId)||
            typeof req.body!=='string'||req.body.length>1024){
          socket.write('{"error":"invalid"}\n');continue;
        }
        const fresh=!seen.has(req.clientId);
        if(fresh)seen.set(req.clientId,req.body);
        socket.write(JSON.stringify({status:'ok',clientId:req.clientId,firstDelivery:fresh,storedMessages:seen.size})+'\n');
      }
    });
    socket.on('error',()=>{});
  });
  return {server,address:await listen(server,host,port),seen};
}
export async function startCarrier({host='127.0.0.1',port=0,targetHost,targetPort}={}) {
  if(typeof targetHost!=='string'||!Number.isInteger(targetPort))throw new TypeError('fixed test upstream required');
  let connections=0;
  const server=net.createServer(incoming=>{
    connections++;
    const outgoing=net.connect(targetPort,targetHost);
    incoming.on('error',()=>outgoing.destroy());
    outgoing.on('error',()=>incoming.destroy());
    incoming.on('close',()=>outgoing.destroy());
    outgoing.on('close',()=>incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);
  });
  return {server,address:await listen(server,host,port),stats:()=>({connections})};
}
/** TLS is authenticated against the original API through a byte-transparent relay. */
export function exchange({host,port,ca,servername='api.lab.test',clientId='msg-0001',body='TEST_ONLY',timeoutMs=1500}) {
  return new Promise((resolve,reject)=>{
    let finished=false,text='';
    const socket=tls.connect({host,port,ca,servername,rejectUnauthorized:true,minVersion:'TLSv1.2'});
    const complete=(error,result)=>{
      if(finished)return;finished=true;socket.destroy();
      if(error)reject(error);else resolve(result);
    };
    socket.setTimeout(timeoutMs,()=>complete(new Error('connect timeout')));
    socket.on('secureConnect',()=>{
      if(!socket.authorized)return complete(new Error('TLS peer was not authenticated'));
      socket.write(JSON.stringify({type:'message',clientId,body})+'\n');
    });
    socket.on('data',chunk=>{
      text+=chunk.toString('utf8');
      if(text.length>LIMIT)return complete(new Error('oversized test response'));
      const nl=text.indexOf('\n');if(nl<0)return;
      try{complete(null,JSON.parse(text.slice(0,nl)));}
      catch{complete(new Error('invalid test response'));}
    });
    socket.on('error',error=>complete(error));
    socket.on('close',()=>{if(!finished)complete(new Error('unexpected close'));});
  });
}
/** Policy callback simulates blocking in unprivileged Node tests; Docker enforces it in the kernel. */
export async function sendWithFallback({primary,reserve,ca,policy=()=>true,...message}){
  const attempts=[];
  for(const [name,endpoint] of [['direct',primary],['reserve',reserve]]){
    if(!policy(name,endpoint)){attempts.push({name,outcome:'not_on_allowlist'});continue;}
    try{
      const response=await exchange({...endpoint,ca,...message});
      if(response.status!=='ok')throw new Error('unexpected response');
      attempts.push({name,outcome:'delivered'});
      return {route:name,response,attempts};
    }catch{attempts.push({name,outcome:'unreachable'});}
  }
  return {route:'offline',response:null,attempts};
}
async function cli(){
  const role=process.argv[2];
  if(role==='api'){
    await startTestApi({key:readFileSync('/run/labcerts/server.key'),cert:readFileSync('/run/labcerts/ca.crt'),host:'0.0.0.0',port:8443});
    console.log('TEST API READY');
  }else if(role==='carrier'){
    await startCarrier({host:'0.0.0.0',port:8443,targetHost:process.env.LAB_ORIGIN_IP,targetPort:8443});
    console.log('TEST CARRIER READY');
  }else if(role==='client'){
    const ca=readFileSync('/run/labcerts/ca.crt');
    const result=await sendWithFallback({
      primary:{host:process.env.LAB_ORIGIN_IP,port:8443},
      reserve:{host:process.env.LAB_CARRIER_IP,port:8443},
      ca,clientId:'test-'+process.env.LAB_MODE+'-message',timeoutMs:1200,
    });
    const expected=process.env.LAB_MODE==='restricted'?'reserve':'direct';
    if(result.route!==expected||result.response?.storedMessages<1||!result.response?.clientId){
      console.error('LAB FAILED',{expected,result});process.exitCode=1;
    }else console.log('LAB PASSED',{expected,selected:result.route,attempts:result.attempts});
  }else throw new Error('Usage: node lab.mjs api|carrier|client');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])
  cli().catch(error=>{console.error('LAB FAILED:',error.message);process.exitCode=1;});
