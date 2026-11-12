// Attachments of the AI chat (PC): the same as on the phone, with the browser's file dialog and a
// canvas for resizing photos and taking three frames of a video.
import { planUpload } from '../media/stream/index';
const MEDIA_AS_DOCUMENT = 'Фото и видео прикрепляй кнопкой «Фото и видео»: модель получит копию без метаданных (места съёмки, даты, модели камеры).';
export type AIPicture = { id: string; uri: string; data: string; video?: boolean };
export type PickedFile = { name: string; base64: string };
export const MAX_PICTURES = 8;
const MAX_DOCUMENT = 15 * 1024 * 1024;

function choose(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files || [])); input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
const toBase64 = async (blob: Blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
function draw(source: CanvasImageSource, width: number, height: number): string {
  const scale = Math.min(1, 1280 / Math.max(width, height, 1));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Не удалось подготовить фото.');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .8);
}
async function videoFrames(file: File, room: number): Promise<string[]> {
  const url = URL.createObjectURL(file); const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.src = url;
  try {
    await new Promise<void>((ok, fail) => { video.onloadedmetadata = () => ok(); video.onerror = () => fail(new Error('Видео не открылось.')); });
    const out: string[] = [];
    for (const at of (video.duration > 1 ? [0.1, 0.5, 0.9] : [0]).slice(0, room)) {
      await new Promise<void>(ok => { video.onseeked = () => ok(); video.currentTime = (video.duration || 0) * at; });
      out.push(draw(video, video.videoWidth, video.videoHeight));
    }
    return out;
  } finally { URL.revokeObjectURL(url); }
}

export async function pickPictures(room: number): Promise<AIPicture[]> {
  if (room <= 0) throw new Error(`К вопросу — до ${MAX_PICTURES} фото и кадров.`);
  const out: AIPicture[] = [];
  for (const file of await choose('image/*,video/*', true)) {
    if (out.length >= room) break;
    if (file.type.startsWith('video/')) { for (const data of await videoFrames(file, room - out.length)) out.push({ id: `${file.name}#${out.length}`, uri: data, data, video: true }); continue; }
    const bitmap = await createImageBitmap(file); const data = draw(bitmap, bitmap.width, bitmap.height); bitmap.close();
    out.push({ id: `${file.name}#${out.length}`, uri: data, data });
  }
  return out;
}

export async function pickDocuments(): Promise<PickedFile[]> {
  const files = await choose('.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.txt,.md,.csv,.json,.xml,.html,.htm,.log,.yaml,.yml,.srt,.js,.ts,.py,.java,.kt,.swift,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.sql,.css,.sh', true);
  const out: PickedFile[] = [];
  for (const file of files) { if (file.size > MAX_DOCUMENT) throw new Error(`«${file.name}» больше 15 МБ.`); if (planUpload(new Uint8Array(await file.slice(0, 768).arrayBuffer()), { name: file.name, mimeType: file.type }).kind !== 'raw') throw new Error(MEDIA_AS_DOCUMENT); out.push({ name: file.name, base64: await toBase64(file) }); }
  return out;
}

/** «Файл» on the PC: any file. A photo or a video is prepared like «Фото и видео» does it (redrawn without metadata,
 *  a video as frames) and comes back as pictures; everything else as documents. Never the original media file. */
export async function pickDocumentsOrMedia(room: number): Promise<{ files: PickedFile[]; pictures: AIPicture[] }> {
  const files: PickedFile[] = [], pictures: AIPicture[] = [];
  for (const file of await choose('', true)) {
    const media = planUpload(new Uint8Array(await file.slice(0, 768).arrayBuffer()), { name: file.name, mimeType: file.type }).kind !== 'raw';
    if (!media) {
      if (file.size > MAX_DOCUMENT) throw new Error(`«${file.name}» больше 15 МБ.`);
      files.push({ name: file.name, base64: await toBase64(file) });
      continue;
    }
    if (pictures.length >= room) throw new Error(`К вопросу — до ${MAX_PICTURES} фото и кадров.`);
    try {
      if (file.type.startsWith('video/')) { for (const data of await videoFrames(file, room - pictures.length)) pictures.push({ id: `${file.name}#${pictures.length}`, uri: data, data, video: true }); continue; }
      const bitmap = await createImageBitmap(file); const data = draw(bitmap, bitmap.width, bitmap.height); bitmap.close();
      pictures.push({ id: `${file.name}#${pictures.length}`, uri: data, data });
    } catch { throw new Error(MEDIA_AS_DOCUMENT); }
  }
  return { files, pictures };
}

export async function pickAudio(): Promise<PickedFile | null> {
  const [file] = await choose('audio/*', false);
  if (!file) return null;
  if (file.size > 10 * 1024 * 1024) throw new Error('Аудио для расшифровки — до 10 МБ.');
  return { name: file.name, base64: await toBase64(file) };
}
