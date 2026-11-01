import { mkdirSync,copyFileSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../mobile/',import.meta.url));
const command=process.platform==='win32'?'npx.cmd':'npx';
const result=spawnSync(command,['expo','export','--platform','web','--output-dir','../desktop/dist'],{cwd:root,env:{...process.env,EXPO_NO_TELEMETRY:'1',APP_ENV:'development',CI:'1'},stdio:'inherit',shell:process.platform==='win32'});
if(result.status!==0)process.exit(result.status??1);
const dist=fileURLToPath(new URL('./dist/',import.meta.url));mkdirSync(path.join(dist,'fonts'),{recursive:true});
let css='';for(const [name,weight] of [['Regular',400],['Medium',500],['SemiBold',600],['Bold',700],['ExtraBold',800]]){const file=`Montserrat-${name}.ttf`;copyFileSync(path.join(root,'assets','fonts',file),path.join(dist,'fonts',file));css+=`@font-face{font-family:Montserrat;font-weight:${weight};src:url('/fonts/${file}') format('truetype');font-display:swap;}`;}
const html=path.join(dist,'index.html');writeFileSync(html,readFileSync(html,'utf8').replace('</head>',`<style>${css}</style></head>`));

for(const name of ['capture.html','capture-picker.js'])copyFileSync(fileURLToPath(new URL('./'+name,import.meta.url)),path.join(dist,name));
