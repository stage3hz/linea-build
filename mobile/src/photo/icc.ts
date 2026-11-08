// Numeric ICC handling for the HDR JPEG gate (a port of IccRange in PhotoSource.kt): a profile is accepted
// only as numbers (RGB primaries, white point, adaptation matrix, a standard tone curve) and replaced by a
// freshly generated minimal ICC v4 profile named "Linea RGB". Text tags (description, copyright, device
// manufacturer and model) of the original never leave the device.

export type IccCurve = { kind: 'srgb' } | { kind: 'gamma'; gamma: number };
export type IccNumbers = {
  red: [number, number, number]; green: [number, number, number]; blue: [number, number, number];
  chad?: number[]; curve: IccCurve;
};

const fail = (reason: string): never => { throw new Error(`ICC: ${reason}`); };
const text = (data: Uint8Array, at: number, length: number) => String.fromCharCode(...data.subarray(at, at + length));
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const fixed = (data: Uint8Array, at: number) => view(data).getInt32(at) / 65536;
const roundFixed = (value: number) => Math.round(value * 65536) / 65536;
const SRGB = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
const GAMMAS = [1, 1.8, 2.2, 2.4];
const IGNORED = new Set(['desc', 'cprt', 'dmnd', 'dmdd', 'tech', 'view', 'meas', 'targ', 'chrm', 'bkpt', 'wtpt', 'lumi', 'cicp', 'chad',
  // Text and vendor tags (HP sRGB `vued`, Apple `dscm`, gamut/calibration/metadata): never copied, safe to ignore.
  'vued', 'dscm', 'gamt', 'calt', 'ciis', 'meta', 'pseq']);
const USED = new Set(['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']);

function curve(data: Uint8Array): IccCurve | null {
  if (data.length < 12) return null;
  const type = text(data, 0, 4);
  if (type === 'para') {
    const kind = view(data).getUint16(8);
    if (kind === 0 && data.length >= 16) { const gamma = fixed(data, 12); const match = GAMMAS.find(value => Math.abs(gamma - value) < 0.001); return match ? { kind: 'gamma', gamma: match } : null; }
    if ((kind !== 3 && kind !== 4) || data.length < (kind === 3 ? 32 : 40)) return null;
    if (SRGB.some((value, index) => Math.abs(fixed(data, 12 + index * 4) - value) > 0.0001)) return null;
    if (kind === 4 && (Math.abs(fixed(data, 32)) > 0.0001 || Math.abs(fixed(data, 36)) > 0.0001)) return null;
    return { kind: 'srgb' };
  }
  if (type !== 'curv') return null;
  const count = view(data).getUint32(8);
  if (count > 65536 || 12 + count * 2 > data.length) return null;
  if (count === 0) return { kind: 'gamma', gamma: 1 };
  if (count === 1) { const gamma = view(data).getUint16(12) / 256; const match = GAMMAS.find(value => Math.abs(gamma - value) < 0.01); return match ? { kind: 'gamma', gamma: match } : null; }
  const candidates: IccCurve[] = [{ kind: 'srgb' }, ...GAMMAS.map(gamma => ({ kind: 'gamma' as const, gamma }))];
  const expected = (c: IccCurve, x: number) => c.kind === 'srgb' ? (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4) : x ** c.gamma;
  let left = candidates;
  for (let i = 0; i < count && left.length; i++) {
    const x = i / (count - 1), value = view(data).getUint16(12 + 2 * i) / 65535;
    left = left.filter(c => Math.abs(value - expected(c, x)) <= 3 / 65535);
  }
  return left[0] ?? null;
}

/** Profile → numbers, or an error for anything that is not a plain matrix/TRC RGB profile (or carries an HDR transfer). */
export function parseIcc(data: Uint8Array): IccNumbers {
  if (data.length < 132 || data.length > 4 * 1024 * 1024 || view(data).getUint32(0) !== data.length || text(data, 36, 4) !== 'acsp' || text(data, 16, 4) !== 'RGB ' || text(data, 20, 4) !== 'XYZ ' || data[8] < 2 || data[8] > 4) fail('неподдерживаемый профиль.');
  const count = view(data).getUint32(128);
  if (count > 256 || 132 + count * 12 > data.length) fail('неверная таблица тегов.');
  const tags = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12, name = text(data, at, 4), start = view(data).getUint32(at + 4), size = view(data).getUint32(at + 8);
    if (start < 132 + count * 12 || size < 8 || start + size > data.length || tags.has(name)) fail('неверный тег.');
    tags.set(name, data.subarray(start, start + size));
  }
  const cicp = tags.get('cicp');
  if (cicp && (cicp.length < 12 || cicp[9] === 16 || cicp[9] === 18)) fail('HDR-передаточная функция требует отдельной обработки.');
  for (const name of tags.keys()) if (!IGNORED.has(name) && !USED.has(name)) fail('неизвестный тег профиля.');
  const xyz = (name: string): [number, number, number] => {
    const tag = tags.get(name);
    if (!tag || tag.length !== 20 || text(tag, 0, 4) !== 'XYZ ') return fail('нет матрицы профиля.');
    return [fixed(tag, 8), fixed(tag, 12), fixed(tag, 16)];
  };
  const red = xyz('rXYZ'), green = xyz('gXYZ'), blue = xyz('bXYZ');
  if (Math.abs(red[1] + green[1] + blue[1] - 1) > 0.03) fail('матрица профиля не нормирована.');
  const curves = ['rTRC', 'gTRC', 'bTRC'].map(name => { const tag = tags.get(name); return tag ? curve(tag) : null; });
  if (curves.some(c => !c) || curves.some(c => JSON.stringify(c) !== JSON.stringify(curves[0]))) fail('нестандартная тоновая кривая.');
  let chad: number[] | undefined;
  const adaptation = tags.get('chad');
  if (adaptation) {
    if (adaptation.length !== 44 || text(adaptation, 0, 4) !== 'sf32') fail('неверная матрица адаптации.');
    chad = Array.from({ length: 9 }, (_, i) => fixed(adaptation, 8 + i * 4));
  }
  return { red, green, blue, ...(chad ? { chad } : {}), curve: curves[0]! };
}

