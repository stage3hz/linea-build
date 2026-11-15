import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './support/load-ts.mjs';
const {messageHandshakeExpired,messageHeartbeatStale}=loadTs(new URL('../src/network/messageHandshake.ts',import.meta.url));
test('a reachable health endpoint does not keep an opened but unauthenticated message channel alive forever',()=>{
 assert.equal(messageHandshakeExpired({ready:false,hasSocket:true,sinceStart:26000,tier:'fast'}),true);
 assert.equal(messageHandshakeExpired({ready:true,hasSocket:true,sinceStart:900000,tier:'fast'}),false);
 assert.equal(messageHandshakeExpired({ready:false,hasSocket:false,sinceStart:900000,tier:'fast'}),false);
});
test('slow links get time for device proof and do not restart every fast-link heartbeat interval',()=>{
 assert.equal(messageHandshakeExpired({ready:false,hasSocket:true,sinceStart:30000,tier:'slow'}),false);
 assert.equal(messageHandshakeExpired({ready:false,hasSocket:true,sinceStart:91000,tier:'slow'}),true);
 assert.ok(messageHeartbeatStale('slow')>messageHeartbeatStale('fast'));
});
