// Small counts in words, for panels that speak in the world's voice rather than in numbers
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

export const countWord = (n: number): string => {
  const k = Math.max(0, Math.floor(n));
  return k < WORDS.length ? WORDS[k] : String(k);
};

export const capitalise = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
