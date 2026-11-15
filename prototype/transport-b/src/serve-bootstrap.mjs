// Run only on the separately authorized test stand, behind owned HTTPS ingress.
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {CreatorPool} from './creator-pool.mjs';
import {openSequenceStore} from './sequence-store.mjs';
import {makeLeaseIssuer} from './lease-issuer.mjs';
import {makeBootstrapHandler} from './bootstrap-handler.mjs';
import {createInvizentEgress} from './egress.mjs';
async function main(){
 const filename=process.argv[2];if(!filename||!isAbsolute(filename))throw Error('Absolute config filename required');
 const config=JSON.parse(readFileSync(filename,'utf8'));
 for(const name of ['privateKeyFile','cookiesFile','creatorBinary','sequenceDatabase'])if(typeof config[name]!=='string'||!isAbsolute(config[name]))throw Error('Absolute filenames required');
 for(const name of ['privateKeyFile','cookiesFile'])if(!statSync(config[name]).isFile()||(statSync(config[name]).mode&0o077)!==0)throw Error('Secret files must be private');
 const port=config.port??9047;if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid port');
 const sequences=openSequenceStore(config.sequenceDatabase);
 const issuer=makeLeaseIssuer({privateKey:readFileSync(config.privateKeyFile,'utf8'),nextSequence:sequences.nextSequence});
 const egress=createInvizentEgress(),egressSocks=await egress.listen();
 const pool=new CreatorPool({binary:config.creatorBinary,cookiesFile:config.cookiesFile,egressSocks,maxSessions:2,leaseMs:600000});
 const handler=makeBootstrapHandler({pool,issuer});
 const server=createServer((req,res)=>{void handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503,{'cache-control':'no-store'});res.end();});});
 server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=5000;server.maxConnections=128;
 let closing=false;const close=async()=>{if(closing)return;closing=true;pool.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await egress.close();sequences.close();};
 process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(error){await close();throw error;}
 console.log('Experimental bootstrap listening on loopback. No room links or credentials are logged.');
}
main().catch(()=>{console.error('Experimental bootstrap could not start. Check private test-stand configuration.');process.exitCode=1;});
