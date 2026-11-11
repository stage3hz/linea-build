import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { afterRefresh, isConnectivityError, listStillLoading, shownError, TITLE_TEXT, titleState } from '../src/network/offline.ts';
import { CHAT_LIST_LIMIT, CHAT_PAGE_LIMIT, chatPageCacheKey, decodeChatList, decodeChatPage, encodeChatList, encodeChatPage, isCacheName, restoreChats } from '../src/chatListCache.ts';
import { CryptoService, MemoryVault, sha256 } from './support/crypto-harness.mjs';
import { keepOpened } from '../src/listCatchUp.ts';
import { nodeSignalBridge } from './support/signal-node.mjs';

const named = (name, message = 'x') => Object.assign(new Error(message), { name });
const apiError = (status, message = 'Отказано.') => Object.assign(new Error(message), { name: 'ApiError', status });
const describe = error => error instanceof Error ? error.message : 'Произошла ошибка.';
const message = (id, chatId = 'c1', extra = {}) => ({ id, chatId, senderId: 'p', clientId: randomUUID(), text: `m${id}`, attachment: null, createdAt: `2026-11-10T10:00:${String(id % 60).padStart(2, '0')}.000Z`, cryptoState: 'decrypted', ...extra });
const chat = (id, updatedAt, extra = {}) => ({ id, peer: { id: `peer-${id}`, displayName: id }, lastMessage: message(1, id), unreadCount: 0, lastReadMessageId: 0, peerLastReadMessageId: 0, createdAt: '', updatedAt, ...extra });

test('offline: a connection problem is not an error to show', () => {
  for (const error of [
    named('NetworkError', 'Нет связи с сервером. Проверь интернет и адрес подключения.'),
    named('TimeoutError', 'Сервер не ответил вовремя. Проверь подключение.'),
    named('AbortError'),
    new TypeError('Network request failed'),
    new TypeError('Failed to fetch'),
    apiError(503), apiError(500), apiError(429), apiError(408),
  ]) {
    assert.equal(isConnectivityError(error), true, error.message);
    assert.equal(shownError(error, describe), '', `no banner for: ${error.message}`);
  }
});

test('offline: real, actionable errors stay visible', () => {
  for (const error of [apiError(403, 'Доступ запрещён.'), apiError(400, 'Неверный запрос.'), apiError(404, 'Не найдено.'), new Error('Не удалось открыть зашифрованное хранилище.'), named('UntrustedDeviceError', 'Проверь коды устройств')]) {
    assert.equal(isConnectivityError(error), false, error.message);
    assert.equal(shownError(error, describe), error.message);
  }
  assert.equal(isConnectivityError(null), false);
  assert.equal(isConnectivityError('Network request failed'), false, 'only Error-like values');
});

test('refresh failure keeps the previous chats; only success replaces the list', () => {
  const previous = [chat('a', '2026-11-10T10:00:00Z'), chat('b', '2026-11-10T09:00:00Z')];
  const failed = afterRefresh(previous, { ok: false, error: named('NetworkError') }, describe);
  assert.equal(failed.list, previous, 'the same list stays on screen');
  assert.equal(failed.error, '', 'and no error card offline');
  const refused = afterRefresh(previous, { ok: false, error: apiError(403, 'Доступ запрещён.') }, describe);
  assert.equal(refused.list, previous);
  assert.equal(refused.error, 'Доступ запрещён.');
  const fresh = [chat('c', '2026-11-10T11:00:00Z')];
  assert.deepEqual(afterRefresh(previous, { ok: true, value: fresh }, describe), { list: fresh, error: '' });
  assert.deepEqual(afterRefresh(previous, { ok: true, value: [] }, describe).list, [], 'an empty answer from the server is real');
  // As useMessenger.refreshChats merges: a line already opened on this device stays opened.
  const opened = chat('a', '2026-11-10T10:00:00Z');
  const closedLine = { ...opened, lastMessage: { ...opened.lastMessage, text: 'Зашифрованное сообщение. Открой чат для расшифровки.', cryptoState: 'no-key', lean: true } };
  const merged = afterRefresh([opened], { ok: true, value: [closedLine] }, describe, (before, next) => keepOpened(next, before)).list;
  assert.equal(merged[0].lastMessage.text, 'm1');
});

test('offline: the chat list never falls back to «Начни разговор» because a request failed', () => {
  assert.equal(listStillLoading({ chats: 0, serverLoaded: false, failure: 'connectivity' }), true, 'nothing cached yet, offline: skeleton, not empty');
  assert.equal(listStillLoading({ chats: 0, serverLoaded: false, failure: 'none' }), true);
  assert.equal(listStillLoading({ chats: 5, serverLoaded: false, failure: 'connectivity' }), false, 'cached chats are shown');
  assert.equal(listStillLoading({ chats: 0, serverLoaded: true, failure: 'connectivity' }), false, 'the server said: no chats');
  assert.equal(listStillLoading({ chats: 0, serverLoaded: false, failure: 'error' }), false, 'a real error ends the wait');
});

