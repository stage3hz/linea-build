import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopSignalBridge as sdk } from '../signal.mjs';
test('Windows Signal bridge exchanges pre-key and session messages; tampering is rejected',async()=>{
 let alice=await sdk.createState('alice',1),bob=await sdk.createState('bob',1);
 alice={...alice,...await sdk.trustIdentity(alice.state,'bob',1,bob.bundle.identityKey)};
 bob={...bob,...await sdk.trustIdentity(bob.state,'alice',1,alice.bundle.identityKey)};
 const {preKeys,...bundle}=bob.bundle;
 const sent=await sdk.encrypt(alice.state,'bob',1,'desktop to phone-compatible Signal', {...bundle,preKey:preKeys[0]});
 const received=await sdk.decrypt(bob.state,'alice',1,sent.type,sent.body);
 assert.equal(received.plaintext,'desktop to phone-compatible Signal');
 const reply=await sdk.encrypt(received.state,'alice',1,'reply',null);
 assert.equal((await sdk.decrypt(sent.state,'bob',1,reply.type,reply.body)).plaintext,'reply');
 const bytes=Buffer.from(reply.body,'base64');bytes[bytes.length-1]^=1;
 await assert.rejects(sdk.decrypt(sent.state,'bob',1,reply.type,bytes.toString('base64')));
});
