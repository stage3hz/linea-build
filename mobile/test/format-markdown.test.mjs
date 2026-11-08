import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { parseMarkdown, toMarkdown, toBlocks, endsInBlock } = loadTs(new URL('../src/format/index.ts', import.meta.url), {});

test('markdown shortcuts become entities and the markers disappear', () => {
  const result = parseMarkdown('**жирный** __курсив__ ~~зачёркнутый~~ `моно` ||спойлер||');
  assert.equal(result.text, 'жирный курсив зачёркнутый моно спойлер');
  assert.deepEqual(result.entities, [
    { type: 'bold', offset: 0, length: 6 },
    { type: 'italic', offset: 7, length: 6 },
    { type: 'strikethrough', offset: 14, length: 11 },
    { type: 'code', offset: 26, length: 4 },
    { type: 'spoiler', offset: 31, length: 7 },
  ]);
});

test('a code block keeps its content as typed and may name a language', () => {
  const result = parseMarkdown('см.\n```js\nconst a = **1**;\n```\nготово');
  assert.equal(result.text, 'см.\nconst a = **1**;\nготово');
  assert.deepEqual(result.entities, [{ type: 'pre', offset: 4, length: 16, language: 'js' }]);
  const plain = parseMarkdown('```\nx\n```');
  assert.equal(plain.text, 'x');
  assert.deepEqual(plain.entities, [{ type: 'pre', offset: 0, length: 1 }]);
});

test('unmatched or empty markers and markers inside words are left alone', () => {
  assert.equal(parseMarkdown('2**3 = 8').text, '2**3 = 8');
  assert.equal(parseMarkdown('snake__case__name').text, 'snake__case__name');
  assert.equal(parseMarkdown('**** and ** space **').text, '**** and ** space **');
  assert.equal(parseMarkdown('unclosed **bold').text, 'unclosed **bold');
  assert.equal(parseMarkdown('`a\nb`').text, '`a\nb`');
});

test('toolbar entities move along when markers are removed, and code regions are not parsed', () => {
  // "**a** bold" with an underline over "bold" (offsets 6..10 in the raw text)
  const result = parseMarkdown('**a** bold', [{ type: 'underline', offset: 6, length: 4 }]);
  assert.equal(result.text, 'a bold');
  assert.deepEqual(result.entities, [{ type: 'bold', offset: 0, length: 1 }, { type: 'underline', offset: 2, length: 4 }]);
  const code = parseMarkdown('**x**', [{ type: 'code', offset: 0, length: 5 }]);
  assert.equal(code.text, '**x**');
  assert.deepEqual(code.entities, [{ type: 'code', offset: 0, length: 5 }]);
});

test('emoji before a marker keeps UTF-16 offsets right', () => {
  const result = parseMarkdown('🎉 **ура** 🎉');
  assert.equal(result.text, '🎉 ура 🎉');
  assert.deepEqual(result.entities, [{ type: 'bold', offset: 3, length: 3 }]);
  assert.equal(result.text.slice(3, 6), 'ура');
});

test('toMarkdown round-trips simple formatting', () => {
  const source = '**a** и `b`\n```\nc\n```';
  const parsed = parseMarkdown(source);
  assert.equal(toMarkdown(parsed.text, parsed.entities), source);
});

test('render model: blocks of spans, quote with an accent bar, code block, inline mix', () => {
  const text = 'Заголовок\nцитата строка\nхвост жирный и ссылка';
  const entities = [
    { type: 'quote', offset: 10, length: 13 },
    { type: 'bold', offset: 30, length: 6 },
    { type: 'italic', offset: 32, length: 2 },
    { type: 'text_link', offset: 39, length: 6, url: 'https://example.org' },
  ];
  const blocks = toBlocks(text, entities);
  assert.deepEqual(blocks, [
    { kind: 'text', spans: [{ text: 'Заголовок' }] },
    { kind: 'quote', spans: [{ text: 'цитата строка' }] },
    { kind: 'text', spans: [{ text: 'хвост ' }, { text: 'жи', bold: true }, { text: 'рн', bold: true, italic: true }, { text: 'ый', bold: true }, { text: ' и ' }, { text: 'ссылка', url: 'https://example.org' }] },
  ]);
  assert.equal(endsInBlock(text, entities), false);
  const pre = toBlocks('a\ncode\n', [{ type: 'pre', offset: 2, length: 4, language: 'sh' }]);
  assert.deepEqual(pre, [{ kind: 'text', spans: [{ text: 'a' }] }, { kind: 'pre', spans: [{ text: 'code', code: true }], language: 'sh' }]);
  assert.equal(endsInBlock('a\ncode\n', [{ type: 'pre', offset: 2, length: 4 }]), true);
  assert.deepEqual(toBlocks('plain'), [{ kind: 'text', spans: [{ text: 'plain' }] }]);
  assert.deepEqual(toBlocks('plain', [{ type: 'bold', offset: 99, length: 2 }]), [{ kind: 'text', spans: [{ text: 'plain' }] }]);
});

