import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { nativeErrorMessage } = loadTs(new URL('../src/media/nativeError.ts', import.meta.url));

test('native module failures read as plain text, without class, code or source location', () => {
  const raw = new Error('UnexpectedException: Этот файл или его кодек не удалось безопасно обработать. Исходное видео не отправлено. [ERR_LINEA_VIDEO_LIBRARY_ASSET_UNAVAILABLE] (at ExpoModulesCore/AsyncFunctionDefinition.swift:126)');
  assert.equal(nativeErrorMessage(raw, 'x'), 'Этот файл или его кодек не удалось безопасно обработать. Исходное видео не отправлено.');
  assert.equal(nativeErrorMessage(new Error('Видео превышает 100 МиБ. [ERR_LINEA_VIDEO_INPUT_TOO_LARGE]'), 'x'), 'Видео превышает 100 МиБ.');
  assert.equal(nativeErrorMessage(new Error('Файл слишком большой. Максимум — 20 МБ.'), 'x'), 'Файл слишком большой. Максимум — 20 МБ.');
  assert.equal(nativeErrorMessage(new Error('UnexpectedException:  (at A.swift:1)'), 'fallback'), 'fallback');
  assert.equal(nativeErrorMessage({}, 'fallback'), 'fallback');
});
