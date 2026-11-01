import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const model=loadTs(new URL('../src/communities/screenShareModel.ts',import.meta.url));
test('only two bounded 60fps screen presets are accepted',()=>{
 assert.deepEqual(Object.keys(model.SCREEN_QUALITIES),['720p60','1080p60']);
 assert.equal(model.SCREEN_QUALITIES['1080p60'].frameRate,60);
 assert.equal(model.SCREEN_QUALITIES['720p60'].width,1280);
 for(const v of [null,'720p30',{},42])assert.throws(()=>model.screenQuality(v));
 for(const v of [null,'x'.repeat(257),'{}','{"type":"screen","active":"true","quality":"720p60"}'])assert.equal(model.screenControl(v),null);
 assert.deepEqual(model.screenControl('{"type":"screen","active":true,"quality":"1080p60"}'),{active:true,quality:'1080p60'});
});
function fixture() {
 const pcs=[],sent=[];let socketHandler,display;
 const track=kind=>({kind,enabled:true,stopped:false,events:{},addEventListener(n,cb){this.events[n]=cb;},stop(){this.stopped=true;},async applyConstraints(v){this.constraints=v;}});
 const mic=track('audio'),screen=track('video');
 const stream=t=>({getTracks:()=>[t],getAudioTracks:()=>t.kind==='audio'?[t]:[],getVideoTracks:()=>t.kind==='video'?[t]:[]});
 class PC {
  iceGatheringState='complete';signalingState='stable';events={};closed=false;offerCount=0;audio=[];
  constructor(){pcs.push(this);}
  addEventListener(n,cb){this.events[n]=cb;}
  addTransceiver(kind){assert.equal(kind,'video');this.sender={track:null,replaceTrack:async t=>{this.sender.track=t;},getParameters:()=>({encodings:[{}]}),setParameters:async p=>{this.parameters=p;}};return {sender:this.sender};}
  addTrack(t){this.audio.push(t);}
  createDataChannel(){this.control={readyState:'open',label:'screen-control',addEventListener(){},send:data=>sent.push(JSON.parse(data))};return this.control;}
  async createOffer(){this.offerCount++;return {type:'offer',sdp:'v=0\r\n'};}
  async setLocalDescription(v){this.localDescription=v;}
  close(){this.closed=true;}
 }
 const voice=loadTs(new URL('../src/communities/voice.ts',import.meta.url),{
  react:{useSyncExternalStore:(_subscribe,snapshot)=>snapshot()},
  './screenCapture':{prepareScreenCapture:async()=>{},confirmScreenCapture:async()=>{},endScreenCapture(){}},
  'react-native-webrtc':{RTCPeerConnection:PC,mediaDevices:{getUserMedia:async()=>stream(mic),getDisplayMedia:async()=>display ? await display() : stream(screen)}},
  'react-native-incall-manager':{default:{start(){},stop(){},setForceSpeakerphoneOn(){}}},
 });
 const store={sendSocket:()=>true,onSocket:cb=>{socketHandler=cb;return()=>{};}};
 return {voice,pcs,sent,mic,screen,stream,setDisplay:v=>display=v,async join(){await voice.joinVoice({callIce:async()=>({iceServers:[]})},store,{communityId:'game',communityName:'Game',channelId:'voice',channelName:'Voice'});socketHandler({type:'voice.joined',channelId:'voice',peers:[{peer:'one',userId:'u1'},{peer:'two',userId:'u2'}]});for(let i=0;i<20;i++)await Promise.resolve();}};
}
test('start/stop replaces reserved video tracks without recreating audio connections',async()=>{
 const f=fixture();await f.join();const connections=[...f.pcs];await f.voice.startVoiceScreen('1080p60');
 assert.equal(f.voice.useVoice().sharing,'1080p60');
 assert.ok(f.pcs.every(pc=>pc.sender.track===f.screen&&pc.audio[0]===f.mic&&pc.offerCount===1));
 assert.ok(f.pcs.every(pc=>pc.parameters.encodings[0].maxFramerate===60&&pc.parameters.encodings[0].maxBitrate===8_000_000));
 f.voice.stopVoiceScreen();assert.ok(f.pcs.every(pc=>pc.sender.track===null&&!pc.closed));assert.equal(f.mic.stopped,false);assert.equal(f.screen.stopped,true);assert.deepEqual(f.pcs,connections);
 assert.ok(f.sent.some(m=>m.active===true));assert.ok(f.sent.some(m=>m.active===false));f.voice.leaveVoice();
});
test('permission rejection preserves voice and never publishes a screen',async()=>{
 const f=fixture();await f.join();f.setDisplay(async()=>{throw new Error('permission denied');});await assert.rejects(f.voice.startVoiceScreen('720p60'),/permission denied/);
 assert.equal(f.voice.useVoice().sharing,null);assert.equal(f.mic.stopped,false);assert.equal(f.sent.some(m=>m.active===true),false);f.voice.leaveVoice();
});
test('a capture resolving after leaving is stopped and never attached',async()=>{
 const f=fixture();await f.join();let resolve;f.setDisplay(()=>new Promise(done=>resolve=done));const pending=f.voice.startVoiceScreen('720p60');for(let i=0;i<5;i++)await Promise.resolve();f.voice.leaveVoice();resolve(f.stream(f.screen));await pending;
 assert.equal(f.screen.stopped,true);assert.equal(f.voice.useVoice(),null);assert.ok(f.pcs.every(pc=>pc.closed&&pc.sender.track===null));
});
test('late ended event from the old capture cannot stop a new screen',async()=>{
 const f=fixture();await f.join();await f.voice.startVoiceScreen('720p60');const ended=f.screen.events.ended;f.voice.stopVoiceScreen();
 const next={...f.screen,stopped:false,events:{},stop(){this.stopped=true;}};f.setDisplay(async()=>f.stream(next));await f.voice.startVoiceScreen('1080p60');ended();
 assert.equal(f.voice.useVoice().sharing,'1080p60');assert.equal(next.stopped,false);f.voice.leaveVoice();
});
test('cancel during sender configuration stops the candidate capture immediately',async()=>{
 const f=fixture();await f.join();let finish;
 f.pcs[0].sender.setParameters=()=>new Promise(resolve=>finish=resolve);
 const pending=f.voice.startVoiceScreen('720p60');for(let i=0;i<20;i++)await Promise.resolve();assert.ok(finish);
 f.voice.stopVoiceScreen();assert.equal(f.screen.stopped,true);finish();await assert.rejects(pending,/отменён/);
 assert.equal(f.voice.useVoice().sharing,null);assert.ok(f.pcs.every(pc=>pc.sender.track===null));f.voice.leaveVoice();
});

test('leaving during capture constraints never republishes the stopped screen',async()=>{
 const f=fixture();await f.join();let finish;
 f.screen.applyConstraints=()=>new Promise(resolve=>finish=resolve);
 const pending=f.voice.startVoiceScreen('720p60');for(let i=0;i<20;i++)await Promise.resolve();assert.ok(finish);
 f.voice.leaveVoice();assert.equal(f.screen.stopped,true);finish();await pending;
 assert.equal(f.voice.useVoice(),null);assert.ok(f.pcs.every(pc=>pc.sender.track===null));assert.equal(f.sent.some(m=>m.active===true),false);
});
