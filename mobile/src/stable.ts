const plain = (v: object) => { const proto = Object.getPrototypeOf(v); return proto === Object.prototype || proto === null; };

/** Structural equality to a limited depth: `===` first, then plain objects/arrays key by key. Past the depth it says «different» (safe: only costs a re-render). */
export function sameValue(a: unknown, b: unknown, depth = 4): boolean {
  if (a === b) return true;
  if (depth <= 0 || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  // Only plain objects and arrays are compared by content: a Date, Map, Set or File has no own keys and would look equal.
  if (!Array.isArray(a) && (!plain(a) || !plain(b))) return false;
  if (Array.isArray(a)) { const y = b as unknown[]; return a.length === y.length && a.every((item, i) => sameValue(item, y[i], depth - 1)); }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every(key => key in y && sameValue(x[key], y[key], depth - 1));
}

/** Returns the previous object when the new one is structurally the same, so memoized children keep their props identity. */
export function reuse<T>(prev: T | undefined, next: T, depth = 5): T {
  return prev !== undefined && sameValue(prev, next, depth) ? prev : next;
}

/** Re-keys `next` through `cache` (id → previous object), reusing equal ones; the cache is replaced by the current ids only. */
export function stabilizeById<T>(cache: Map<string, T>, items: T[], idOf: (item: T) => string): T[] {
  const fresh = new Map<string, T>();
  const out = items.map(item => { const id = idOf(item); const kept = reuse(cache.get(id), item); fresh.set(id, kept); return kept; });
  cache.clear(); for (const [id, item] of fresh) cache.set(id, item);
  return out;
}
