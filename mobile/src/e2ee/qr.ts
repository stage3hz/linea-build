// A QR code for the backup key (docs/HISTORY-TRANSFER.md): «LINEA-BACKUP:» and the 36 characters of the
// secret, all in QR's alphanumeric set, fit version 3 (29×29) at error correction level M. Only that is
// made here — one version, one level, one data block — written from the QR specification (ISO/IEC 18004)
// so the phone apps make the very same picture (native/core/src/qr.rs, checked against this file).
// Checked in the tests by a real QR reader (zxing-wasm).

const VERSION = 3, SIZE = 17 + 4 * VERSION, DATA_CODEWORDS = 44, EC_CODEWORDS = 26;
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
/** At most this many characters fit. */
export const QR_MAX_TEXT = 61;

// GF(256) with the QR polynomial x^8+x^4+x^3+x^2+1.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function errorCorrection(data: number[]): number[] {
  // Generator (x - α^0)(x - α^1)…(x - α^25), highest coefficient first.
  let gen = [1];
  for (let i = 0; i < EC_CODEWORDS; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
    gen = next;
  }
  const rest = [...data, ...new Array(EC_CODEWORDS).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = rest[i];
    if (factor) for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], factor);
  }
  return rest.slice(data.length);
}

function codewords(text: string): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0010, 4); put(text.length, 9);
  for (let i = 0; i < text.length; i += 2) {
    const a = ALNUM.indexOf(text[i]);
    if (i + 1 < text.length) put(a * 45 + ALNUM.indexOf(text[i + 1]), 11); else put(a, 6);
  }
  const capacity = DATA_CODEWORDS * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < DATA_CODEWORDS; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  return [...data, ...errorCorrection(data)];
}

type Grid = { dark: boolean[][]; fixed: boolean[][] };
function functionPatterns(): Grid {
  const dark = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const fixed = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const set = (row: number, col: number, value: boolean) => { dark[row][col] = value; fixed[row][col] = true; };
  for (const [r, c] of [[0, 0], [0, SIZE - 7], [SIZE - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const row = r + dr, col = c + dc;
      if (row < 0 || col < 0 || row >= SIZE || col >= SIZE) continue;
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      set(row, col, ring !== 2 && ring !== 4);
    }
  }
  for (let i = 8; i < SIZE - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // The one alignment pattern of version 3, centred at (22, 22).
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(22 + dr, 22 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  // Format areas (filled per mask) and the dark module.
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, SIZE - 1 - i, false); set(SIZE - 1 - i, 8, false); }
  set(SIZE - 8, 8, true);
  return { dark, fixed };
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}
function drawFormat(dark: boolean[][], mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) dark[i][8] = bit(i);
  dark[7][8] = bit(6); dark[8][8] = bit(7); dark[8][7] = bit(8);
  for (let i = 9; i < 15; i++) dark[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) dark[8][SIZE - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) dark[SIZE - 15 + i][8] = bit(i);
}

function penalty(dark: boolean[][]): number {
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < SIZE; i++) {
      let run = 1;
      for (let j = 1; j <= SIZE; j++) {
        if (j < SIZE && get(i, j) === get(i, j - 1)) { run++; continue; }
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
      // Finder-like 1:1:3:1:1 with 4 light modules on a side.
      for (let j = 0; j + 10 < SIZE; j++) {
        const p = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].map(v => v === 1);
        const q = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].map(v => v === 1);
        let a = true, b = true;
        for (let k = 0; k < 11; k++) { const v = get(i, j + k); if (v !== p[k]) a = false; if (v !== q[k]) b = false; }
        if (a) score += 40; if (b) score += 40;
      }
    }
  };
  line((i, j) => dark[i][j]); line((i, j) => dark[j][i]);
  for (let r = 0; r < SIZE - 1; r++) for (let c = 0; c < SIZE - 1; c++) {
    const v = dark[r][c];
    if (v === dark[r][c + 1] && v === dark[r + 1][c] && v === dark[r + 1][c + 1]) score += 3;
  }
  let count = 0; for (const row of dark) for (const v of row) if (v) count++;
  const total = SIZE * SIZE;
  score += Math.floor(Math.abs(count * 20 - total * 10) / total) * 10;
  return score;
}

/** The modules of the QR code of `text` (row by row, true = dark), or null if it does not fit this one version. */
export function qrMatrix(text: string): boolean[][] | null {
  if (typeof text !== 'string' || !text.length || text.length > QR_MAX_TEXT || [...text].some(ch => !ALNUM.includes(ch))) return null;
  const words = codewords(text);
  const { dark: base, fixed } = functionPatterns();
  // Data placement: two-column strips from the right edge, up and down in turn, skipping the timing column.
  const placed = base.map(row => [...row]);
  let index = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? SIZE - 1 - vert : vert;
        if (fixed[row][col]) continue;
        const bit = index < words.length * 8 ? ((words[index >>> 3] >>> (7 - (index & 7))) & 1) === 1 : false;
        placed[row][col] = bit; index++;
      }
    }
  }
  let best: boolean[][] | null = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = placed.map((row, r) => row.map((value, c) => (fixed[r][c] ? value : value !== MASKS[mask](r, c))));
    drawFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}
