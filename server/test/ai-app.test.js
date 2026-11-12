import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';

test('the actual application protects and wires the free-only AI route without a live provider',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'linea-ai-app-'));let forwarded=0;
  const app=await buildApp({dataDir,authRateLimit:false,aiApiKey:'synthetic-unit-test-key',aiFetch:async(url,options)=>{
    forwarded++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    const body=JSON.parse(options.body);assert.equal(body.model,'openrouter/free');assert.equal(body.provider.max_price.completion,0);
    return new Response(JSON.stringify({model:'test/free-model',usage:{cost:0},choices:[{finish_reason:'stop',message:{role:'assistant',content:'Synthetic test answer'}}]}),{headers:{'Content-Type':'application/json'}});
  }});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  assert.equal((await app.inject({method:'GET',url:'/ai/status'})).statusCode,401);
  const registration=await app.inject({method:'POST',url:'/auth/register',payload:{username:'ai_member',displayName:'AI test',password:'Solid-test-passphrase_2026!',confirmationWord:'корабль',recoveryWord:'астра'}});
  assert.equal(registration.statusCode,201);const headers={authorization:`Bearer ${registration.json().token}`};
  const status=await app.inject({method:'GET',url:'/ai/status',headers});assert.equal(status.statusCode,200);assert.equal(status.json().configured,true);assert.equal(status.json().capabilities.video.enabled,false);
  const messages=[{role:'user',content:'test request'}];
  assert.equal((await app.inject({method:'POST',url:'/ai/chat',headers,payload:{messages,consent:false}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/ai/chat',headers,payload:{messages,consent:true,model:'paid/model'}})).statusCode,400);
  assert.equal(forwarded,0);
  const answer=await app.inject({method:'POST',url:'/ai/chat',headers,payload:{messages,consent:true}});assert.equal(answer.statusCode,200);assert.equal(answer.json().text,'Synthetic test answer');assert.equal(forwarded,1);
  await app.inject({method:'POST',url:'/auth/logout',headers});assert.equal((await app.inject({method:'POST',url:'/ai/chat',headers,payload:{messages,consent:true}})).statusCode,401);assert.equal(forwarded,1);
});

test('a large body from a caller without a session is refused before it is parsed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-anon-body-'));
  const app = await buildApp({ dataDir, authRateLimit: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const body = '{"messages":[' + '[],'.repeat(1_000_000) + '[]]}'; // ~4 MB of JSON that is costly to parse
  const started = Date.now();
  const anonymous = await app.inject({ method: 'POST', url: '/ai/chat', headers: { 'content-type': 'application/json' }, payload: body });
  assert.equal(anonymous.statusCode, 401);
  assert.ok(Date.now() - started < 60, `refused in ${Date.now() - started} ms: the body must not have been parsed`);
  const forged = await app.inject({ method: 'POST', url: '/ai/document', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'A'.repeat(43) }, payload: body });
  assert.equal(forged.statusCode, 401, 'a token that names no session does not open the gate');
  // Small anonymous requests (sign-in, registration) are untouched.
  const registration = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'anon_gate', displayName: 'Gate', password: 'Solid-test-passphrase_2026!', confirmationWord: 'корабль', recoveryWord: 'астра' } });
  assert.equal(registration.statusCode, 201);
});
