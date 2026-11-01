import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const require=createRequire(new URL('../package.json',import.meta.url));
test('generated ReplayKit extension includes the display name required by iOS installation',()=>{
 const filename=fileURLToPath(new URL('../plugins/withScreenBroadcast.js',import.meta.url));
 const source=readFileSync(filename,'utf8'),module={exports:{}};let generate;
 const plugins={createRunOncePlugin:f=>f,withInfoPlist:c=>c,withEntitlementsPlist:c=>c,withAndroidManifest:c=>c,withXcodeProject:(c,f)=>{generate=f;return c;}};
 vm.runInThisContext(`(function(require,module,__dirname){${source}\n})`)(name=>name==='expo/config-plugins'?plugins:require(name),module,path.dirname(filename));
 const config=require('./app.config.js').expo,root=mkdtempSync(path.join(os.tmpdir(),'invizent-extension-'));
 try{
  module.exports(config);generate({modRequest:{platformProjectRoot:root},modResults:{pbxTargetByName:()=>({})}});
  const plist=require('@expo/plist').default,info=plist.parse(readFileSync(path.join(root,'ScreenBroadcast/Info.plist'),'utf8'));
  for(const key of ['CFBundleDisplayName','CFBundleName','CFBundleExecutable','CFBundleVersion'])assert.ok(typeof info[key]==='string'&&info[key].trim().length>0,key+' must be a non-empty string');
  assert.equal(info.CFBundleIdentifier,'$(PRODUCT_BUNDLE_IDENTIFIER)');assert.equal(info.CFBundlePackageType,'XPC!');assert.equal(info.CFBundleShortVersionString,config.version);
  assert.equal(info.NSExtension.NSExtensionPointIdentifier,'com.apple.broadcast-services-upload');
 }finally{rmSync(root,{recursive:true,force:true});}
});
