import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDesktopVault } from '../vault.mjs';
const storage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:bytes=>bytes.toString()};
test('encrypted vault commits atomically, survives reopen and serializes concurrent writes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'invizent-vault-'));
 try{
  const vault=await openDesktopVault(root,'account:one',storage);
  await Promise.all([vault.commit({a:'secret-identity'}),vault.commit({b:'private-message'}),vault.commit({a:null})]);
  assert.equal(await vault.get('a'),null); assert.equal(await vault.get('b'),'private-message'); await vault.close();
  const dir=path.join(root,(await readdir(root))[0]),bytes=await readFile(path.join(dir,'vault.bin'));
  assert.equal(bytes.includes(Buffer.from('private-message')),false);
  const reopened=await openDesktopVault(root,'account:one',storage);assert.equal(await reopened.get('b'),'private-message');await reopened.close();
  bytes[bytes.length-1]^=1;await writeFile(path.join(dir,'vault.bin'),bytes);
  await assert.rejects(openDesktopVault(root,'account:one',storage));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('vault fails closed when OS encryption is unavailable or a key is lost',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'invizent-vault-'));
 try{
  await assert.rejects(openDesktopVault(root,'account', {...storage,isEncryptionAvailable:()=>false}));
  await assert.rejects(openDesktopVault(root,'account', {...storage,getSelectedStorageBackend:()=> 'basic_text'}));
  const vault=await openDesktopVault(root,'account',storage);await vault.commit({key:'private'});await vault.close();
  const dir=path.join(root,(await readdir(root))[0]);await rm(path.join(dir,'key.bin'));
  const original=await readFile(path.join(dir,'vault.bin'));await assert.rejects(openDesktopVault(root,'account',storage));
  assert.deepEqual(await readFile(path.join(dir,'vault.bin')),original);
 }finally{await rm(root,{recursive:true,force:true});}
});
