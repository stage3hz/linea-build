import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPOSER_GAP, HEADER_GAP, chatListPadding } from '../src/chatLayout.ts';
import { DELETED_QUOTE, normalizeQuotePreview, quoteContent, quoteLabel } from '../src/replyQuote.ts';
import { JUMP_PAGE_CAP, knownDeleted, nextJumpStep, rowIndexOf } from '../src/replyJump.ts';

test('the list ends above the composer: its own height + the home indicator (keyboard down) + a gap', () => {
  assert.deepEqual(chatListPadding({ composer: 56, header: 110, navInset: 34, keyboardOpen: false }), { composerSide: 56 + 34 + COMPOSER_GAP, headerSide: 110 + HEADER_GAP });
  // Keyboard up: the screen above it already shrank, the home indicator is under the keyboard.
  assert.equal(chatListPadding({ composer: 56, header: 110, navInset: 34, keyboardOpen: true }).composerSide, 56 + COMPOSER_GAP);
  // A reply bar and a three-line field make the composer taller: the padding follows it.
  assert.equal(chatListPadding({ composer: 56 + 48 + 44, header: 110, navInset: 34, keyboardOpen: false }).composerSide, 148 + 34 + COMPOSER_GAP);
  // Fractional layout rounds up (never a hairline under the glass); junk values count as 0.
  assert.equal(chatListPadding({ composer: 56.4, header: 0, navInset: 0, keyboardOpen: false }).composerSide, 65);
  assert.deepEqual(chatListPadding({ composer: NaN, header: -5, navInset: Infinity, keyboardOpen: false }), { composerSide: COMPOSER_GAP, headerSide: HEADER_GAP });
});

test('legacy reply previews are shown the new way: no glyph, no duration on a video message', () => {
  assert.equal(normalizeQuotePreview('⏺ Видеосообщение · 0:10'), 'Видеосообщение');
  assert.equal(normalizeQuotePreview('⏺️ Видеосообщение · 12:03'), 'Видеосообщение');
  assert.equal(normalizeQuotePreview('⏺ Видеосообщение'), 'Видеосообщение');
  assert.equal(normalizeQuotePreview('Видеосообщение · 0:10'), 'Видеосообщение');
  assert.equal(normalizeQuotePreview('🎤 Голосовое сообщение · 0:12'), 'Голосовое сообщение · 0:12');
  assert.equal(normalizeQuotePreview('🖼 Фотография'), 'Фотография');
  assert.equal(normalizeQuotePreview('🎬 Видео'), 'Видео');
  assert.equal(normalizeQuotePreview('📎 report final.pdf'), 'report final.pdf');
  // Text a person typed is left alone, even when it starts with one of those emoji.
  assert.equal(normalizeQuotePreview('🎤 спою завтра'), '🎤 спою завтра');
  assert.equal(normalizeQuotePreview('🖼 Фотография с моря'), '🖼 Фотография с моря');
  assert.equal(normalizeQuotePreview('📊 Куда идём?'), '📊 Куда идём?');
  assert.equal(normalizeQuotePreview('  Привет,\n  как дела '), 'Привет, как дела');
  assert.equal(normalizeQuotePreview(''), '');
});

test('a reply quote prefers the live original: label and thumbnail (round for a circle, square for media)', () => {
  const preview = { mimeType: 'image/jpeg', base64: 'AAAA', width: 40, height: 40 };
  const note = { id: 'a', name: 'circle-42.mp4', mimeType: 'video/mp4', size: 1, media: { durationMs: 10000 }, preview };
  const photo = { id: 'b', name: 'IMG_1.jpg', mimeType: 'image/jpeg', size: 1, preview };
  const voice = { id: 'c', name: 'voice-1.m4a', mimeType: 'audio/mp4', size: 1, media: { durationMs: 3000 } };
  assert.equal(quoteLabel(note), 'Видеосообщение');
  assert.deepEqual(quoteContent({ text: '', attachment: note }, '⏺ Видеосообщение · 0:10'), { text: 'Видеосообщение', thumb: { preview, round: true } });
  assert.deepEqual(quoteContent({ text: '', attachment: photo }, ''), { text: 'Фотография', thumb: { preview, round: false } });
  assert.deepEqual(quoteContent({ text: 'смотри', attachment: photo }, ''), { text: 'смотри', thumb: { preview, round: false } }, 'a caption is the quote text');
  assert.equal(quoteContent({ text: '', attachment: voice }, '').thumb, null, 'no picture for a voice message');
  assert.equal(quoteContent({ text: '', attachment: { ...photo, preview: undefined } }, '').thumb, null, 'no thumbnail without a preview');
  assert.equal(quoteContent({ text: 'тайна', attachment: null, meta: { entities: [{ type: 'spoiler', offset: 0, length: 5 }] } }, '').text.includes('тайна'), false, 'a spoiler stays hidden');
  // Not loaded (or deleted): the stored preview, normalised.
  assert.deepEqual(quoteContent(undefined, '⏺ Видеосообщение · 0:10'), { text: 'Видеосообщение', thumb: null });
  assert.deepEqual(quoteContent(undefined, ''), { text: DELETED_QUOTE, thumb: null });
});

