import assert from 'node:assert/strict';
import test from 'node:test';
import { publicName, visibleText } from '../src/security.js';

test('hidden and direction-changing characters are removed from names', () => {
  assert.equal(visibleText('Вася‮киньдоп‬'), 'Васякиньдоп');
  assert.equal(visibleText('Ма​ша﻿'), 'Маша');
  assert.equal(publicName('  Пётр  Иванов ', 'Имя', 1, 50), 'Пётр Иванов');
  assert.throws(() => publicName('​​', 'Имя', 1, 50), /от 1 до 50/);
});

test('names cannot pose as the service or its support, including look-alike spellings', () => {
  for (const fake of ['Инвиз', 'Поддержка Инвиз', 'Иnвиз', 'INVIZENT', 'Invizent Support', 'И н в и з', 'Служба безопасности', 'Администрация', 'ИНВ1З official'])
    assert.throws(() => publicName(fake, 'Имя', 1, 50), error => error.code === 'RESERVED_NAME' || /нельзя использовать/.test(error.message), fake);
  for (const fine of ['Вика', 'Invader', 'Inna', 'Лина', 'Кот Мурзик'])
    assert.equal(publicName(fine, 'Имя', 1, 50), fine);
});
