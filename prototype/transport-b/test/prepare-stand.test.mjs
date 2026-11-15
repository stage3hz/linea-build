import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script=fileURLToPath(new URL('../prepare-stand.mjs',import.meta.url));
function prepare(root,extra=[]){
  return spawnSync(process.execPath,[script,root,'https://stand.invizent.com','/opt/creator','/run/secrets/platform-cookies.json',...extra],{encoding:'utf8',timeout:10_000});
}

test('stand preparation binds a private config to default WB or selected Telemost',()=>{
  const parent=mkdtempSync(join(tmpdir(),'transport-b-prepare-'));
  try{
    for(const [label,extra,provider] of [['legacy',[],'wbstream'],['telemost',['telemost'],'telemost'],['wbstream',['wbstream'],'wbstream']]){
      const root=join(parent,label),result=prepare(root,extra);
      assert.equal(result.status,0,result.stderr);
      assert.equal(result.stdout.includes('Nothing deployed.'),true);
      assert.equal(result.stdout.includes(root),false);
      const config=JSON.parse(readFileSync(join(root,'bootstrap.json'),'utf8'));
      assert.equal(config.provider,provider);
      assert.equal(config.cookiesFile,'/run/secrets/platform-cookies.json');
      for(const path of [root,config.privateKeyFile,join(root,'bootstrap.json'),join(root,'Caddyfile')])
        assert.equal(statSync(path).mode&0o077,0,'secret/config paths are private');
      const trust=JSON.parse(readFileSync(join(root,'public-config.json'),'utf8'));
      assert.deepEqual(Object.keys(trust).sort(),['bootstraps','leaseKeys']);
      assert.equal(trust.leaseKeys.length,1);
      assert.equal(readFileSync(join(root,'public-config.json'),'utf8').includes('PRIVATE KEY'),false);
      const original=readFileSync(join(root,'bootstrap.json'),'utf8');
      const again=prepare(root,provider==='telemost'?['wbstream']:['telemost']);
      assert.equal(again.status,1,'existing config is not overwritten');
      assert.equal(readFileSync(join(root,'bootstrap.json'),'utf8'),original);
    }
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test('invalid provider or CLI arguments fail before creating stand credentials',()=>{
  const parent=mkdtempSync(join(tmpdir(),'transport-b-prepare-invalid-'));
  try{
    for(const extra of [['vk'],[''],['telemost\n'],['__proto__'],['telemost','extra']]){
      const root=join(parent,'stand'),result=prepare(root,extra);
      assert.equal(result.status,1);
      assert.equal(existsSync(root),false,'invalid provider does not create signing keys or directories');
      assert.equal(result.stdout,'');
      assert.equal(result.stderr.includes('/run/secrets/'),false);
    }
    assert.deepEqual(readdirSync(parent),[]);
  }finally{rmSync(parent,{recursive:true,force:true});}
});