test('reply jump: load earlier pages until the original is there, then scroll; a deleted one stops at once', () => {
  const base = { found: false, deleted: false, loading: false, hasMore: true, pages: 0 };
  assert.equal(nextJumpStep({ ...base, found: true }), 'scroll');
  assert.equal(nextJumpStep(base), 'load');
  assert.equal(nextJumpStep({ ...base, loading: true, pages: 1 }), 'wait', 'one page at a time');
  assert.equal(nextJumpStep({ ...base, pages: 3 }), 'load');
  assert.equal(nextJumpStep({ ...base, pages: JUMP_PAGE_CAP }), 'too-far', 'capped');
  assert.equal(nextJumpStep({ ...base, hasMore: false, pages: 4 }), 'deleted', 'whole history loaded and it is not there');
  assert.equal(nextJumpStep({ ...base, deleted: true }), 'deleted', 'a known delete never loads pages');
  assert.equal(nextJumpStep({ ...base, deleted: true, loading: true }), 'deleted');
  assert.equal(nextJumpStep({ ...base, found: true, loading: true }), 'scroll');

  // Simulated session: the original is on the third earlier page.
  let pages = 0, loading = false, loaded = 1; const at = 3; const log = [];
  for (let guard = 0; guard < 20; guard++) {
    const step = nextJumpStep({ found: loaded > at, deleted: false, loading, hasMore: true, pages });
    log.push(step);
    if (step === 'load') { pages++; loading = true; continue; }
    if (step === 'wait') { loading = false; loaded++; continue; }
    break;
  }
  assert.deepEqual(log, ['load', 'wait', 'load', 'wait', 'load', 'wait', 'scroll']);
});

test('a deleted original is recognised from the loaded messages; rows of albums are found by any part', () => {
  const target = 'm-1';
  assert.equal(knownDeleted([{ clientId: 'x', meta: { action: { type: 'delete', target } } }], target, false), true);
  assert.equal(knownDeleted([{ clientId: target }], target, false), true, 'loaded but folded out (hidden, expired)');
  assert.equal(knownDeleted([{ clientId: target }], target, true), false);
  assert.equal(knownDeleted([{ clientId: 'y', meta: { action: { type: 'react', target, emoji: '👍' } } }], target, false), false);
  const rows = [{ message: { clientId: 'a' } }, { album: [{ message: { clientId: 'b' } }, { message: { clientId: 'c' } }], message: { clientId: 'b' } }];
  assert.equal(rowIndexOf(rows, 'c'), 1);
  assert.equal(rowIndexOf(rows, 'a'), 0);
  assert.equal(rowIndexOf(rows, 'zzz'), -1);
});

test('wiring: quotes jump through the state machine, the composer is measured without its animated inset, a broken photo offers a retry', async () => {
  const { readFileSync } = await import('node:fs');
  const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const chat = src('ChatScreen.tsx'), row = src('MessageRow.tsx'), tile = src('media/MediaBubble.tsx');
  assert.match(chat, /nextJumpStep\(\{found:index>=0,deleted:knownDeleted\(/);
  assert.doesNotMatch(chat, /const jumpTo=[^\n]*Загрузи более ранние сообщения/, 'no «load earlier messages yourself» banner for a quote');
  assert.match(chat, /<Animated\.View pointerEvents="box-none" style=\{\[\{position:'absolute',left:0,right:0,bottom:0,zIndex:4\},footerInset\]\}>/, 'the animated container is not what is measured');
  assert.match(chat, /onLayout=\{e=>\{const h=Math\.round\(e\.nativeEvent\.layout\.height\);setComposerHeight/);
  assert.match(row, /handlers\.current\.jumpTo\(reply\.clientId, row\.key\)/);
  assert.match(row, /quoteBusy \? <ActivityIndicator/);
  assert.match(tile, /onError=\{\(\) => setBroken\(media\.uri \?\? null\)\}/);
  assert.match(tile, /forgetMedia\(attachment\)\.then\(\(\) => media\.start\(\)\)/);
});
