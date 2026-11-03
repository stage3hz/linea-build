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
 const pcs=[],sent=[],streams=[];let socketHandler,display;
 const track=kind=>({kind,enabled:true,stopped:false,events:{},addEventListener(n,cb){this.events[n]=cb;},stop(){this.stopped=true;},async applyConstraints(v){this.constraints=v;}});
 const mic=track('audio'),screen=track('video');
 const stream=t=>{const value={releases:0,release(tracks=true){this.releases++;this.releaseTracks=tracks;},getTracks:()=>[t],getAudioTracks:()=>t.kind==='audio'?[t]:[],getVideoTracks:()=>t.kind==='video'?[t]:[]};streams.push(value);return value;};
 class PC {
  iceGatheringState='complete';signalingState='stable';events={};closed=false;offerCount=0;audio=[];
  constructor(){pcs.push(this);}
  addEventListener(n,cb){this.events[n]=cb;}
  addTransceiver(kind){if(kind==='audio'){this.soundSender={track:null,replaceTrack:async t=>{this.soundSender.track=t;},getParameters:()=>({encodings:[{}]}),setParameters:async p=>{this.soundParameters=p;}};return {sender:this.soundSender};}assert.equal(kind,'video');this.sender={track:null,replaceTrack:async t=>{this.sender.track=t;},getParameters:()=>({encodings:[{}]}),setParameters:async p=>{this.parameters=p;}};return {sender:this.sender};}
  addTrack(t){this.audio.push(t);}
  createDataChannel(){this.control={readyState:'open',label:'screen-control',addEventListener(){},send:data=>sent.push(JSON.parse(data))};return this.control;}
  async createOffer(){this.offerCount++;return {type:'offer',sdp:'v=0\r\n'};}
  async setLocalDescription(v){this.localDescription=v;}
  close(){this.closed=true;}
 }
 const voice=loadTs(new URL('../src/communities/voice.ts',import.meta.url),{
  'react-native':{Platform:{OS:globalThis.__voiceOS||'ios'}},
  react:{useSyncExternalStore:(_subscribe,snapshot)=>snapshot()},
  './screenCapture':{prepareScreenCapture:async()=>{},confirmScreenCapture:async()=>{},endScreenCapture(){}},
  'react-native-webrtc':{RTCPeerConnection:PC,MediaStream:class{constructor(tracks){return stream(tracks[0]);}},mediaDevices:{getUserMedia:async()=>stream(mic),getDisplayMedia:async()=>display ? await display() : stream(screen)}},
  'react-native-incall-manager':{default:{start(){},stop(){},setForceSpeakerphoneOn(){}}},
 });
 const store={sendSocket:()=>true,onSocket:cb=>{socketHandler=cb;return()=>{};}};
 return {voice,pcs,sent,mic,screen,stream,streams,receive:data=>socketHandler(data),setDisplay:v=>display=v,async join(){await voice.joinVoice({callIce:async()=>({iceServers:[]})},store,{communityId:'game',communityName:'Game',channelId:'voice',channelName:'Voice'});socketHandler({type:'voice.joined',channelId:'voice',peers:[{peer:'one',userId:'u1'},{peer:'two',userId:'u2'}]});for(let i=0;i<20;i++)await Promise.resolve();}};
}
test('start/stop replaces reserved video tracks without recreating audio connections',async()=>{
 const f=fixture();await f.join();const connections=[...f.pcs];await f.voice.startVoiceScreen('1080p60');
 assert.equal(f.voice.useVoice().sharing,'1080p60');
 assert.ok(f.pcs.every(pc=>pc.sender.track===f.screen&&pc.audio[0]===f.mic&&pc.offerCount===1));
 assert.ok(f.pcs.every(pc=>pc.parameters.encodings[0].maxFramerate===60&&pc.parameters.encodings[0].maxBitrate===8_000_000));
 f.voice.stopVoiceScreen();assert.ok(f.pcs.every(pc=>pc.sender.track===null&&!pc.closed));assert.equal(f.mic.stopped,false);assert.equal(f.screen.stopped,true);assert.deepEqual(f.pcs,connections);
 assert.ok(f.sent.some(m=>m.active===true));assert.ok(f.sent.some(m=>m.active===false));assert.equal(f.streams[1].releases,1);f.voice.leaveVoice();assert.ok(f.streams.every(s=>s.releases===1));
});
test('permission rejection preserves voice and never publishes a screen',async()=>{
 const f=fixture();await f.join();f.setDisplay(async()=>{throw new Error('permission denied');});await assert.rejects(f.voice.startVoiceScreen('720p60'),/permission denied/);
 assert.equal(f.voice.useVoice().sharing,null);assert.equal(f.mic.stopped,false);assert.equal(f.sent.some(m=>m.active===true),false);f.voice.leaveVoice();
});
test('a capture resolving after leaving is stopped and never attached',async()=>{
 const f=fixture();await f.join();let resolve;f.setDisplay(()=>new Promise(done=>resolve=done));const pending=f.voice.startVoiceScreen('720p60');for(let i=0;i<5;i++)await Promise.resolve();f.voice.leaveVoice();resolve(f.stream(f.screen));await pending;
 assert.equal(f.screen.stopped,true);assert.equal(f.voice.useVoice(),null);assert.ok(f.pcs.every(pc=>pc.closed&&pc.sender.track===null));assert.ok(f.streams.every(s=>s.releases===1));
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

test('remote stream wrappers are released on peer exit and room exit without owning the tracks',async()=>{
 const f=fixture();await f.join();const tracks=[{kind:'video'},{kind:'video'}];
 f.pcs.forEach((pc,i)=>pc.events.track({track:tracks[i]}));const remote=f.streams.slice(-2);
 f.receive({type:'voice.left',peer:'one'});assert.equal(remote[0].releases,1);assert.equal(remote[0].releaseTracks,false);assert.equal(remote[1].releases,0);
 f.voice.leaveVoice();assert.equal(remote[1].releases,1);assert.equal(remote[1].releaseTracks,false);
});

test('PC share sends the sound of the whole computer in its own slot, without echo of Инвиз, and stops it', async () => {
 globalThis.__voiceOS = 'web';
 try {
  const f = fixture(); let asked;
  const sound = { kind: 'audio', enabled: true, stopped: false, addEventListener() {}, stop() { this.stopped = true; } };
  f.setDisplay(async () => ({ releases: 0, release() { this.releases++; }, getTracks: () => [f.screen, sound], getAudioTracks: () => [sound], getVideoTracks: () => [f.screen] }));
  const real = f.voice; await f.join();
  // capture the constraints the app asked for
  const original = f.pcs; await f.voice.startVoiceScreen('720p60');
  assert.ok(f.pcs.every(pc => pc.soundSender.track === sound && pc.audio[0] === f.mic), 'PC sound in the reserved slot, microphone untouched');
  assert.ok(f.pcs.every(pc => pc.soundParameters.encodings[0].maxBitrate === 128000));
  assert.equal(f.voice.useVoice().sharingAudio, true);
  f.voice.stopVoiceScreen();
  assert.ok(f.pcs.every(pc => pc.soundSender.track === null));
  assert.equal(f.voice.useVoice().sharingAudio, false);
  f.voice.leaveVoice();
 } finally { delete globalThis.__voiceOS; }
});

test('PC sound slot is negotiated in stereo; the microphone stays mono', () => {
 const sdp = ['v=0','m=video 9 UDP/TLS/RTP/SAVPF 96','a=rtpmap:96 VP8/90000','m=audio 9 UDP/TLS/RTP/SAVPF 111','a=rtpmap:111 opus/48000/2','a=fmtp:111 minptime=10;useinbandfec=1','m=audio 9 UDP/TLS/RTP/SAVPF 111','a=rtpmap:111 opus/48000/2','a=fmtp:111 minptime=10;useinbandfec=1','m=application 9 UDP/DTLS/SCTP webrtc-datachannel',''].join('\r\n');
 const out = model.stereoScreenAudio(sdp);
 const [, mic, pc] = out.split('m=audio');
 assert.doesNotMatch(mic, /stereo/);
 assert.match(pc, /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000/);
 assert.equal(model.stereoScreenAudio(out), out);
 assert.equal(model.stereoScreenAudio('v=0\r\nm=audio 9 RTP 111\r\na=rtpmap:111 opus/48000/2\r\n'), 'v=0\r\nm=audio 9 RTP 111\r\na=rtpmap:111 opus/48000/2\r\n', 'one audio section: untouched');
});
