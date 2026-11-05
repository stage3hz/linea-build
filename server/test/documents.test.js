import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentText } from '../src/documents.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));

test('AI documents: text comes out of PDF pages, DOCX paragraphs and tables, and plain text', async () => {
  const pdf = await documentText('счёт.pdf', await fixture('sample.pdf'));
  assert.equal(pdf.pages, 2);
  assert.match(pdf.text, /Invoice 42: total 1500 rub/);
  assert.match(pdf.text, /Страница 2[\s\S]*due Friday/);
  const docx = await documentText('план.docx', await fixture('sample.docx'));
  assert.match(docx.text, /Plan for the week\nMonday: gym/);
  assert.match(docx.text, /A1\tB1/);
  assert.equal((await documentText('notes.md', Buffer.from('# Привет\nмир'))).text, '# Привет\nмир');
  assert.equal((await documentText('old.txt', Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).text, 'Привет', 'windows-1251 text files');
  const long = await documentText('big.txt', Buffer.from('я'.repeat(130_000)));
  assert.equal(long.truncated, true); assert.equal(long.text.length, 120_000);
});

test('AI documents: unknown, broken and empty files are refused with a clear message', async () => {
  await assert.rejects(documentText('photo.heic', Buffer.from('xxxx')), /Поддерживаются PDF/);
  await assert.rejects(documentText('bad.pdf', Buffer.from('%PDF-1.4 broken')), /PDF повреждён/);
  await assert.rejects(documentText('bad.docx', Buffer.from([0x50, 0x4b, 3, 4, 0, 0])), /повреждён|текст/);
  await assert.rejects(documentText('empty.txt', Buffer.from('  \n')), /нет текста/);
});

test('an Office archive that unpacks to too much is refused before it is unpacked', async () => {
  const { zipSync } = await import('fflate');
  const slide = new Uint8Array(30 * 1024 * 1024); // zeros: a few KB compressed, 30 MB unpacked
  const bomb = Buffer.from(zipSync({ 'ppt/slides/slide1.xml': slide, 'ppt/slides/slide2.xml': slide, 'ppt/slides/slide3.xml': slide }, { level: 1 }));
  assert.ok(bomb.length < 1024 * 1024);
  await assert.rejects(documentText('bomb.pptx', bomb), /слишком большой после распаковки/);
});
