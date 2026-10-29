import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './support/load-ts.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const subject=()=>loadTs(new URL('../src/media/ViewSession.ts',import.meta.url));
test('closing aborts an in-flight download and releases a late decrypted file',async()=>{
  const {ViewSession}=subject(),pending=deferred(),states=[];let signal,disposed=0;
  const session=new ViewSession(state=>states.push(state));
  const work=session.open(input=>{signal=input;return pending.promise;});session.close();
  assert.equal(signal.aborted,true);pending.resolve({uri:'late',dispose:async()=>{disposed++;}});await work;
  assert.equal(disposed,1);assert.equal(states.at(-1).phase,'closed');assert.equal(states.some(x=>x.phase==='ready'),false);
});
test('a newer attachment wins and closing releases its file exactly once',async()=>{
  const {ViewSession}=subject(),first=deferred(),states=[];let releases=0;
  const session=new ViewSession(state=>states.push(state));const old=session.open(()=>first.promise);
  await session.open(async()=>({uri:'new',dispose:async()=>{releases++;}}));
  first.resolve({uri:'old',dispose:async()=>{releases++;}});await old;assert.equal(states.at(-1).uri,'new');
  session.close();session.close();await Promise.resolve();assert.equal(releases,2);
});
test('failed decryption produces an error without a usable file and can be retried',async()=>{
  const {ViewSession}=subject(),states=[],session=new ViewSession(state=>states.push(state));
  await session.open(async()=>{throw new Error('Проверка вложения не пройдена.');});assert.equal(states.at(-1).phase,'error');
  await session.open(async()=>({uri:'retry',dispose:async()=>{}}));assert.equal(states.at(-1).phase,'ready');session.close();
});
