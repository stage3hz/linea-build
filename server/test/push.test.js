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
