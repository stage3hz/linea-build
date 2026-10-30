// Album mosaic (our own layout, Telegram-like result): items keep their order and are split into
// rows of 1–4; every row fills the width exactly, its height follows the aspect ratios in it.
// The split is chosen by dynamic programming so row heights stay close to a target and the
// whole album stays within `maxHeight`.

export type AlbumTile = { index: number; x: number; y: number; width: number; height: number };

export function albumLayout(aspects: number[], width: number, maxHeight: number, gap = 2): { tiles: AlbumTile[]; height: number } {
  const n = aspects.length;
  if (!n) return { tiles: [], height: 0 };
  const ratio = aspects.map(value => Math.max(0.4, Math.min(2.5, Number.isFinite(value) && value > 0 ? value : 1)));
  const target = n <= 2 ? width / 1.25 : n <= 4 ? width / 1.6 : width / 2.4;
  const rowHeight = (from: number, count: number) => (width - gap * (count - 1)) / ratio.slice(from, from + count).reduce((sum, value) => sum + value, 0);
  const best: { cost: number; rows: number[] }[] = new Array(n + 1);
  best[n] = { cost: 0, rows: [] };
  for (let i = n - 1; i >= 0; i--) {
    let choice: { cost: number; rows: number[] } | null = null;
    for (let count = 1; count <= Math.min(4, n - i); count++) {
      // A lone item in a row only for wide pictures (or when it is the only one).
      if (count === 1 && n > 1 && (ratio[i] < 1.2 || (n > 3 && ratio[i] < 1.8))) continue;
      const rest = best[i + count]; if (!rest) continue;
      const h = rowHeight(i, count);
      const cost = Math.log(h / target) ** 2 + rest.cost; // relative: too short and too tall rows weigh alike
      if (!choice || cost < choice.cost) choice = { cost, rows: [count, ...rest.rows] };
    }
    best[i] = choice || { cost: Infinity, rows: [Math.min(2, n - i), ...(best[i + Math.min(2, n - i)]?.rows || [])] };
  }
  let heights: number[] = []; let index = 0;
  for (const count of best[0].rows) { heights.push(rowHeight(index, count)); index += count; }
  const total = heights.reduce((sum, value) => sum + value, 0) + gap * (heights.length - 1);
  if (total > maxHeight) { const scale = (maxHeight - gap * (heights.length - 1)) / (total - gap * (heights.length - 1)); heights = heights.map(value => value * scale); }
  const tiles: AlbumTile[] = []; let y = 0; index = 0;
  best[0].rows.forEach((count, row) => {
    const h = heights[row]; const sum = ratio.slice(index, index + count).reduce((a, b) => a + b, 0);
    let x = 0;
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      const w = last ? width - x : Math.round((width - gap * (count - 1)) * ratio[index + k] / sum);
      tiles.push({ index: index + k, x, y, width: w, height: Math.round(h) });
      x += w + gap;
    }
    y += Math.round(h) + gap; index += count;
  });
  return { tiles, height: y - gap };
}
