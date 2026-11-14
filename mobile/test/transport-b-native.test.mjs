import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTs } from './support/load-ts.mjs';

const source = new URL('../src/network/transportB/native.ts', import.meta.url);
function makeBridge(capabilities = { protocol: 1, nativeSession: true, appRouting: false }) {
  return { capabilities: () => capabilities, status: async () => ({sessionId:'',state:'idle'}),
    startSession: async () => {}, stopSession: async () => {}, addListener: () => ({remove(){}}) };
}
function load(bridge) {
  return loadTs(source, { 'expo-modules-core': { requireOptionalNativeModule: name => {
    assert.equal(name, 'LineaTransportB');
    return bridge;
  } } });
}

test('native session loader stays unavailable when the module is absent', () => {
  const native = load(null);
  assert.equal(native.loadTransportBSessionModule(), null);
  assert.deepEqual(native.transportBReadiness(), {nativeSession:false,appRouting:false});
});
test('disabled builds do not advertise a native session', () => {
  assert.equal(load(makeBridge({protocol:1,nativeSession:false,appRouting:false})).loadTransportBSessionModule(),null);
});
test('linked session backend is not advertised as an application route and never starts on load', () => {
  const bridge = makeBridge();
  bridge.startSession = () => { throw new Error('must not start on import'); };
  const native = load(bridge);
  assert.equal(native.loadTransportBSessionModule(),bridge);
  assert.deepEqual(native.transportBReadiness(),{nativeSession:true,appRouting:false});
});
test('incompatible ABI or incomplete native API is rejected', () => {
  for (const value of [null,{}, {protocol:2,nativeSession:true,appRouting:false},
    {protocol:1,nativeSession:true,appRouting:true}, {protocol:1,nativeSession:'yes',appRouting:false}]) {
    assert.equal(load(makeBridge(value)).loadTransportBSessionModule(),null);
  }
  for (const method of ['capabilities','status','startSession','stopSession','addListener']) {
    const bridge = makeBridge(); delete bridge[method];
    assert.equal(load(bridge).loadTransportBSessionModule(),null);
  }
});
test('native lookup or capability failures remain unavailable', () => {
  const throwing = loadTs(source, {'expo-modules-core':{requireOptionalNativeModule(){throw Error('runtime unavailable');}}});
  assert.equal(throwing.loadTransportBSessionModule(),null);
  const bridge = makeBridge(); bridge.capabilities=()=>{throw Error('bad ABI');};
  assert.equal(load(bridge).loadTransportBSessionModule(),null);
});
test('local module autolinks only on Apple with explicit compile opt-in', () => {
  const root = new URL('../modules/linea-transport-b/', import.meta.url);
  const config = JSON.parse(readFileSync(new URL('expo-module.config.json',root),'utf8'));
  assert.deepEqual(config,{platforms:['apple'],apple:{modules:['TransportBModule']}});
  const pod = readFileSync(new URL('ios/LineaTransportB.podspec',root),'utf8');
  assert.match(pod,/ENV\['INVIZENT_TRANSPORT_B'\] == '1'/);
  assert.match(pod,/raise .*Transport B enabled but missing/);
  const swift = readFileSync(new URL('ios/TransportBModule.swift',root),'utf8');
  assert.match(swift,/"appRouting": false/);
  assert.match(swift,/self\.sessionID == id/);
  assert.match(swift,/self\.generation == epoch/);
  assert.doesNotMatch(swift,/NEPacketTunnel|print\(|NSLog\(/);
});