test('messageMeta: entities travel inside the payload and edits keep them', async () => {
  const meta = loadTs(new URL('../src/messageMeta.ts', import.meta.url), { './voice/voice.ts': { attachmentLabel: () => 'Вложение' } });
  assert.ok(meta.validMeta({ entities: [{ type: 'bold', offset: 0, length: 2 }] }));
  assert.ok(!meta.validMeta({ entities: [] }));
  assert.ok(!meta.validMeta({ entities: [{ type: 'bold', offset: 0, length: 9000 }] }));
  assert.ok(meta.validMeta({ action: { type: 'edit', target: '11111111-1111-4111-8111-111111111111', text: 'new', entities: [{ type: 'italic', offset: 0, length: 3 }] } }));
  assert.ok(!meta.validMeta({ action: { type: 'edit', target: '11111111-1111-4111-8111-111111111111', text: 'new', entities: [{ type: 'italic', offset: 0, length: 4 }] } }));
  const base = { chatId: 'c', senderId: 'u', createdAt: '2024-01-01T00:00:00Z', cryptoState: 'decrypted', attachment: null };
  const original = { ...base, id: 1, clientId: '22222222-2222-4222-8222-222222222222', text: 'Привет мир', meta: { entities: [{ type: 'bold', offset: 0, length: 6 }] } };
  const edit = { ...base, id: 2, clientId: '33333333-3333-4333-8333-333333333333', text: '✏️', meta: { action: { type: 'edit', target: original.clientId, text: 'Пока мир', entities: [{ type: 'spoiler', offset: 5, length: 3 }] } } };
  const view = meta.foldChat([original, edit], 'u');
  assert.equal(view.messages[0].text, 'Пока мир');
  assert.deepEqual(view.messages[0].meta.entities, [{ type: 'spoiler', offset: 5, length: 3 }]);
  assert.equal(view.messages[0].edited, true);
  // An edit without entities clears the old ones.
  const plainEdit = { ...edit, id: 3, clientId: '44444444-4444-4444-8444-444444444444', meta: { action: { type: 'edit', target: original.clientId, text: 'Просто' } } };
  assert.equal(meta.foldChat([original, edit, plainEdit], 'u').messages[0].meta, undefined);
  // Chat list and reply previews hide spoilers and strip formatting.
  const listEdit = { ...edit, meta: { action: { ...edit.meta.action, target: `u:${original.clientId}` } } }; // the list keys edits by sender:clientId
  assert.equal(meta.listPreviewMessage([original, listEdit]).text, 'Пока ▒▒▒');
  assert.equal(meta.replyPreview({ text: 'Финал: Джон умер', attachment: null, meta: { entities: [{ type: 'spoiler', offset: 7, length: 9 }] } }), 'Финал: ▒▒▒▒▒▒▒▒');
  assert.equal(meta.chatListText(original), 'Привет мир');
});

test('markers inside a URL are not shortcuts, around one they still are', async () => {
  const { readFileSync } = await import('node:fs');
  const { URL_RE } = loadTs(new URL('../src/format/index.ts', import.meta.url), {});
  // The pattern is a copy of linkify's (that module needs React Native): keep the two identical.
  assert.ok(readFileSync(new URL('../src/linkify.tsx', import.meta.url), 'utf8').includes(`const URL_RE = ${URL_RE.toString()};`), 'URL_RE differs from linkify.tsx');
  const url = parseMarkdown('см. https://x.y/__init__ и __это__');
  assert.equal(url.text, 'см. https://x.y/__init__ и это');
  assert.deepEqual(url.entities, [{ type: 'italic', offset: 27, length: 3 }]);
  assert.equal(parseMarkdown('__a https://x.y/__init__ b__').text, 'a https://x.y/__init__ b');
  assert.equal(parseMarkdown('https://a.b/c**d** и **e**').text, 'https://a.b/c**d** и e');
  assert.equal(parseMarkdown('www.a.b/~~x~~').text, 'www.a.b/~~x~~');
  const bold = parseMarkdown('**https://a.b/c**');
  assert.equal(bold.text, 'https://a.b/c');
  assert.deepEqual(bold.entities, [{ type: 'bold', offset: 0, length: 13 }]);
  assert.equal(parseMarkdown('`https://a.b/__x__`').text, 'https://a.b/__x__');
});
