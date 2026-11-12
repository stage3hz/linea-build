// Text out of a document for an AI question: PDF (unpdf / pdf.js), DOCX/ODT/PPTX/XLSX (zip + XML), RTF, an
// ordinary ZIP with text files, and any file that reads as text,
// and plain text formats. Nothing is stored — the bytes come in, the text goes back to the
// client, which then sends it with its questions. Scanned PDFs (pictures only) have no text.
import { extractText, getDocumentProxy } from 'unpdf';
import { unzipSync, strFromU8 } from 'fflate';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT = 120_000;
const MAX_UNZIPPED = 80 * 1024 * 1024, MAX_PARTS = 600, MAX_PART = 8 * 1024 * 1024;
const TEXT_TYPES = /\.(txt|md|markdown|csv|tsv|json|xml|html?|log|ya?ml|ini|srt|vtt|js|ts|py|java|kt|swift|c|cpp|h|cs|go|rs|rb|php|sql|css|sh)$/i;

const decodeEntities = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** Removes <tag …>…</tag> blocks with plain scans. A lazy regex here rescanned the rest of the text from every
 *  unclosed opening tag (quadratic: a small file of «<script» could hold the server for minutes). */
function dropBlocks(text, tag) {
  const lower = text.toLowerCase(), open = `<${tag}`, close = `</${tag}>`;
  let out = '', at = 0;
  for (;;) {
    const start = lower.indexOf(open, at);
    if (start < 0) return out + text.slice(at);
    const end = lower.indexOf(close, start);
    if (end < 0) return out + text.slice(at, start);
    out += text.slice(at, start); at = end + close.length;
  }
}

