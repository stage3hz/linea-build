#!/usr/bin/env node
// Signed list of Invizent servers. Run on a computer YOU trust (not necessarily a server).
//
//   node deploy/servers.mjs keygen KEYFILE           new signing key (keep KEYFILE secret and backed up);
//                                                    prints the PUBLIC key to put into the app
//   node deploy/servers.mjs sign KEYFILE LIST.json OUT.json
//                                                    LIST.json: {"version": 2, "servers": [{"url": "https://api.invizent.com", "region": "msk"}, ...]}
//   node deploy/servers.mjs verify OUT.json PUBLICKEY
//
// Copy OUT.json to deploy/secrets/servers.json on every server. Each new list needs a higher
// "version": the app never goes back to an older list.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TRUSTED_HOST = /^(?:[a-z0-9-]+\.)*invizent\.(?:com|ru)$|^141-133-194-51\.nip\.io$|^invizent-api\.invizent-8165e2\.workers\.dev$/;
const raw = key => (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const die = message => { console.error(message); process.exit(1); };
const [command, ...args] = process.argv.slice(2);

if (command === 'keygen') {
  const [file] = args; if (!file) die('Укажи файл для ключа');
  if (existsSync(file)) die('Файл уже существует — старый ключ не перезаписывается.');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  console.log('Ключ подписи сохранён:', file, '(держи в секрете и сделай копию)');
  console.log('Публичный ключ для приложения:', raw(publicKey));
} else if (command === 'sign') {
  const [keyFile, listFile, out] = args; if (!out) die('node deploy/servers.mjs sign KEYFILE LIST.json OUT.json');
  const list = JSON.parse(readFileSync(listFile, 'utf8'));
  if (!Number.isSafeInteger(list.version) || list.version < 1) die('Нужен "version" — целое число, больше прошлого.');
  if (!Array.isArray(list.servers) || !list.servers.length) die('Нужен непустой "servers".');
  for (const s of list.servers) {
    const u = new URL(s.url);
    if (u.protocol !== 'https:' || !TRUSTED_HOST.test(u.hostname) || u.pathname !== '/' || u.port) die(`Недопустимый адрес: ${s.url} (только https://…invizent.com или …invizent.ru)`);
  }
  const payload = JSON.stringify({ version: list.version, issuedAt: new Date().toISOString(), servers: list.servers.map(s => ({ url: new URL(s.url).origin, ...(s.region ? { region: String(s.region) } : {}) })) });
  const sig = sign(null, Buffer.from(payload), createPrivateKey(readFileSync(keyFile))).toString('base64');
  writeFileSync(out, JSON.stringify({ payload, sig }) + '\n');
  console.log(`Подписано: версия ${list.version}, серверов ${list.servers.length} → ${out}`);
} else if (command === 'verify') {
  const [file, pub] = args; if (!pub) die('node deploy/servers.mjs verify OUT.json PUBLICKEY');
  const { payload, sig } = JSON.parse(readFileSync(file, 'utf8'));
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]), format: 'der', type: 'spki' });
  console.log(verify(null, Buffer.from(payload), key, Buffer.from(sig, 'base64')) ? 'Подпись верна: ' + payload : 'ПОДПИСЬ НЕВЕРНА');
} else {
  die('Команды: keygen KEYFILE | sign KEYFILE LIST.json OUT.json | verify OUT.json PUBLICKEY');
}
