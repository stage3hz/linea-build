// Preparation only: creates trust material/config; never deploys or logs secrets.
import {generateKeyPairSync,createPrivateKey,createPublicKey} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
const [root,bootstrap,creatorBinary,cookiesFile]=process.argv.slice(2);
try{
 const url=new URL(bootstrap);
 if(!root||!isAbsolute(root)||!isAbsolute(creatorBinary)||!isAbsolute(cookiesFile)||url.protocol!=='https:'||url.origin!==bootstrap||!/^https:\/\/(?:[a-z0-9-]+\.)+invizent\.(?:com|ru)$/.test(bootstrap)||url.hostname==='api.invizent.com')throw Error('Invalid preparation input');
 mkdirSync(root,{recursive:true,mode:0o700});if(statSync(root).mode&0o077)throw Error('Stand directory must be private');
 const keyFile=join(root,'lease-ed25519.pem');
 if(!existsSync(keyFile)){const pair=generateKeyPairSync('ed25519');writeFileSync(keyFile,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});}
 if(statSync(keyFile).mode&0o077)throw Error('Signing key must be private');
 const key=createPrivateKey(readFileSync(keyFile));if(key.asymmetricKeyType!=='ed25519')throw Error('Invalid signing key');
 const publicKey=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64');
 writeFileSync(join(root,'bootstrap.json'),JSON.stringify({privateKeyFile:keyFile,creatorBinary,cookiesFile,sequenceDatabase:join(root,'sequence.sqlite'),port:9047},null,2)+'\n',{mode:0o600,flag:'wx'});
 writeFileSync(join(root,'public-config.json'),JSON.stringify({bootstraps:[bootstrap],leaseKeys:[publicKey]},null,2)+'\n',{mode:0o644,flag:'wx'});
 writeFileSync(join(root,'Caddyfile'),`${url.hostname} {\n  request_body {\n    max_size 16KB\n  }\n  reverse_proxy 127.0.0.1:9047\n}\n`,{mode:0o600,flag:'wx'});
 console.log('Prepared private bootstrap configuration, public app trust material and owned TLS ingress configuration. Nothing deployed.');
}catch{console.error('Stand preparation failed. Supply absolute private paths and a dedicated owned HTTPS origin; existing configuration is never overwritten.');process.exitCode=1;}