test('title: «Ожидание сети…» → «Соединение…» → «Обновление…» → «Чаты»', () => {
  assert.equal(titleState({ connection: 'offline', online: false, updating: false, mesh: false }), 'waiting');
  assert.equal(titleState({ connection: 'connecting', online: false, updating: false, mesh: false }), 'waiting', 'no network: the socket retries are not «Соединение…»');
  assert.equal(titleState({ connection: 'offline', online: true, updating: false, mesh: false }), 'connecting', 'network but no server');
  assert.equal(titleState({ connection: 'connecting', online: true, updating: false, mesh: false }), 'connecting');
  assert.equal(titleState({ connection: 'connected', online: true, updating: true, mesh: false }), 'updating');
  assert.equal(titleState({ connection: 'connected', online: true, updating: false, mesh: false }), 'chats');
  assert.equal(titleState({ connection: 'offline', online: false, updating: false, mesh: true }), 'mesh');
  // No NetInfo (unknown): the socket state decides, as before.
  assert.equal(titleState({ connection: 'offline', online: null, updating: false, mesh: false }), 'waiting');
  assert.equal(titleState({ connection: 'connecting', online: null, updating: false, mesh: false }), 'connecting');
  assert.deepEqual(TITLE_TEXT, { waiting: 'Ожидание сети…', connecting: 'Соединение…', updating: 'Обновление…' });
});

test('chat list cache: round trip without ciphertext, newest first, garbage reads as nothing', () => {
  const withCipher = chat('a', '2026-11-10T09:00:00Z', { lastMessage: message(7, 'a', { encrypted: { scheme: 'signal-v1', envelopes: [] } }) });
  const list = [withCipher, chat('b', '2026-11-10T10:00:00Z')];
  const decoded = decodeChatList(encodeChatList(list));
  assert.deepEqual(decoded.map(item => item.id), ['b', 'a']);
  assert.equal('encrypted' in decoded[1].lastMessage, false, 'only what was shown is kept');
  assert.equal(decoded[1].lastMessage.text, 'm7');
  for (const raw of [null, '', '{', '{}', '"x"', '[1,2]', JSON.stringify([{ id: 'x' }]), JSON.stringify([{ ...chat('z', 'now'), lastMessage: { id: 'bad' } }])]) assert.deepEqual(decodeChatList(raw), [], String(raw));
  assert.deepEqual(decodeChatList(JSON.stringify([chat('a', '1'), chat('a', '2')])).length, 1, 'duplicates dropped');
  const many = Array.from({ length: CHAT_LIST_LIMIT + 20 }, (_, i) => chat(`c${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`));
  assert.equal(decodeChatList(encodeChatList(many)).length, CHAT_LIST_LIMIT);
});

test('chat list cache: restored only until the server answered; live entries win', () => {
  const cached = [chat('a', '2026-11-10T09:00:00Z'), chat('b', '2026-11-10T08:00:00Z')];
  assert.deepEqual(restoreChats([], cached, false), cached);
  const server = [chat('x', '2026-11-10T07:00:00Z')];
  assert.equal(restoreChats(server, cached, true), server, 'a server list is never replaced by the cache');
  const live = [chat('a', '2026-11-10T12:00:00Z', { unreadCount: 3 })];
  const merged = restoreChats(live, cached, false);
  assert.deepEqual(merged.map(item => [item.id, item.unreadCount]), [['a', 3], ['b', 0]]);
  assert.equal(restoreChats(live, [], false), live);
});

test('chat page cache: newest messages of that chat only, Mesh copies left out', () => {
  const list = [...Array.from({ length: CHAT_PAGE_LIMIT + 10 }, (_, i) => message(i + 1, 'c1', i === 3 ? { encrypted: { scheme: 'signal-v1' } } : {})), message(9e15 + 1, 'c1', { mesh: true })];
  const page = decodeChatPage(encodeChatPage(list, false), 'c1');
  assert.equal(page.messages.length, CHAT_PAGE_LIMIT);
  assert.equal(page.messages.at(-1).id, CHAT_PAGE_LIMIT + 10, 'newest kept');
  assert.equal(page.hasMore, true, 'older messages exist beyond the cached page');
  assert.ok(page.messages.every(item => !item.mesh && !('encrypted' in item)));
  assert.equal(decodeChatPage(encodeChatPage(list, false), 'other'), null, 'another chat reads nothing');
  assert.equal(decodeChatPage('garbage', 'c1'), null);
  assert.equal(chatPageCacheKey('c1'), 'page:v1:c1');
  assert.equal(chatPageCacheKey('../x'), null);
  assert.equal(isCacheName('chats:v1'), true); assert.equal(isCacheName('page:v1:c1'), true);
  assert.equal(isCacheName('device'), false); assert.equal(isCacheName('protocol'), false);
});

test('vault: Избранное and the cached chat list open with no network; a deleted chat loses its page', async () => {
  const vault = new MemoryVault();
  const down = async () => { const error = new Error('Нет связи с сервером.'); error.name = 'NetworkError'; throw error; };
  const transport = { registerCryptoDevice: down, cryptoDevices: down, claimPreKey: down, cryptoInbox: down };
  const service = new CryptoService(randomUUID(), transport, nodeSignalBridge, vault, randomUUID, sha256, { autoTrust: true });
  await assert.rejects(service.initialize(), /Нет связи/, 'the device cannot be registered offline');
  await service.storeSaved('[]');
  assert.equal(await service.loadSaved(), '[]', 'Избранное reads from the vault without the server');
  const list = encodeChatList([chat('a', '2026-11-10T09:00:00Z')]);
  await service.storeCache('chats:v1', list);
  assert.equal(await service.loadCache('chats:v1'), list);
  await service.storeCache('page:v1:a', encodeChatPage([message(1, 'a')], false));
  await assert.rejects(service.loadCache('device'), /Unknown cache entry/, 'keys and ratchets are not reachable through the cache API');
  await assert.rejects(service.storeCache('protocol', 'x'), /Unknown cache entry/);
  await service.forgetChat('a');
  assert.equal(await service.loadCache('page:v1:a'), null, 'a deleted chat leaves no cached page');
  await service.close();
});
