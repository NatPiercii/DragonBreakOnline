// Fuzzy matching for the admin panel's searches (F3 design 3.10): every word of the query must be found in the text,
// whole or as letters in order. A word found whole at the start of a word scores best, then anywhere, then spread out.
// 0 means no match; higher is better.

const wordScore = (word: string, hay: string): number => {
  const at = hay.indexOf(word);
  if (at === 0) return 100;
  if (at > 0) return /[\s_:.\-(]/.test(hay[at - 1]) ? 90 : 70;
  // Letters in order: the tighter they sit, the better
  let i = 0, first = -1, last = -1;
  for (let k = 0; k < hay.length && i < word.length; k++) {
    if (hay[k] === word[i]) { if (first < 0) first = k; last = k; i++; }
  }
  if (i < word.length) return 0;
  const spread = last - first + 1 - word.length;
  return Math.max(1, 40 - spread);
};

export const fuzzyScore = (query: string, hay: string): number => {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const h = String(hay || '').toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, h);
    if (!s) return 0;
    total += s;
  }
  return total / words.length;
};

// The rows that match, best first; ties keep the list's own order
export function fuzzyFilter<T>(rows: T[], query: string, hayOf: (row: T) => string): T[] {
  if (!String(query || '').trim()) return rows;
  const scored: Array<{ row: T; score: number; i: number }> = [];
  rows.forEach((row, i) => { const score = fuzzyScore(query, hayOf(row)); if (score) scored.push({ row, score, i }); });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.row);
}