/** Paragraph-ish text from Office XML: paragraph and row ends become new lines, tags are dropped. */
function xmlText(xml) {
  return decodeEntities(xml
    .replace(/<\/w:p>\s*<\/w:tc>/g, '\t').replace(/<\/w:tc>/g, '\t')
    .replace(/<w:tab\/>|<a:tab\/>|<text:tab\/>/g, '\t')
    .replace(/<\/(w:p|a:p|text:p|text:h|row|w:tr)>|<w:br\/>|<a:br\/>|<text:line-break\/>/g, '\n')
    .replace(/<\/c>/g, '\t')
    .replace(/<[^<>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function zipText(bytes, name) {
  let files, total = 0, parts = 0;
  try {
    // Only the parts that hold text are decompressed (an archive bomb elsewhere is never opened),
    // and all of them together stay under MAX_UNZIPPED: a thousand 40 MB «slides» are refused.
    files = unzipSync(bytes, { filter: file => {
      if (!/^(word\/document\.xml|content\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml)$/.test(file.name)) return false;
      total += file.originalSize; parts += 1;
      if (file.originalSize > MAX_PART || total > MAX_UNZIPPED || parts > MAX_PARTS) throw new RangeError('too big');
      return true;
    } });
  } catch (error) {
    if (error instanceof RangeError) throw new Error('Документ слишком большой после распаковки.');
    throw new Error('Файл повреждён или это не документ Office.');
  }
  if (files['word/document.xml']) return xmlText(strFromU8(files['word/document.xml']));
  if (files['content.xml']) return xmlText(strFromU8(files['content.xml']));
  const slides = Object.keys(files).filter(key => key.startsWith('ppt/slides/')).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (slides.length) return slides.map((key, index) => `— Слайд ${index + 1} —\n${xmlText(strFromU8(files[key]))}`).join('\n\n');
  if (files['xl/sharedStrings.xml']) return xmlText(strFromU8(files['xl/sharedStrings.xml']).replace(/<\/si>/g, '\n'));
  return archiveText(bytes, name);
}

/** Looks like text: decodes as UTF-8 and has next to no control bytes. Returns the text or null. */
function plainText(bytes) {
  if (!bytes.length) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  const sample = text.length > 20000 ? text.slice(0, 20000) : text;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) { const c = sample.charCodeAt(i); if (c < 32 && c !== 9 && c !== 10 && c !== 13) odd++; }
  return odd > sample.length * 0.01 ? null : text;
}

/** An ordinary ZIP (a project, a folder of notes): the text files in it, each under its path. Binary entries are
 *  only listed. The same caps as for Office files keep an archive bomb from being unpacked. */
function archiveText(bytes, name) {
  const skipped = []; let files, total = 0, parts = 0;
  try {
    files = unzipSync(bytes, { filter: file => {
      if (file.name.endsWith('/') || /(^|\/)(\.git|node_modules|__MACOSX)\//.test(file.name)) return false;
      if (file.originalSize > 2 * 1024 * 1024 || parts >= 200 || total + file.originalSize > 20 * 1024 * 1024) { skipped.push(file.name); return false; }
      total += file.originalSize; parts += 1;
      return true;
    } });
  } catch { throw new Error('Файл повреждён или это не архив.'); }
  const out = [];
  for (const path of Object.keys(files).sort()) {
    const text = plainText(files[path]);
    if (text === null) { skipped.push(path); continue; }
    if (text.trim()) out.push(`— ${path} —\n${text.trim()}`);
  }
  if (!out.length) throw new Error(`В архиве «${name}» нет текстовых файлов.`);
  return out.join('\n\n') + (skipped.length ? `\n\n— Не прочитано (не текст или слишком большое): ${skipped.slice(0, 40).join(', ')}${skipped.length > 40 ? ` и ещё ${skipped.length - 40}` : ''} —` : '');
}

/** RTF: the control words and groups are dropped, the text and paragraph breaks stay. */
function rtfText(source) {
  return source.replace(/\{\\\*[^{}]*\}/g, '').replace(/\\par[d]?\b ?/g, '\n').replace(/\\tab\b ?/g, '\t')
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => new TextDecoder('windows-1251').decode(Uint8Array.of(parseInt(h, 16))))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').replace(/\n{3,}/g, '\n\n');
}

/** Returns { text, truncated, pages? }. Throws an Error with a user-facing message. */
export async function documentText(name, bytes) {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Документ — до 15 МБ.');
  let text, pages;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    let pdf;
    try { pdf = await getDocumentProxy(new Uint8Array(bytes)); } catch { throw new Error('PDF повреждён или защищён паролем.'); }
    const result = await extractText(pdf, { mergePages: false });
    pages = result.totalPages;
    text = result.text.map((page, index) => (result.text.length > 1 ? `— Страница ${index + 1} —\n` : '') + String(page).trim()).join('\n\n').trim();
    await pdf.destroy?.();
    if (!text) throw new Error('В этом PDF нет текста — похоже, это скан. Сфотографируй страницы и отправь как фото.');
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    text = zipText(bytes, name);
  } else if (bytes.subarray(0, 5).toString('latin1') === '{\\rtf') {
    if (bytes.length > 4 * 1024 * 1024) throw new Error('RTF — до 4 МБ.');
    text = rtfText(bytes.toString('latin1'));
  } else {
    // Any file that reads as text is taken whatever its extension (code, configs, logs, subtitles, notes…); a known
    // text extension in an old Windows encoding is decoded as windows-1251.
    const plain = plainText(bytes);
    if (plain !== null) text = plain;
    else if (TEXT_TYPES.test(name)) text = new TextDecoder('windows-1251').decode(bytes);
    else throw new Error('Этот файл не текстовый. Читаются PDF, Word, PowerPoint, Excel, OpenDocument, RTF, архивы ZIP с текстом и любые текстовые файлы; фото и видео прикрепляй как фото, аудио — как аудио.');
    if (/\.html?$/i.test(name)) text = decodeEntities(dropBlocks(dropBlocks(text, 'script'), 'style').replace(/<[^<>]*>/g, ' ')).replace(/[ \t]+/g, ' ');
  }
  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw new Error('В документе нет текста.');
  const truncated = text.length > MAX_DOCUMENT_TEXT;
  return { text: truncated ? text.slice(0, MAX_DOCUMENT_TEXT) : text, truncated, ...(pages ? { pages } : {}) };
}
