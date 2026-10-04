// How loud a voice is at a distance: 0..1 from the listener's distance d and the range r of the speaker's mode (game units,
// 70 per metre: whisper 140, talk 840, shout 3150 by default). Pure, so a harness can run it.
//
// Full volume out to a fifth of the range (a metre at least), then the inverse-distance law sound follows, then the last
// quarter of the range fades to nothing so a voice thins out instead of cutting off. The old curve's full-volume core was
// 8% of the range, at least 70: a metre for talk, so talk at 3 m was a quarter as loud as shout (#bugs, 4 Oct: "normal talk
// is like whispering, yelling is like normal talking"). Now each mode carries as far as its range says.
export const CORE_FRACTION = 0.2;
export const MIN_CORE = 70;
export const EDGE = 0.25;

export const voiceFalloff = (d, r) => {
  if (!(r > 0) || !(d >= 0) || d > r) return 0;
  const core = Math.max(MIN_CORE, r * CORE_FRACTION);
  let g = d <= core ? 1 : core / d;
  const t = d / r;
  if (t > 1 - EDGE) g *= Math.max(0, (1 - t) / EDGE);
  return g;
};
