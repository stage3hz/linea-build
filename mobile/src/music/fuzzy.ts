// Typo-tolerant music search. Audius only matches the exact spelling, so when a
// query finds little we also try a few likely spellings and rank the merged
// results by how close the title/artist is to what the user typed.

const SWAPS: Record<string, string[]> = {
  a: ['e', 'o'], e: ['a', 'i'], i: ['e', 'y', '1'], o: ['a', '0', 'u'], u: ['o', 'y'], y: ['i', 'u'],
  '1': ['i', 'l'], '0': ['o'], '3': ['e'], '4': ['a'], l: ['1'], k: ['c'], c: ['k'], s: ['z'], z: ['s'],
};
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const normalizeSearch = (value: string) => value.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const transliterate = (value: string) => [...value.toLocaleLowerCase('ru')].map(char => CYRILLIC[char] ?? char).join('');

/** A handful of likely alternative spellings, most likely first, without the original. */
export function spellingVariants(query: string, max = 8): string[] {
  const base = normalizeSearch(query);
  if (!base || base.length > 60) return [];
  const out: string[] = [];
  const push = (value: string) => { const v = value.trim(); if (v && v !== base && !out.includes(v)) out.push(v); };
  if (/[а-яё]/i.test(base)) push(transliterate(base));
  const compact = base.replace(/\s+/g, '');
  if (compact !== base) push(compact);
  // One substitution at a time keeps the number of requests small.
  const chars = [...base];
  chars.forEach((char, index) => {
    for (const swap of SWAPS[char] || []) push([...chars.slice(0, index), swap, ...chars.slice(index + 1)].join(''));
  });
  // Doubled letters typed once or twice («mmadkid» / «madkid»).
  chars.forEach((char, index) => { if (char === chars[index + 1]) push([...chars.slice(0, index), ...chars.slice(index + 1)].join('')); });
  return out.slice(0, max);
}

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent swaps). */
export function editDistance(a: string, b: string): number {
  const x = [...a], y = [...b];
  const d = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) {
    const cost = x[i - 1] === y[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[x.length][y.length];
}

/** 0…1, higher means the text contains words close to the query words. */
export function similarity(query: string, text: string): number {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  const target = normalizeSearch(text).split(' ').filter(Boolean);
  const translit = target.map(transliterate);
  if (!words.length || !target.length) return 0;
  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const candidate of [...target, ...translit]) {
      const distance = editDistance(word, candidate.slice(0, word.length + 2));
      best = Math.max(best, 1 - distance / Math.max(word.length, 1));
    }
    total += Math.max(0, best);
  }
  return total / words.length;
}

/** Merges result lists (exact query first), drops duplicates and sorts by closeness. */
export function mergeRanked<T extends { id: string; title: string; artist: string }>(query: string, lists: T[][], minimum = 0.5): T[] {
  const seen = new Set<string>();
  const scored: { item: T; score: number; order: number }[] = [];
  lists.forEach((list, listIndex) => list.forEach((item, index) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    const score = Math.max(similarity(query, item.title), similarity(query, item.artist), similarity(query, `${item.artist} ${item.title}`));
    // Exact-spelling results are always kept; variant results only when close enough.
    if (listIndex > 0 && score < minimum) return;
    scored.push({ item, score: score + (listIndex === 0 ? 0.25 : 0), order: listIndex * 1000 + index });
  }));
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map(entry => entry.item);
}
