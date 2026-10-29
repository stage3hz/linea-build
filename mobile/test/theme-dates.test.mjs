import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { formatListTime, formatDay } = loadTs(new URL('../src/theme.tsx', import.meta.url));

function localClock(t, zone, now) {
  const previousZone = process.env.TZ;
  process.env.TZ = zone;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  t.after(() => {
    t.mock.timers.reset();
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
}

function labels(value, list, day) {
  assert.equal(formatListTime(value), list);
  assert.equal(formatDay(value), day);
}

test('chat date labels preserve time, yesterday and older-date formats across New Year', t => {
  localClock(t, 'UTC', '2026-01-01T00:10:00Z');
  labels('2026-01-01T00:05:00Z', '00:05', 'Сегодня');
  labels('2025-12-31T23:59:00Z', 'вчера', 'Вчера');
  labels('2025-12-30T23:59:00Z', '30 дек.', '30 декабря');
  labels('2026-01-02T00:05:00Z', '2 янв.', '2 января');
});

test('chat yesterday is a local calendar date across the 23-hour spring day', t => {
  localClock(t, 'America/New_York', '2026-03-09T00:15:00-04:00');
  labels('2026-03-09T00:05:00-04:00', '00:05', 'Сегодня');
  labels('2026-03-08T00:30:00-05:00', 'вчера', 'Вчера');
  labels('2026-03-07T23:50:00-05:00', '7 мар.', '7 марта');
});

test('chat yesterday is a local calendar date across the 25-hour autumn day', t => {
  localClock(t, 'America/New_York', '2026-11-02T00:15:00-05:00');
  labels('2026-11-02T00:05:00-05:00', '00:05', 'Сегодня');
  labels('2026-11-01T00:30:00-04:00', 'вчера', 'Вчера');
  labels('2026-10-31T23:50:00-04:00', '31 окт.', '31 октября');
});
