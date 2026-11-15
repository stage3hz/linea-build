// Real headful Chrome/CDP pipe fixture. No platform navigation or real account.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CDPBrowser, collectSession, writeSessionFile} from './browser-session.mjs';

async function main() {
  assert.notEqual(process.getuid?.(),0,'Chrome fixture must retain its sandbox under an unprivileged user');
  const chrome=process.argv[2];
  assert.ok(chrome?.startsWith('/'),'An installed official Chrome binary is required');
  const root=await mkdtemp(join(tmpdir(),'invizent-browser-proof-'));
  const profile=join(root,'profile'),outputDir=join(root,'session'),output=join(outputDir,'cookies.json');
  await mkdir(profile,{mode:0o700});await mkdir(outputDir,{mode:0o700});
  const abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),30_000);
  let browser;
  try {
    const child=spawn(chrome,[
      '--no-first-run','--no-default-browser-check','--disable-background-networking',
      '--disable-component-update','--disable-sync','--disable-features=MediaRouter',
      '--host-resolver-rules=MAP * ~NOTFOUND','--remote-debugging-pipe',
      '--user-data-dir='+profile,'about:blank',
    ],{stdio:['ignore','ignore','ignore','pipe','pipe']});
    browser=new CDPBrowser(child);
    const version=await browser.request('Browser.getVersion',{}, {timeoutMs:10_000});
    assert.match(version.product,/Chrome\//);
    const targets=await browser.request('Target.getTargets');
    assert.ok(targets.targetInfos.filter(target=>target.type==='page').every(target=>target.url==='about:blank'));
    // Set synthetic browser storage through CDP only: these are not login tokens.
    const expires=Date.now()/1000+3600;
    await browser.request('Storage.setCookies',{cookies:[
      {name:'Session_id',value:'fixture_not_a_real_login',domain:'.yandex.ru',path:'/',secure:true,httpOnly:true,expires},
      {name:'unrelated',value:'fixture_do_not_export',domain:'.example.org',path:'/',secure:true,httpOnly:true,expires},
    ]});
    await collectSession(browser,{output,signal:abort.signal,pollMs:50});
    const stored=JSON.parse(await readFile(output,'utf8'));
    assert.deepEqual(stored,[{name:'Session_id',value:'fixture_not_a_real_login'}]);
    assert.equal((await stat(output)).mode&0o777,0o600);
    assert.equal((await stat(outputDir)).mode&0o777,0o700);
    assert.throws(()=>writeSessionFile(output,[{name:'Session_id',value:'replacement'}]));
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),stored);
    console.log(JSON.stringify({proof:'headful-chrome-pipes',privateExportVerified:true,platformLoginVerified:false}));
  } finally {
    clearTimeout(deadline);abort.abort();
    if(browser)await browser.stop();
    // Chrome utility children can finish profile writes just after browser exit.
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
main().catch(error=>{console.error('Headful Chrome pipe fixture failed ('+error.name+').');process.exitCode=1;});
