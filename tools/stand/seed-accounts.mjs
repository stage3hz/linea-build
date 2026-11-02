import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:3001';
const words = ['ласточка', 'гранит'];
const mk = async (username, displayName, i) => {
  const password = 'тест-' + randomBytes(12).toString('hex');
  const body = { username, password, displayName, confirmationWord: words[0] + 'а'.repeat(i), recoveryWord: words[1] + 'о'.repeat(i), deviceName: 'preview' };
  const r = await fetch(base + '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(username + ': ' + JSON.stringify(j));
  return { username, password, confirmationWord: body.confirmationWord, token: j.token, id: j.user.id };
};
const a = await mk('tester', 'Тестер', 1), b = await mk('friend', 'Друг', 2);
const chat = await fetch(base + '/chats', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.token }, body: JSON.stringify({ peerId: b.id }) });
console.log('chat', chat.status);
writeFileSync((process.env.STAND || '/tmp/invizent-stand') + '/test-accounts.json', JSON.stringify({ a, b }), { mode: 0o600 });
console.log('registered', a.username, a.id, b.username);
