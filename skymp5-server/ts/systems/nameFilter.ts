import * as fs from "fs";
import * as path from "path";

// Character names have to read like people in Tamriel, not like forum handles. The shape rules below
// are what rejected "xXPussyN'wahKpingItRealXx": capitals in the middle of a word. The word list and the
// limits live in server/name-filter.json so they can change without a rebuild.
//
// Uniqueness is NOT decided here: spawn.ts checks nameKey() against private.indexed.charName.

const RULES_FILE = "./name-filter.json";
const RELOAD_MS = 5000;

interface NameRules {
  maxWords: number;
  minLength: number;
  maxLength: number;
  maxRepeatedLetters: number;
  blocked: string[];
  reserved: string[];
}

const FALLBACK: NameRules = {
  maxWords: 3, minLength: 2, maxLength: 30, maxRepeatedLetters: 2, blocked: [], reserved: [],
};

let cache: NameRules | null = null;
let cacheMtime = 0;
let cacheCheckedAt = 0;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;

const rules = (): NameRules => {
  const now = Date.now();
  if (cache && now - cacheCheckedAt < RELOAD_MS) return cache;
  cacheCheckedAt = now;
  const p = path.resolve(RULES_FILE);
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { return cache ?? FALLBACK; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    cache = {
      maxWords: num(raw.maxWords, FALLBACK.maxWords),
      minLength: num(raw.minLength, FALLBACK.minLength),
      maxLength: num(raw.maxLength, FALLBACK.maxLength),
      maxRepeatedLetters: num(raw.maxRepeatedLetters, FALLBACK.maxRepeatedLetters),
      blocked: strings(raw.blocked),
      reserved: strings(raw.reserved),
    };
    cacheMtime = mtime;
  } catch {
    return cache ?? FALLBACK;
  }
  return cache;
};

// Folds the tricks people use to slip a word past a list: case, leetspeak and every separator.
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
  "@": "a", "$": "s", "!": "i", "|": "i",
};

const fold = (s: string): string =>
  s.toLowerCase().replace(/./gu, (c) => LEET[c] ?? c).replace(/[^\p{L}]/gu, "");

// The uniqueness key: case, spacing and punctuation folded away, so "C'had" cannot sit beside "Chad".
// Two different full names stay different, which is why "Chad Borick" and "Chad Floran" both stand.
export const nameKey = (name: string): string => fold(name);

export interface NameCheck { ok: boolean; error?: string }

const SHAPE_HELP = "Names read like a person from Tamriel: letters, up to three words, capitals only at the start of a word";

export const checkName = (name: string): NameCheck => {
  const r = rules();

  if (name.length < r.minLength || name.length > r.maxLength) {
    return { ok: false, error: `Names are ${r.minLength}-${r.maxLength} characters` };
  }
  if (/^[' -]|[' -]$/.test(name) || /[' -]{2}/.test(name)) {
    return { ok: false, error: "Names cannot start, end or run two separators together" };
  }

  const words = name.split(" ");
  if (words.length > r.maxWords) {
    return { ok: false, error: `Names are at most ${r.maxWords} words` };
  }

  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    return { ok: false, error: "Names are not written in capitals" };
  }

  const runs = new RegExp(`(\\p{L})\\1{${r.maxRepeatedLetters},}`, "u");
  if (runs.test(name.toLowerCase())) {
    return { ok: false, error: `No letter repeats more than ${r.maxRepeatedLetters} times in a row` };
  }

  // A capital is only allowed opening a word or straight after an apostrophe or hyphen, which keeps
  // "Flo'Riahn", "gro-Shatul" and "Snow-Hand" while refusing "xXPussyN'wahKpingItRealXx".
  for (const word of words) {
    if (!/^\p{L}/u.test(word)) return { ok: false, error: SHAPE_HELP };
    for (let i = 1; i < word.length; i++) {
      const c = word[i];
      if (c !== c.toUpperCase() || c === c.toLowerCase()) continue; // not a capital letter
      const before = word[i - 1];
      if (before !== "'" && before !== "-") return { ok: false, error: SHAPE_HELP };
    }
  }

  const folded = fold(name);
  for (const bad of r.blocked) {
    if (bad && folded.includes(bad)) return { ok: false, error: "That name will not do here. Choose one in keeping with the world" };
  }
  for (const taken of r.reserved) {
    if (taken && folded === taken) return { ok: false, error: "That name is reserved" };
  }

  return { ok: true };
};
