// Local verdicts for the mini-games the widget judges on its own clock (judge 'client', SERVER_AUTHORITY.md migration 7).
// Each function must stay identical to the server's replay of the same game, which checks the widget's numbers with it.

export type Span = [number, number];

export interface PrayerVerdict {
  win: boolean;
  why: 'held' | 'released' | 'slow';
  worst: number;
}

// Mirrors judge() in server prayer.js: the first press within startGraceMs, then the worst uncovered verse within slackMs
export const prayerVerdict = (verses: Array<{ startMs: number; endMs: number }>, spans: Span[], slackMs: number, startGraceMs: number): PrayerVerdict => {
  const first = spans.length ? spans[0][0] : Infinity;
  let worst = 0;
  if (Number.isFinite(first)) {
    verses.forEach((v, i) => {
      const from = i === 0 ? Math.max(v.startMs, first) : v.startMs;
      let inside = 0;
      for (const [down, up] of spans) inside += Math.max(0, Math.min(up, v.endMs) - Math.max(down, from));
      worst = Math.max(worst, (v.endMs - from) - inside);
    });
  }
  if (first > startGraceMs) return { win: false, why: 'slow', worst };
  return worst > slackMs ? { win: false, why: 'released', worst } : { win: true, why: 'held', worst };
};

// Mirrors the landed test in server lockpick.js: the set falls while the tumbler hangs, give or take graceMs
export const lockpickLanded = (pushMs: number, setMs: number, riseMs: number, holdMs: number, graceMs: number): boolean => {
  const held = setMs - pushMs;
  return Number.isFinite(held) && held >= riseMs - graceMs && held <= riseMs + holdMs + graceMs;
};

// Mirrors markerAt() in server supernatural.js: 0..1 along the bar at t ms into the round
export const riteMarkerAt = (period: number, t: number): number => {
  const ph = (((t % period) + period) % period) / period;
  return ph < 0.5 ? ph * 2 : 2 - ph * 2;
};

// A press hits when the marker is in the zone at any whole millisecond within graceMs of the frame it was pressed on
export const riteHit = (period: number, center: number, width: number, pressMs: number, graceMs: number): boolean => {
  const inZone = (t: number): boolean => Math.abs(riteMarkerAt(period, t) - center) <= width / 2;
  if (inZone(pressMs)) return true;
  for (let d = 1; d <= graceMs; d++) if (inZone(pressMs - d) || inZone(pressMs + d)) return true;
  return false;
};
