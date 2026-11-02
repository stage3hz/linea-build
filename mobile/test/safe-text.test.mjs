import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { visibleText, forwardLabel } = loadTs(new URL('../src/safeText.ts', import.meta.url));

test('file names lose direction tricks; forwarded-from cannot pose as the service', () => {
  assert.equal(visibleText('фото‮gpj.exe'), 'фотоgpj.exe');
  assert.equal(forwardLabel('Маша'), 'Маша');
  assert.equal(forwardLabel('Поддержка Инвиз'), null);
  assert.equal(forwardLabel('I n v i z e n t'), null);
  assert.equal(forwardLabel('​'), null);
});
