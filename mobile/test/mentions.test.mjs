import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { linkTokens } = loadTs(new URL('../src/format/markdown.ts', import.meta.url), {});
const kinds = text => linkTokens(text).map(token => token.kind === 'text' ? token.text : `[${token.kind}:${token.kind === 'mention' ? token.username : token.href}]`).join('');

// Telegram: @name in a message is a link to that person.
test('@name standing on its own is a mention', () => {
  assert.equal(kinds('@valya'), '[mention:valya]');
  assert.equal(kinds('Так тут ей пиши @Valya, она ответит'), 'Так тут ей пиши [mention:valya], она ответит');
  assert.equal(kinds('(@stage_3hz)'), '([mention:stage_3hz])');
  assert.equal(kinds('@one и @two'), '[mention:one] и [mention:two]');
  assert.equal(kinds('строка\n@name'), 'строка\n[mention:name]');
});

test('an e-mail, an address, a too short or too long name are not mentions', () => {
  assert.equal(kinds('пиши на ivan@mail.ru'), 'пиши на ivan@mail.ru');
  assert.equal(kinds('@ab'), '@ab', 'a name has at least three characters');
  assert.equal(kinds('@' + 'a'.repeat(25)), '@' + 'a'.repeat(25), 'and at most twenty-four');
  assert.equal(kinds('@@name'), '@@name');
  assert.equal(kinds('@имя'), '@имя', 'names are Latin');
  assert.equal(kinds('https://t.me/@name'), '[url:https://t.me/@name]', 'inside an address it is the address');
  assert.equal(kinds('см. https://a.example/x и @name'), 'см. [url:https://a.example/x] и [mention:name]');
  assert.equal(kinds('www.site.ru'), '[url:https://www.site.ru]');
  assert.equal(kinds('обычный текст'), 'обычный текст');
  assert.deepEqual(linkTokens(''), []);
});

test('the text is cut without losing or doubling a character', () => {
  for (const text of ['@a_b_c!', 'x @name y https://e.example/p?q=1 z', 'почта a@b.co и @realname.', '@name@name2', 'a/@name']) {
    assert.equal(linkTokens(text).map(token => token.text).join(''), text);
  }
});

test('a tap opens the profile of exactly that person — not the chat, so nothing is marked as read', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.ok(read('../src/linkify.tsx').includes("onPress={() => navigate({ to: 'mention', username })}"));
  const app = read('../App.tsx');
  assert.ok(app.includes("const found=users.find(user=>user.username?.toLowerCase()===name);"), 'an exact match only, never the first similar name');
  assert.ok(app.includes("if(name===session?.user.username?.toLowerCase())return;"), 'your own name opens nothing');
  const handler = app.slice(app.indexOf("if(request.to==='mention')"), app.indexOf("if(request.to==='chat')"));
  assert.ok(handler.includes('setMentioned(found);') && !handler.includes('createChat') && !handler.includes('selectChat'), 'the tap itself opens no chat');
  assert.ok(app.includes('<UserProfile api={api} user={mentioned} onClose={()=>setMentioned(null)}'), '«Написать» in the profile is the way to the chat');
});
