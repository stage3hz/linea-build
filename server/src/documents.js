// Text out of a document for an AI question: PDF (unpdf / pdf.js), DOCX/ODT/PPTX/XLSX (zip + XML),
// and plain text formats. Nothing is stored — the bytes come in, the text goes back to the
// client, which then sends it with its questions. Scanned PDFs (pictures only) have no text.
import { extractText, getDocumentProxy } from 'unpdf';
import { unzipSync, strFromU8 } from 'fflate';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT = 120_000;
const MAX_UNZIPPED = 80 * 1024 * 1024, MAX_PARTS = 600;
const TEXT_TYPES = /\.(txt|md|markdown|csv|tsv|json|xml|html?|log|ya?ml|ini|srt|vtt|js|ts|py|java|kt|swift|c|cpp|h|cs|go|rs|rb|php|sql|css|sh)$/i;

const decodeEntities = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** Paragraph-ish text from Office XML: paragraph and row ends become new lines, tags are dropped. */
function xmlText(xml) {
  return decodeEntities(xml
    .replace(/<\/w:p>\s*<\/w:tc>/g, '\t').replace(/<\/w:tc>/g, '\t')
    .replace(/<w:tab\/>|<a:tab\/>|<text:tab\/>/g, '\t')
    .replace(/<\/(w:p|a:p|text:p|text:h|row|w:tr)>|<w:br\/>|<a:br\/>|<text:line-break\/>/g, '\n')
    .replace(/<\/c>/g, '\t')
    .replace(/<[^>]+>/g, ''))
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
      if (file.originalSize > 40 * 1024 * 1024 || total > MAX_UNZIPPED || parts > MAX_PARTS) throw new RangeError('too big');
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
  throw new Error(`Не удалось найти текст в «${name}».`);
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
  } else if (TEXT_TYPES.test(name)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('windows-1251').decode(bytes); }
    if (/\.html?$/i.test(name)) text = decodeEntities(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');
  } else throw new Error('Поддерживаются PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX), OpenDocument и текстовые файлы.');
  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw new Error('В документе нет текста.');
  const truncated = text.length > MAX_DOCUMENT_TEXT;
  return { text: truncated ? text.slice(0, MAX_DOCUMENT_TEXT) : text, truncated, ...(pages ? { pages } : {}) };
}
