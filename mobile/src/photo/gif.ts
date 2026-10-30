// Animated GIF without metadata. A GIF can carry comments and application
// blocks (XMP, editor names, etc.). We rebuild the file block by block and keep
// only what is needed to show the animation: the screen descriptor, colour
// tables, frame timing (graphic control) and the NETSCAPE loop count.

export type CleanGif = { bytes: Uint8Array; width: number; height: number; frames: number };
const MAX_FRAMES = 2000;

export function sanitizeGif(input: Uint8Array): CleanGif {
  const ascii = (start: number, end: number) => String.fromCharCode(...input.subarray(start, end));
  if (input.length < 14 || !/^GIF8[79]a$/.test(ascii(0, 6))) throw new Error('Это не GIF.');
  const out: number[] = [];
  const copy = (start: number, end: number) => { if (end > input.length) throw new Error('GIF повреждён.'); for (let i = start; i < end; i++) out.push(input[i]); };
  const width = input[6] | (input[7] << 8), height = input[8] | (input[9] << 8);
  if (!width || !height || width > 8192 || height > 8192) throw new Error('Недопустимый размер GIF.');
  // Header is always written as GIF89a (needed for the graphic control blocks).
  for (const ch of 'GIF89a') out.push(ch.charCodeAt(0));
  copy(6, 13);
  let pos = 13;
  const flags = input[10];
  if (flags & 0x80) { const size = 3 * (1 << ((flags & 7) + 1)); copy(pos, pos + size); pos += size; }
  /** Sub-blocks: length byte + data, ending with a zero length. */
  const subBlocks = (keep: boolean) => {
    for (;;) {
      if (pos >= input.length) throw new Error('GIF повреждён.');
      const size = input[pos];
      if (keep) copy(pos, pos + 1 + size);
      pos += 1 + size;
      if (size === 0) return;
    }
  };
  let frames = 0;
  while (pos < input.length) {
    const block = input[pos];
    if (block === 0x3b) { out.push(0x3b); return { bytes: Uint8Array.from(out), width, height, frames }; }
    if (block === 0x2c) {
      if (++frames > MAX_FRAMES) throw new Error('В GIF слишком много кадров.');
      copy(pos, pos + 10);
      const local = input[pos + 9]; pos += 10;
      if (local & 0x80) { const size = 3 * (1 << ((local & 7) + 1)); copy(pos, pos + size); pos += size; }
      copy(pos, pos + 1); pos += 1; // LZW minimum code size
      subBlocks(true);
      continue;
    }
    if (block === 0x21) {
      const label = input[pos + 1];
      if (label === 0xf9) { copy(pos, pos + 2); pos += 2; subBlocks(true); continue; }
      if (label === 0xff && input[pos + 2] === 11) {
        const id = ascii(pos + 3, pos + 14);
        const keep = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0';
        if (keep) copy(pos, pos + 14);
        pos += 14; subBlocks(keep); continue;
      }
      pos += 2; subBlocks(false); continue; // comments, plain text, other application data
    }
    throw new Error('GIF повреждён.');
  }
  // Some encoders omit the trailer; add it.
  if (!frames) throw new Error('В GIF нет кадров.');
  out.push(0x3b);
  return { bytes: Uint8Array.from(out), width, height, frames };
}
