// Chat bubbles without engine calls: packet, wrapping, fading and stacking (chatBubbleService draws them)
// Server -> client: { customPacketType: "dboBubble", from: <server actor id>, text, color: "rrggbb", rangeM }
// Chat settings: chatBubbles (default on), bubbleSize (30..100, default 55)

import { hidesIdentity, IdentityFacts } from "../../view/identityGate";

export interface BubblePacket {
  from: number;
  text: string;
  color: number[];
  rangeM: number;
}

export interface BubbleSettings {
  on: boolean;
  size: number;
}

export interface BubbleLine {
  text: string;
  color: number[];
  alpha: number;
  // Pixels from the bottom of the stack to the line's centre
  up: number;
}

export const BUBBLE_TYPE = "dboBubble";
export const MAX_CHARS_PER_LINE = 38;
export const MAX_LINES_PER_BUBBLE = 3;
export const MAX_BUBBLES_PER_SPEAKER = 3;
export const MAX_LINES_PER_SPEAKER = 6;
export const FADE_MS = 1000;
export const MIN_TTL_MS = 5000;
export const MAX_TTL_MS = 12000;
export const DEFAULT_SIZE_PERCENT = 55;
// Tavern.spritefont's line spacing is 67.7 px at size 1; bubble lines sit a little tighter
export const LINE_PX_AT_SIZE_1 = 60;

// The live settings; chatService writes them whenever the chat settings are read or saved
export const bubbleSettings: BubbleSettings = { on: true, size: DEFAULT_SIZE_PERCENT / 100 };

export const applyBubbleSettings = (parsed: Record<string, unknown> | null | undefined): BubbleSettings => {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  bubbleSettings.on = p["chatBubbles"] !== false;
  const pct = Number(p["bubbleSize"]);
  bubbleSettings.size = (Number.isFinite(pct) ? Math.min(100, Math.max(30, Math.round(pct))) : DEFAULT_SIZE_PERCENT) / 100;
  return bubbleSettings;
};

// Tavern.spritefont has ASCII and Cyrillic only and draws "?" for anything else, so accents and typographic quotes fold
const FOLD: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-", "\u2026": "..." };

const nfd = (t: string): string => { try { return t.normalize("NFD"); } catch { return t; } };

const cleanText = (raw: unknown): string =>
  nfd(String(raw ?? ""))
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026]/g, (c) => FOLD[c])
    .replace(/#\{[0-9a-fA-F]{6}\}/g, "")
    // Controls and the bidi/zero-width marks a line could hide behind
    .replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

// A dark chat colour (the shout's 772021) is unreadable over the world: mix it with white until it is bright enough
export const bubbleColor = (hex: unknown): number[] => {
  const h = typeof hex === "string" && /^[0-9a-fA-F]{6}$/.test(hex) ? hex : "fafafa";
  let rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const MIN = 0.45;
  const l = lum(rgb);
  if (l < MIN) {
    const t = (MIN - l) / (1 - l);
    rgb = rgb.map((c) => c + (1 - c) * t);
  }
  return rgb.map((c) => Math.round(c * 1000) / 1000);
};

export const readBubblePacket = (content: Record<string, unknown> | null | undefined): BubblePacket | null => {
  if (!content || content["customPacketType"] !== BUBBLE_TYPE) return null;
  const from = Number(content["from"]);
  if (!Number.isFinite(from) || from <= 0) return null;
  const text = cleanText(content["text"]);
  if (!text) return null;
  const range = Number(content["rangeM"]);
  return { from: from >>> 0, text, color: bubbleColor(content["color"]), rangeM: Number.isFinite(range) && range > 0 ? Math.min(range, 200) : 20 };
};

// Word wrap into at most maxLines lines; a word longer than a line is cut; anything left over ends the last line with "..."
export const wrapBubble = (text: string, maxChars = MAX_CHARS_PER_LINE, maxLines = MAX_LINES_PER_BUBBLE): string[] => {
  // Words longer than a line are cut into line-sized pieces first
  const pieces: string[] = [];
  for (const w of cleanText(text).split(" ")) {
    if (!w) continue;
    for (let i = 0; i < w.length; i += maxChars) pieces.push(w.slice(i, i + maxChars));
  }
  const lines: string[] = [];
  let cur = "";
  let used = 0;
  for (; used < pieces.length; used++) {
    const next = cur ? `${cur} ${pieces[used]}` : pieces[used];
    if (next.length <= maxChars) { cur = next; continue; }
    lines.push(cur);
    cur = "";
    if (lines.length === maxLines) break;
    cur = pieces[used];
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (used < pieces.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = (last.length > maxChars - 3 ? last.slice(0, maxChars - 3) : last) + "...";
  }
  return lines;
};

// Longer lines stay up longer: 4 s plus 60 ms a character, between 5 and 12 s
export const ttlMs = (text: string): number => Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, 4000 + 60 * text.length));

