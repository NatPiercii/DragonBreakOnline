// Should the client switch Skyrim's auto-move off because a mini-game just took the keyboard?
//
// GroundedPasta, #bugs 2026-09-30 ~04:15Z: "I was skinning an animal and I accidentally was auto running and it locked
// me into running". The skinning, mining/chopping and struggle widgets all open with focus (gamemode.js skinPacket,
// labour.js, struggle.js, which draws through the labour widget), so CEF holds the keyboard for the round and the
// Auto-Move key - 0x2e in our shipped controlmap - cannot reach the game. A player already auto-moving keeps running
// with no way to stop until the round ends.
//
// There is no API that reads the auto-move toggle, so the tap has to be earned from evidence, never sent blind: a blind
// tap would switch auto-run ON for everyone who was not using it, which is worse than the bug.
//
// The evidence that a player is auto-moving: they are moving at travelling speed, no movement key is held, they are
// not airborne, and the speed is not falling away. Several samples a moment apart are required because the dangerous
// false positives are all TRANSIENT motion with no key held, and each needs a different part of the test:
//   a fall or a shove              - caught by airborne, and by the decay test as it lands
//   STOPPING (Worker D, 2026-09-30) - the ordinary way into these games is to walk up, release the key and press E, so
//     every player arrives mid-stop. SpeedSampled is the graph's damped speed, so a run-stop is still well above zero
//     when the widget opens ~100-150 ms after E and can stay there across two samples. It is caught by the walking
//     floor and by the decay test: a stop decays, auto-move holds its speed. Nobody has measured that decay curve,
//     which is why the test is "not falling" rather than a timing guess.
//
// Kept free of imports so tests/automove-harness.js can drive it.

// struggle.js sends the labour widget with kind 'struggle', so these two cover all three mini-games
export const MINIGAME_WIDGETS = ['labour', 'skinning'];

export interface MoveSample {
  speed: number;            // SpeedSampled; 0 standing, ~150 walking, ~350 running
  movementKeyHeld: boolean; // any of the mapped movement keys physically down
  airborne: boolean;        // bInJumpState: jumping or falling
}

/**
 * The floor for "travelling under your own steam". Auto-walk is about 150 and auto-run about 350, so 60 sits well
 * below either and well above the tail of a stop. It is deliberately NOT a small step above zero: near zero is where
 * a decelerating stop lives, and that is the case a wrong tap hurts.
 */
export const MOVING_SPEED = 60;

/**
 * How much speed may be lost and still count as held, applied BOTH between neighbouring samples and across the whole
 * window. Both are needed: step by step alone lets a slow stop through (350, 330, 300 loses a tenth overall while no
 * single step does), and end to end alone lets a dip and a recovery through (350, 100, 350).
 */
export const DECAY_RATIO = 0.9;

export function isMinigameWidget(type: unknown): boolean {
  return typeof type === 'string' && MINIGAME_WIDGETS.indexOf(type) >= 0;
}

/** One sample looks like auto-move: travelling, nothing held, feet on the ground. */
export function looksAutoMoving(s: MoveSample): boolean {
  return s.speed > MOVING_SPEED && !s.movementKeyHeld && !s.airborne;
}

/** The speed held up from one sample to the next. */
export function speedHeld(prev: MoveSample, next: MoveSample): boolean {
  return next.speed >= DECAY_RATIO * prev.speed;
}

/**
 * Whether a run so far could still end in a tap, so the service can stop sampling the moment it cannot. The same rule
 * as shouldClearAutoMove without the "enough samples yet" part.
 */
export function stillPlausible(samples: MoveSample[]): boolean {
  if (!Array.isArray(samples) || !samples.length) return false;
  if (!samples.every(looksAutoMoving)) return false;
  if (!samples.every((s, i) => i === 0 || speedHeld(samples[i - 1], s))) return false;
  return speedHeld(samples[0], samples[samples.length - 1]);
}

/**
 * True only when there are at least two samples, every one of them looks like auto-move, and none has lost speed
 * against the one before it. Anything else means no tap: leaving auto-move alone costs the player one awkward round,
 * and tapping wrongly hands them the same bug they did not have.
 */
export function shouldClearAutoMove(widgetType: unknown, samples: MoveSample[]): boolean {
  if (!isMinigameWidget(widgetType)) return false;
  if (!Array.isArray(samples) || samples.length < 2) return false;
  return stillPlausible(samples);
}
