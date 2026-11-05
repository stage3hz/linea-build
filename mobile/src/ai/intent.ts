// One input for everything, like ChatGPT: the request itself says what to do. «Нарисуй кота» makes a
// picture, «сделай видео…» a video, «озвучь: …» speech; with a photo attached, «сделай из этого…»
// makes a new picture from it, any other question about the photo is answered in text.
export type AIIntent = 'text' | 'image' | 'video' | 'speech';

const IMAGE_NOUN = '(картин\\p{L}*|изображени\\p{L}*|рисун\\p{L}*|арт\\p{L}*|иллюстраци\\p{L}*|аватар\\p{L}*|аву|авку|логотип\\p{L}*|лого|обои|обоину|постер\\p{L}*|стикер\\p{L}*|фото\\p{L}*|пикч\\p{L}*|image|picture|art|logo|wallpaper)';
const MAKE = '(сгенериру\\p{L}*|генериру\\p{L}*|создай\\p{L}*|сделай\\p{L}*|нарисуй\\p{L}*|изобрази\\p{L}*|покажи|придумай|draw|generate|create|make)';
const VIDEO_NOUN = '(видео\\p{L}*|ролик\\p{L}*|клип\\p{L}*|анимаци\\p{L}*|video|clip|animation)';

const startsWithDraw = /^\s*(нарису\p{L}*|изобрази\p{L}*|draw|paint)(?=[\s:,.!?]|$)/iu;
const imageRequest = new RegExp(`${MAKE}[^.!?\\n]{0,40}?${IMAGE_NOUN}`, 'iu');
const videoRequest = new RegExp(`${MAKE}[^.!?\\n]{0,40}?${VIDEO_NOUN}`, 'iu');
const speechRequest = /^\s*(озвучь|озвучи|прочитай вслух|скажи голосом|read aloud|say)(?=[\s:,.!?]|$)\s*:?/iu;
// With a photo: a request to change it («сделай фон…», «перерисуй», «в стиле аниме»).
const editRequest = /(перерису\p{L}*|переделай|отредактиру\p{L}*|измени\p{L}*|замени\p{L}*|убери|добавь|сделай (из|его|её|ее|фон|в стиле|как)|в стиле|стилизу\p{L}*|edit|restyle|make it)/iu;

export function detectIntent(text: string, hasPhoto: boolean): AIIntent {
  const value = text.trim();
  if (!value) return 'text';
  if (speechRequest.test(value)) return 'speech';
  if (videoRequest.test(value)) return 'video';
  if (startsWithDraw.test(value) || imageRequest.test(value)) return 'image';
  if (hasPhoto && editRequest.test(value)) return 'image';
  return 'text';
}

/** The text to speak for «озвучь: привет» → «привет». */
export function speechText(text: string): string {
  return text.trim().replace(speechRequest, '').trim();
}