// Full until the last second, then fading to nothing
export const alphaAt = (now: number, bornAt: number, ttl: number): number => {
  const left = bornAt + ttl - now;
  if (left <= 0) return 0;
  if (left >= FADE_MS) return 1;
  return Math.round((left / FADE_MS) * 1000) / 1000;
};

export const lineHeightPx = (size: number): number => Math.max(12, Math.round(LINE_PX_AT_SIZE_1 * size));

interface Bubble { lines: string[]; color: number[]; bornAt: number; ttl: number }
interface Speaker { bubbles: Bubble[]; rangeM: number }

export interface SpeakerFacts {
  mine: boolean;
  loaded: boolean;
  inRange: boolean;
  inSight: boolean;
  // The nametag's gates (FormView.identityFacts); null when the speaker has no view
  identity: IdentityFacts | null;
}

// Sneaking does not hide a bubble: speaking aloud gives you away, and the chat line already names you
export const bubbleShows = (f: SpeakerFacts): boolean => {
  if (!f.loaded) return false;
  if (f.mine) return true;
  return f.inRange && f.inSight && !!f.identity && !hidesIdentity(f.identity);
};

// Every speaker's bubbles, newest last, keyed by the server actor id
export class BubbleBoard {
  add(p: BubblePacket, now: number): void {
    const s = this.speakers.get(p.from) || { bubbles: [], rangeM: p.rangeM };
    s.rangeM = p.rangeM;
    s.bubbles.push({ lines: wrapBubble(p.text), color: p.color, bornAt: now, ttl: ttlMs(p.text) });
    while (s.bubbles.length > MAX_BUBBLES_PER_SPEAKER) s.bubbles.shift();
    this.speakers.set(p.from, s);
  }

  expire(now: number): void {
    this.speakers.forEach((s, id) => {
      s.bubbles = s.bubbles.filter((b) => now < b.bornAt + b.ttl);
      if (!s.bubbles.length) this.speakers.delete(id);
    });
  }

  clear(): void {
    this.speakers.clear();
  }

  ids(): number[] {
    const out: number[] = [];
    this.speakers.forEach((_s, id) => out.push(id));
    return out;
  }

  rangeOf(id: number): number {
    const s = this.speakers.get(id);
    return s ? s.rangeM : 0;
  }

  get size(): number {
    return this.speakers.size;
  }

  // Bottom line first: the newest bubble sits lowest and the oldest lines drop past MAX_LINES_PER_SPEAKER
  linesFor(id: number, now: number, lineH: number): BubbleLine[] {
    const s = this.speakers.get(id);
    if (!s) return [];
    const out: BubbleLine[] = [];
    for (let b = s.bubbles.length - 1; b >= 0 && out.length < MAX_LINES_PER_SPEAKER; b--) {
      const bub = s.bubbles[b];
      const alpha = alphaAt(now, bub.bornAt, bub.ttl);
      if (alpha <= 0) continue;
      for (let l = bub.lines.length - 1; l >= 0 && out.length < MAX_LINES_PER_SPEAKER; l--) {
        out.push({ text: bub.lines[l], color: bub.color, alpha, up: out.length * lineH + Math.round(lineH / 2) });
      }
    }
    return out;
  }

  private speakers = new Map<number, Speaker>();
}
