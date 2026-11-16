// Creator's app-data exit: loopback only, TCP/443 to the canonical API only.
// Not a public SOCKS service. Pinned Creator wiring and namespace isolation still
// need a real Creator/Joiner test before a public deployment is permitted.
import net from 'node:net';
import {lookup} from 'node:dns/promises';
export function publicAddress(address){
 if(net.isIPv4(address)){
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
 }
 if(!net.isIPv6(address))return false;
 const parts=address.split(':'),first=parseInt(parts[0]||'0',16),second=parseInt(parts[1]||'0',16);
 return first>=0x2000&&first<=0x3fff&&first!==0x2002&&!(first===0x2001&&(second===0||second===0xdb8||second>=0x10&&second<=0x2f))&&!(first===0x3fff&&second<=0xfff);
}
export function createInvizentEgress({resolve=host=>lookup(host,{all:true}),dial=(address,port)=>net.connect(port,address),now=Date.now}={}){
 const sockets=new Set();let cached=null,busy=null,until=0;
 async function destination(){
  if(cached&&until>now())return cached;
  if(!busy)busy=Promise.resolve().then(()=>resolve('api.invizent.com')).then(rows=>{
   if(!Array.isArray(rows)||rows.length<1||rows.length>32||rows.some(row=>!publicAddress(row.address)))throw Error('Invalid service address');
   cached=rows[0].address;until=now()+15000;return cached;
  }).finally(()=>{busy=null;});
  return busy;
 }
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(5000,()=>socket.destroy());
  let bytes=Buffer.alloc(0),stage='greeting';
  const deny=()=>{socket.end(Buffer.from([5,2,0,1,0,0,0,0,0,0]));};
  const receive=data=>{
   bytes=Buffer.concat([bytes,data]);if(bytes.length>1024){socket.destroy();return;}
   if(stage==='greeting'){
    if(bytes.length<2||bytes.length<2+bytes[1])return;
    if(bytes[0]!==5||!bytes.subarray(2,2+bytes[1]).includes(0)){socket.end(Buffer.from([5,255]));return;}
    bytes=bytes.subarray(2+bytes[1]);stage='request';socket.write(Buffer.from([5,0]));
   }
   if(stage!=='request'||bytes.length<5)return;
   if(bytes[0]!==5||bytes[1]!==1||bytes[2]!==0||bytes[3]!==3){deny();return;}
   const length=7+bytes[4];if(bytes.length<length)return;
   const hostname=bytes.subarray(5,5+bytes[4]).toString('ascii'),port=bytes.readUInt16BE(length-2);
   if(hostname!=='api.invizent.com'||!bytes.subarray(5,5+bytes[4]).equals(Buffer.from('api.invizent.com'))||port!==443){deny();return;}
   stage='dial';socket.pause();socket.removeListener('data',receive);
   void destination().then(address=>{
    if(socket.destroyed)return;
    const upstream=dial(address,443);sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
    upstream.setTimeout(360000,()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
    upstream.on('connect',()=>{
     if(socket.destroyed){upstream.destroy();return;}
     socket.setTimeout(360000,()=>socket.destroy());socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
     if(bytes.length>length)upstream.write(bytes.subarray(length));bytes=Buffer.alloc(0);
     socket.pipe(upstream);upstream.pipe(socket);socket.resume();
    });
   }).catch(deny);
  };socket.on('data',receive);
 });server.maxConnections=128;
 return {server,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return `127.0.0.1:${server.address().port}`;},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
