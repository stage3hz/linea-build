// Public trust only. No remote config fetch and no personal room/subscription URL.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function validateTransportBConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='bootstraps,leaseKeys'||!Array.isArray(value.bootstraps)||value.bootstraps.length<1||value.bootstraps.length>4||!Array.isArray(value.leaseKeys)||value.leaseKeys.length<1||value.leaseKeys.length>8)throw Error('Invalid public transport configuration');
 for(const address of value.bootstraps){const url=new URL(address);if(url.origin!==address||url.protocol!=='https:'||url.hostname==='api.invizent.com'||!/^https:\/\/(?:[a-z0-9-]+\.)+invizent\.(?:com|ru)$/.test(address))throw Error('Untrusted bootstrap origin');}
 for(const key of value.leaseKeys)if(typeof key!=='string'||(!/^[A-Za-z0-9+/]{43}=$/.test(key)||Buffer.from(key,'base64').toString('base64')!==key))throw Error('Invalid Ed25519 verification key');
 if(new Set(value.bootstraps).size!==value.bootstraps.length||new Set(value.leaseKeys).size!==value.leaseKeys.length)throw Error('Duplicate public trust material');
 return {bootstraps:value.bootstraps,leaseKeys:value.leaseKeys};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const source=process.argv[2]?readFileSync(process.argv[2],'utf8'):process.env.TRANSPORT_B_PUBLIC_CONFIG;
 const value=validateTransportBConfig(JSON.parse(source||'null'));
 writeFileSync(new URL('../src/network/transportB/config.ts',import.meta.url),`// Generated PUBLIC trust material for the experimental owned ingress.\nexport const TRANSPORT_B_BOOTSTRAPS: readonly string[] = ${JSON.stringify(value.bootstraps)};\nexport const TRANSPORT_B_LEASE_KEYS: readonly string[] = ${JSON.stringify(value.leaseKeys)};\n`);
 console.log('Embedded public bootstrap origins and lease verification keys; no secrets.');
}
