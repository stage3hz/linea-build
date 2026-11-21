// Produces tests/vectors/link-charsets.json: how the WHATWG decoders (Node's TextDecoder, full ICU) read every
// byte of the one-byte charsets the link-card parser knows, and a few Russian sentences in each. The parser's own
// tables (native/core/src/link_preview.rs) must give the same characters.
// Run from the repository root:  node native/core/tests/generate-link-vectors.mjs
import { writeFileSync } from 'node:fs';

const all = new Uint8Array(256).map((_, index) => index);
const charsets = ['windows-1251', 'koi8-r', 'windows-1252'];
const tables = charsets.map(name => ({ name, text: new TextDecoder(name).decode(all) }));

// Sentences as bytes in each Russian charset: the reverse of the decoder's table.
const samples = ['Съешь ещё этих мягких французских булок, да выпей чаю — «№ 1»', 'Новости дня: Ёжик в тумане', 'ЦЕНЫ • 100 ₽ ≈ 1 €'];
const encoded = [];
for (const name of ['windows-1251', 'koi8-r']) {
  const table = new TextDecoder(name).decode(all);
  for (const sample of samples) {
    const bytes = Array.from(sample, c => { const at = table.indexOf(c); return at < 0 ? 0x3f : at; });
    encoded.push({ name, base64: Buffer.from(bytes).toString('base64'), text: new TextDecoder(name).decode(Uint8Array.from(bytes)) });
  }
}
writeFileSync(new URL('./vectors/link-charsets.json', import.meta.url), JSON.stringify({ tables, encoded }));
console.log(`${tables.length} tables, ${encoded.length} sentences`);
