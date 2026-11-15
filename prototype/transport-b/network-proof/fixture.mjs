// Real TLS + RFC 1929 SOCKS5 + WSS fixture, local disposable runner only.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const {WebSocketServer}=createRequire(new URL('../../../server/package.json',import.meta.url))('ws');
const root=process.argv[2];mkdirSync(root,{recursive:true});
const openssl=(...args)=>execFileSync('openssl',args,{cwd:root,stdio:'ignore'});
openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=INVIZENT Stage B ephemeral CI CA');
openssl('req','-newkey','rsa:2048','-nodes','-keyout','tls.key','-out','tls.csr','-subj','/CN=localhost');
writeFileSync(join(root,'tls.ext'),'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
openssl('x509','-req','-in','tls.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','tls.pem','-days','1','-extfile','tls.ext');
openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','bad.key','-out','bad.pem','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost');
const stats={authenticated:0,denied:0,http:0,websocket:0,direct:0};
const peers=new Set(),proxyPorts=new Set();
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const tls=https.createServer({key:readFileSync(join(root,'tls.key')),cert:readFileSync(join(root,'tls.pem'))},(req,res)=>{
 stats.http++;if(!proxyPorts.has(req.socket.remotePort))stats.direct++;
 if(req.url==='/hang'){res.writeHead(200);res.write('waiting');return;}
 if(req.url==='/redirect'){res.writeHead(302,{location:'https://example.com/'});res.end();return;}
 if(req.url!=='/health'&&req.headers.authorization!=='Bearer fixture-device-session'){res.writeHead(401);res.end('{}');return;}
 const chunks=[];req.on('data',v=>chunks.push(v));req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:{user:{id:'fixture'},body:Buffer.concat(chunks).toString()}));});
});
const wss=new WebSocketServer({server:tls});
wss.on('connection',(socket,req)=>{stats.websocket++;if(!proxyPorts.has(req.socket.remotePort))stats.direct++;let authorized=false;
 socket.on('message',raw=>{const text=raw.toString();if(!authorized){const data=JSON.parse(text);if(data.type!=='auth'||data.token!=='fixture-device-session'){socket.close(4401);return;}authorized=true;socket.send('{"type":"ready"}');}else socket.send(text);});
});
const goodPort=await listen(tls);
const bad=https.createServer({key:readFileSync(join(root,'bad.key')),cert:readFileSync(join(root,'bad.pem'))},(_req,res)=>res.end('{}'));
const badPort=await listen(bad);
const username=randomBytes(12).toString('hex'),password=randomBytes(24).toString('hex');
const proxy=net.createServer(socket=>{
 peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
 let bytes=Buffer.alloc(0),state='greeting';
 const fail=()=>{stats.denied++;socket.destroy();};
 function receive(data){bytes=Buffer.concat([bytes,data]);if(bytes.length>8192){fail();return;}
  if(state==='greeting'){
   if(bytes.length<2||bytes.length<2+bytes[1])return;
   const n=bytes[1];if(bytes[0]!==5||!bytes.subarray(2,2+n).includes(2)){fail();return;}
   bytes=bytes.subarray(2+n);state='auth';socket.write(Buffer.from([5,2]));
  }
  if(state==='auth'){
   if(bytes.length<2||bytes.length<3+bytes[1])return;
   const n=bytes[1],p=bytes[2+n];if(bytes.length<3+n+p)return;
   if(bytes[0]!==1||bytes.subarray(2,2+n).toString()!==username||bytes.subarray(3+n,3+n+p).toString()!==password){socket.end(Buffer.from([1,1]));stats.denied++;return;}
   bytes=bytes.subarray(3+n+p);state='connect';stats.authenticated++;socket.write(Buffer.from([1,0]));
  }
  if(state==='connect'){
   if(bytes.length<5)return;
   const type=bytes[3];let host,n;
   if(type===3){n=7+bytes[4];if(bytes.length<n)return;host=bytes.subarray(5,5+bytes[4]).toString();}
   else if(type===1){n=10;if(bytes.length<n)return;host=Array.from(bytes.subarray(4,8)).join('.');}
   else if(type===4){n=22;if(bytes.length<n)return;host=bytes.subarray(4,20).toString('hex')==='00000000000000000000000000000001'?'::1':'other';}
   else{fail();return;}
   const port=bytes.readUInt16BE(n-2);
   if(bytes[0]!==5||bytes[1]!==1||!['localhost','127.0.0.1','::1'].includes(host)||![goodPort,badPort].includes(port)){fail();return;}
   state='forward';socket.removeListener('data',receive);socket.pause();
   const target=net.connect(port,'127.0.0.1',()=>{
    proxyPorts.add(target.localPort);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
    if(bytes.length>n)target.write(bytes.subarray(n));bytes=Buffer.alloc(0);socket.pipe(target);target.pipe(socket);socket.resume();
   });target.on('error',()=>socket.destroy());socket.on('close',()=>target.destroy());
  }
 }
 socket.on('data',receive);
});
const proxyPort=await listen(proxy);
const control=http.createServer((req,res)=>{
 if(req.url==='/stop-proxy'){proxy.close();for(const socket of peers)socket.destroy();}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(stats));
});
const controlPort=await listen(control);
writeFileSync(join(root,'config.json'),JSON.stringify({origin:`https://localhost:${goodPort}`,badOrigin:`https://localhost:${badPort}`,control:`http://127.0.0.1:${controlPort}`,port:proxyPort,username,password}),{mode:0o600});
console.log('Local TLS/SOCKS/WSS fixture ready. No production service is used.');
