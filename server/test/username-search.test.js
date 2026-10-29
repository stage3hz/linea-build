import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';

test('an @ search addresses public usernames and does not expose the immutable login after a rename',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'linea-username-search-')),app=await buildApp({dataDir,authRateLimit:false});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const register=async username=>{
    const response=await app.inject({method:'POST',url:'/auth/register',payload:{username,displayName:username,password:'Solid-test-passphrase_2026!',confirmationWord:'корабль',recoveryWord:'астра'}});assert.equal(response.statusCode,201);return response.json();
  };
  const alice=await register('alice'),bob=await register('bob'),headers={authorization:`Bearer ${alice.token}`};
  const before=await app.inject({method:'GET',url:'/users?q=%40BOB',headers});assert.equal(before.statusCode,200);assert.equal(before.json().users[0]?.id,bob.user.id);
  const rename=await app.inject({method:'PATCH',url:'/me/username',headers:{authorization:`Bearer ${bob.token}`},payload:{username:'moonlight'}});assert.equal(rename.statusCode,200);
  const after=await app.inject({method:'GET',url:'/users?q=%40moonlight',headers});assert.equal(after.json().users[0]?.id,bob.user.id);
  const privateLogin=await app.inject({method:'GET',url:'/users?q=%40bob',headers});assert.deepEqual(privateLogin.json().users,[]);
  const displayName=await app.inject({method:'GET',url:'/users?q=bob',headers});assert.equal(displayName.json().users[0]?.id,bob.user.id);
});
