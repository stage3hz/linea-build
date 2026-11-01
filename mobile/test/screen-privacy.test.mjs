import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const require=createRequire(new URL('../package.json',import.meta.url));
const source=readFileSync(new URL('../.linea-ios-cloud-setup/withLocalPrivacy.cjs',import.meta.url),'utf8');
function fixture(){
 const module={exports:{}};let finalized;
 const localRequire=name=>name==='expo/config-plugins'?{withFinalizedMod:(config,[,mod])=>{finalized=mod;return config;}}:require(name);
 vm.runInThisContext(`(function(require,module){${source}\n})`)(localRequire,module);
 const config=structuredClone(require('./app.config.js').expo),group=`group.${config.ios.bundleIdentifier}.screen`;
 config.ios.entitlements={'com.apple.security.application-groups':[group]};
 return {config,group,guard:module.exports,finalized:()=>finalized};
}
test('privacy guard templates agree and allow only the configured ReplayKit group',()=>{
 assert.equal(readFileSync(new URL('../../tools/ios-cloud-setup/withLocalPrivacy.cjs',import.meta.url),'utf8'),source);
 const f=fixture();assert.doesNotThrow(()=>f.guard(f.config));
 for(const groups of [[f.group,'group.other'],['group.other'],[],f.group]){
  const c=structuredClone(f.config);c.ios.entitlements={'com.apple.security.application-groups':groups};assert.throws(()=>f.guard(c),/Only the configured ReplayKit/);
 }
 const disabled=structuredClone(f.config);disabled.plugins=disabled.plugins.filter(p=>(Array.isArray(p)?p[0]:p)!=='./plugins/withScreenBroadcast');assert.throws(()=>f.guard(disabled),/Only the configured ReplayKit/);
 const keychain=structuredClone(f.config);keychain.ios.entitlements['keychain-access-groups']=['shared'];assert.throws(()=>f.guard(keychain),/Shared keychain/);
});
test('generated extension entitlements are audited independently of the main app',async()=>{
 const f=fixture(),root=await mkdtemp(path.join(os.tmpdir(),'invizent-screen-privacy-'));
 try{
  await writeFile(path.join(root,'Podfile.properties.json'),JSON.stringify({'ios.useFrameworks':'static'}));
  await writeFile(path.join(root,'Podfile'),"use_frameworks!\npod 'LibSignalClient'\n");
  const plist=require('@expo/plist').default;
  await writeFile(path.join(root,'Info.plist'),plist.build({}));
  await writeFile(path.join(root,'ScreenBroadcast.entitlements'),plist.build({'com.apple.security.application-groups':[f.group]}));
  f.guard(f.config);const run=()=>f.finalized()({modRequest:{platformProjectRoot:root}});await run();
  await writeFile(path.join(root,'ScreenBroadcast.entitlements'),plist.build({'com.apple.security.application-groups':[f.group],'keychain-access-groups':['shared']}));
  await assert.rejects(run(),/Shared keychain/);
 }finally{await rm(root,{recursive:true,force:true});}
});
