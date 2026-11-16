import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {createInvizentEgress,publicAddress} from '../src/egress.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
function reader(socket){let buffer=Buffer.alloc(0),waiting=null;socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);pump();});socket.on('close',()=>{waiting?.reject(Error('closed'));waiting=null;});function pump(){if(waiting&&buffer.length>=waiting.size){const {size,resolve}=waiting;waiting=null;const value=buffer.subarray(0,size);buffer=buffer.subarray(size);resolve(value);}}return size=>new Promise((resolve,reject)=>{waiting={size,resolve,reject};pump();});}
async function client(address){const port=Number(address.split(':')[1]),socket=net.connect(port,'127.0.0.1');await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});const read=reader(socket);socket.write(Buffer.from([5,1,0]));assert.deepEqual(await read(2),Buffer.from([5,0]));return{socket,read};}
function connect(host,port=443,command=1){const name=Buffer.from(host);const value=Buffer.alloc(7+name.length);value.set([5,command,0,3,name.length]);name.copy(value,5);value.writeUInt16BE(port,value.length-2);return value;}
test('app egress rejects private, local, documentation and transition addresses',()=>{
 for(const value of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1','::ffff:127.0.0.1','2001:db8::1','2001::1','2002:0808:0808::1','3fff::1'])assert.equal(publicAddress(value),false,value);
 for(const value of ['8.8.8.8','1.1.1.1','2606:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(value),true,value);
});
test('only canonical API TCP/443 is accepted; encrypted bytes and pipelined initial bytes remain opaque',async t=>{
 const echo=net.createServer(socket=>socket.pipe(socket));const port=await listen(echo);let dials=0;
 const egress=createInvizentEgress({resolve:async()=>[{address:'8.8.8.8'}],dial:(address,destination)=>{assert.equal(address,'8.8.8.8');assert.equal(destination,443);dials++;return net.connect(port,'127.0.0.1');}});
 const address=await egress.listen();t.after(async()=>{await egress.close();await new Promise(resolve=>echo.close(resolve));});
 for(const request of [connect('example.com'),connect('api.invizent.com',80),connect('api.invizent.com',443,3),Buffer.from([5,1,0,1,127,0,0,1,1,187])]){
  const {socket,read}=await client(address);socket.write(request);const reply=await read(10);assert.notEqual(reply[1],0);socket.destroy();
 }
 assert.equal(dials,0);
 const {socket,read}=await client(address),payload=Buffer.from([0,1,2,255,254,0,8,7]);
 socket.write(Buffer.concat([connect('api.invizent.com'),payload]));const reply=await read(10);assert.equal(reply[1],0);assert.deepEqual(await read(payload.length),payload);assert.equal(dials,1);socket.destroy();
});
test('DNS rebinding to even one private address prevents any upstream dial',async t=>{
 let dials=0;const egress=createInvizentEgress({resolve:async()=>[{address:'8.8.8.8'},{address:'127.0.0.1'}],dial:()=>{dials++;throw Error('must not dial');}});
 const address=await egress.listen();t.after(()=>egress.close());const {socket,read}=await client(address);socket.write(connect('api.invizent.com'));const reply=await read(10);assert.notEqual(reply[1],0);assert.equal(dials,0);socket.destroy();
});
