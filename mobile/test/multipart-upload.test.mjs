import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const api = loadTs(new URL('../src/api.ts', import.meta.url), { 'react-native': { Platform: { OS: 'ios' } } });

test('uploads are sent as a plain multipart body the server can parse (no RN FormData uri parts)', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const part = api.multipartFile(bytes, 'my "photo".jpg', 'image/jpeg');
  const boundary = /boundary=(.+)$/.exec(part.contentType)[1];
  const text = Buffer.from(part.body).toString('latin1');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="my _photo_.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
  assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`));
  const start = text.indexOf('\r\n\r\n') + 4;
  assert.deepEqual([...part.body.slice(start, start + bytes.length)], [...bytes]);
  assert.match(api.multipartFile(bytes, 'x', 'bad type;').contentType, /^multipart\/form-data; boundary=/);
});