function s15(value: number): number[] {
  const raw = Math.round(value * 65536);
  if (!Number.isFinite(raw) || raw < -0x80000000 || raw > 0x7fffffff) fail('значение вне диапазона.');
  return [(raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255];
}
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const ascii = (value: string) => Array.from(value, c => c.charCodeAt(0));

/** A minimal ICC v4 display profile from validated numbers. Deterministic: same numbers, same bytes. */
export function buildIcc(numbers: IccNumbers): Uint8Array {
  const name = 'Linea RGB', utf16 = Array.from(name).flatMap(c => [0, c.charCodeAt(0)]);
  const desc = [...ascii('mluc'), 0, 0, 0, 0, ...u32(1), ...u32(12), ...ascii('enUS'), ...u32(utf16.length), ...u32(28), ...utf16];
  const xyz = (v: [number, number, number]) => [...ascii('XYZ '), 0, 0, 0, 0, ...v.flatMap(s15)];
  const trc = numbers.curve.kind === 'srgb'
    ? [...ascii('para'), 0, 0, 0, 0, 0, 3, 0, 0, ...SRGB.flatMap(s15)]
    : [...ascii('para'), 0, 0, 0, 0, 0, 0, 0, 0, ...s15(numbers.curve.gamma)];
  const tags: [string, number[]][] = [
    ['desc', desc], ['wtpt', xyz([0.9642, 1, 0.8249])],
    ['rXYZ', xyz(numbers.red)], ['gXYZ', xyz(numbers.green)], ['bXYZ', xyz(numbers.blue)],
    ...(numbers.chad ? [['chad', [...ascii('sf32'), 0, 0, 0, 0, ...numbers.chad.flatMap(s15)]] as [string, number[]]] : []),
    ['rTRC', trc],
  ];
  const shared = ['gTRC', 'bTRC'];
  const tableEnd = 132 + (tags.length + shared.length) * 12;
  const body: number[] = [], table: number[] = [];
  let trcOffset = 0, trcSize = 0;
  for (const [tag, data] of tags) {
    while ((tableEnd + body.length) % 4) body.push(0);
    const offset = tableEnd + body.length;
    if (tag === 'rTRC') { trcOffset = offset; trcSize = data.length; }
    table.push(...ascii(tag), ...u32(offset), ...u32(data.length));
    body.push(...data);
  }
  for (const tag of shared) table.push(...ascii(tag), ...u32(trcOffset), ...u32(trcSize));
  while (body.length % 4) body.push(0);
  const size = tableEnd + body.length;
  const header = new Array(128).fill(0);
  header.splice(0, 4, ...u32(size));
  header.splice(8, 4, 4, 0x30, 0, 0);
  header.splice(12, 12, ...ascii('mntrRGB XYZ '));
  header.splice(24, 12, ...[2024, 1, 1, 0, 0, 0].flatMap(v => [(v >> 8) & 255, v & 255]));
  header.splice(36, 4, ...ascii('acsp'));
  header.splice(68, 12, ...[0.9642, 1, 0.8249].flatMap(s15));
  return new Uint8Array([...header, ...u32(tags.length + shared.length), ...table, ...body]);
}

/** Canonical numbers (as stored by buildIcc) so that rebuilding is idempotent. */
export function canonicalIcc(numbers: IccNumbers): IccNumbers {
  const round3 = (v: [number, number, number]) => v.map(roundFixed) as [number, number, number];
  return { red: round3(numbers.red), green: round3(numbers.green), blue: round3(numbers.blue), ...(numbers.chad ? { chad: numbers.chad.map(roundFixed) } : {}), curve: numbers.curve };
}
