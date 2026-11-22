import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

// The backup key's QR code (src/e2ee/qr.ts) read back by a real QR reader (zxing-wasm, from node_modules).
const { qrMatrix } = loadTs(new URL('../src/e2ee/qr.ts', import.meta.url));
const history = loadTs(new URL('../src/e2ee/history.ts', import.meta.url));

async function reader() {
  const url = new URL('../node_modules/zxing-wasm/dist/es/reader/index.js', import.meta.url);
  const zxing = await import(url);
  await zxing.prepareZXingModule({ overrides: { wasmBinary: readFileSync(new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url)) }, fireImmediately: true });
  return zxing;
}
function image(matrix, scale = 6, quiet = 4) {
  const size = (matrix.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const at = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }));
  return { data, width: size, height: size, colorSpace: 'srgb' };
}

test('the backup key QR code is read back exactly by a real QR reader', async () => {
  const zxing = await reader();
  for (let i = 0; i < 12; i++) {
    const secret = history.newBackupSecret(count => new Uint8Array(randomBytes(count)));
    const text = history.secretQr(secret).toUpperCase();
    const matrix = qrMatrix(text);
    assert.equal(matrix.length, 29);
    const [result] = await zxing.readBarcodes(image(matrix), { formats: ['QRCode'], tryHarder: true });
    assert.ok(result, 'decoded');
    assert.equal(result.text, text);
    assert.equal(history.parseSecret(result.text), secret);
  }
  assert.equal(qrMatrix('lowercase'), null);
  assert.equal(qrMatrix('A'.repeat(62)), null);
});
