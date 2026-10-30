// Pure helpers for emoji-only messages (no React Native imports: unit-tested).

export function isEmojiCluster(part: string): boolean {
  const code = part.codePointAt(0) || 0;
  return (code >= 0x1f000 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf) || (code >= 0x2b00 && code <= 0x2bff)
    || (code >= 0x2190 && code <= 0x21ff) || (code >= 0x231a && code <= 0x23ff) || (code >= 0x25aa && code <= 0x25fe)
    || [0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x3030, 0x303d, 0x3297, 0x3299].includes(code);
}

/** Splits emoji text into clusters (joins variation selectors, ZWJ sequences, skin tones, keycaps). */
export function emojiClusters(text: string): string[] {
  const out: string[] = []; let joinNext = false;
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) || 0;
    if (/\s/.test(char)) { joinNext = false; continue; }
    const attaches = code === 0xfe0f || code === 0x20e3 || (code >= 0x1f3fb && code <= 0x1f3ff) || code === 0x200d || (code >= 0xe0020 && code <= 0xe007f);
    if ((attaches || joinNext) && out.length) { out[out.length - 1] += char; joinNext = code === 0x200d; continue; }
    out.push(char); joinNext = false;
  }
  return out;
}
