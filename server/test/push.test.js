import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { chatNotification, createFcm } from '../src/push.js';

test('notification carries no message content and pluralises unread', () => {
  const one = chatNotification({ chatId: 'c1', senderName: 'Аня', kind: 'message', unread: 1 });
  assert.equal(one.android.notification.title, 'Аня');
  assert.equal(one.android.notification.body, 'Новое сообщение');
  assert.equal(one.android.notification.channel_id, 'messages');
  assert.deepEqual(one.data, { chatId: 'c1', kind: 'message' });
  assert.equal(chatNotification({ chatId: 'c', senderName: 'x', kind: 'message', unread: 3 }).android.notification.body, '3 новых сообщения');
  assert.equal(chatNotification({ chatId: 'c', senderName: 'x', kind: 'message', unread: 11 }).android.notification.body, '11 новых сообщений');
  assert.equal(chatNotification({ chatId: 'c', senderName: 'x', kind: 'message', unread: 21 }).android.notification.body, '21 новое сообщение');
  const call = chatNotification({ chatId: 'c', senderName: 'x', kind: 'call', unread: 1 });
  assert.equal(call.android.notification.channel_id, 'calls');
  assert.equal(call.android.ttl, '45s');
});

test('FCM: signed JWT exchanged for a token, cached, invalid token reported as gone', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'invizent', token_uri: 'https://oauth2.googleapis.com/token' };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2')) {
      const assertion = new URLSearchParams(init.body.toString()).get('assertion');
      const [h, c, s] = assertion.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
      assert.equal(JSON.parse(Buffer.from(c, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
      return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }));
    }
    assert.equal(init.headers.authorization, 'Bearer AT');
    const body = JSON.parse(init.body);
    if (body.message.token === 'bad') return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
    return new Response('{}');
  };
  const send = createFcm(account, { fetch });
  assert.equal(await send('good', { data: {} }), 'ok');
  assert.equal(await send('bad', { data: {} }), 'gone');
  assert.equal(calls.filter(call => call.url.startsWith('https://oauth2')).length, 1);
  assert.match(calls[1].url, /projects\/invizent\/messages:send$/);
  assert.equal(createFcm(null), null);
});

test('notification also carries the iPhone (APNs) part without message content', () => {
  const one = chatNotification({ chatId: 'c1', senderName: 'Аня', kind: 'message', unread: 1 });
  assert.deepEqual(one.apns.payload.aps.alert, { title: 'Аня', body: 'Новое сообщение' });
  assert.equal(one.apns.payload.chatId, 'c1');
  assert.equal(one.apns.headers['apns-collapse-id'], 'c1');
  const call = chatNotification({ chatId: 'c', senderName: 'x', kind: 'call', unread: 1 });
  assert.ok(Number(call.apns.headers['apns-expiration']) > Date.now() / 1000);
});

test('APNs: ES256 token, topic, sandbox fallback remembered, gone tokens reported', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { createApns, createPush } = await import('../src/push.js');
  const credentials = { keyId: 'ABCDE12345', teamId: 'TEAM123456', bundleId: 'com.linea.messenger.preview', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const requests = [];
  const connect = host => {
    const handlers = {};
    return {
      on() {}, close() {},
      request(headers) {
        const stream = { on(event, fn) { handlers[event] = fn; return stream; }, setEncoding() {}, setTimeout() {}, close() {},
          end(body) {
            requests.push({ host, headers, body: JSON.parse(body) });
            const token = headers[':path'].split('/').pop();
            const reply = token === 'dead' ? [410, '{"reason":"Unregistered"}'] : token === 'dev' && host.includes('api.push') ? [400, '{"reason":"BadDeviceToken"}'] : [200, ''];
            queueMicrotask(() => { handlers.response({ ':status': reply[0] }); if (reply[1]) handlers.data(reply[1]); handlers.end(); });
          } };
        return stream;
      },
    };
  };
  const send = createApns(credentials, { connect });
  const message = chatNotification({ chatId: 'c1', senderName: 'Аня', kind: 'message', unread: 1 });
  assert.equal(await send('good', message), 'ok');
  const first = requests[0];
  assert.equal(first.host, 'https://api.push.apple.com');
  assert.equal(first.headers['apns-topic'], 'com.linea.messenger.preview');
  assert.equal(first.body.aps.alert.body, 'Новое сообщение');
  const [h, c, s] = first.headers.authorization.slice(7).split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).kid, 'ABCDE12345');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, 'TEAM123456');
  assert.ok(createVerify('SHA256').update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(await send('dev', message), 'ok');
  assert.equal(requests.at(-1).host, 'https://api.sandbox.push.apple.com');
  requests.length = 0;
  assert.equal(await send('dev', message), 'ok');
  assert.equal(requests.length, 1, 'a sandbox token goes straight to the sandbox next time');
  assert.equal(await send('dead', message), 'gone');
  assert.equal(createApns(null), null);
  const routed = createPush({ ios: send });
  assert.deepEqual(routed.platforms, { android: false, ios: true });
  assert.equal(await routed('good', message, 'ios'), 'ok');
  assert.equal(await routed('good', message, 'android'), 'error');
  assert.equal(createPush({}), null);
});

test('old push table that allowed only Android is migrated and keeps its tokens', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migratePushTokens, PUSH_SCHEMA } = await import('../src/push.js');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u');");
  db.exec(PUSH_SCHEMA.replace("'android','ios'", "'android'"));
  db.prepare("INSERT INTO push_tokens VALUES('t','u','h','android',1)").run();
  migratePushTokens(db); db.exec(PUSH_SCHEMA);
  db.prepare("INSERT INTO push_tokens VALUES('i','u','h','ios',1)").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n, 2);
  migratePushTokens(db);
});
