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
  await assert.rejects(documentText('photo.heic', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0, 1])), /не текстовый/);
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

test('any file that reads as text is accepted whatever its extension; binary is refused with a clear message', async () => {
  const { documentText } = await import('../src/documents.js');
  assert.equal((await documentText('Dockerfile', Buffer.from('FROM node:24\nRUN npm ci\n'))).text, 'FROM node:24\nRUN npm ci');
  assert.equal((await documentText('notes.weird', Buffer.from('привет, мир'))).text, 'привет, мир');
  await assert.rejects(documentText('photo.bin', Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 7, 8])), /не текстовый/);
  // An old Windows encoding still works for a known text extension.
  assert.match((await documentText('a.txt', Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).text, /Привет/);
});

test('an ordinary ZIP gives the text files in it, lists what it could not read, and skips folders like node_modules', async () => {
  const { documentText } = await import('../src/documents.js');
  const { zipSync, strToU8 } = await import('fflate');
  const zip = Buffer.from(zipSync({ 'src/app.js': strToU8('console.log(1)'), 'README.md': strToU8('# Проект'), 'logo.png': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1), 'node_modules/x/index.js': strToU8('junk') }));
  const { text } = await documentText('project.zip', zip);
  assert.match(text, /— README\.md —\n# Проект/);
  assert.match(text, /— src\/app\.js —\nconsole\.log\(1\)/);
  assert.match(text, /Не прочитано[^\n]*logo\.png/);
  assert.doesNotMatch(text, /junk/);
  await assert.rejects(documentText('pics.zip', Buffer.from(zipSync({ 'a.png': Uint8Array.of(0x89, 0x50, 0, 0, 0, 1) }))), /нет текстовых файлов/);
});

test('RTF: the text without control words', async () => {
  const { documentText } = await import('../src/documents.js');
  const { text } = await documentText('a.rtf', Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Hello\\par World \\u1055?\\u1088?}', 'latin1'));
  assert.match(text, /Hello\nWorld Пр/);
});

test('hostile markup cannot hold the server: unclosed tags and unclosed script blocks are stripped in linear time', async () => {
  const { documentText } = await import('../src/documents.js');
  const { zipSync, strToU8 } = await import('fflate');
  const started = Date.now();
  const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8('ok ' + '<'.repeat(400_000)) }));
  assert.match((await documentText('a.docx', docx)).text, /^ok/);
  assert.match((await documentText('a.html', Buffer.from('hello ' + '<script'.repeat(200_000)))).text, /^hello/);
  assert.equal((await documentText('b.html', Buffer.from('<p>a</p><script>x()</script><style>p{}</style><b>c</b>'))).text, 'a c');
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  await assert.rejects(documentText('big.rtf', Buffer.concat([Buffer.from('{\\rtf1 '), Buffer.alloc(5 * 1024 * 1024, 0x61)])), /RTF — до 4 МБ/);
});
