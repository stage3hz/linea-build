import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {validateTransportBConfig} from '../scripts/inject-transport-b.mjs';
test('embedded public bootstrap configuration accepts owned origins and canonical verification keys',()=>{
 const value={bootstraps:['https://reserve-test.invizent.com'],leaseKeys:[randomBytes(32).toString('base64')]};assert.deepEqual(validateTransportBConfig(value),value);
 for(const bootstraps of [['https://api.invizent.com'],['http://reserve-test.invizent.com'],['https://example.com'],['https://reserve-test.invizent.com/path']])assert.throws(()=>validateTransportBConfig({...value,bootstraps}));
 for(const leaseKeys of [[],['invalid'],[value.leaseKeys[0],value.leaseKeys[0]]])assert.throws(()=>validateTransportBConfig({...value,leaseKeys}));
 assert.throws(()=>validateTransportBConfig({...value,token:'must-not-be-embedded'}));
});
