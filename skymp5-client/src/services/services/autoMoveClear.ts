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
// The evidence that a player is auto-moving: they are moving, no movement key is held, and they are not airborne.
// Two samples a moment apart are required because the dangerous false positive is TRANSIENT motion with no key held -
// a fall, a slide, a shove. Those pass one sample and fail the next; auto-move is sustained.
//
// Kept free of imports so tests/automove-harness.js can drive it.

// struggle.js sends the labour widget with kind 'struggle', so these two cover all three mini-games
export const MINIGAME_WIDGETS = ['labour', 'skinning'];

export interface MoveSample {
  speed: number;            // SpeedSampled; 0 standing, ~150 walking, ~350 running
  movementKeyHeld: boolean; // any of the mapped movement keys physically down
  airborne: boolean;        // bInJumpState: jumping or falling
}

/** SpeedSampled is noisy around zero, so "moving" is a small step above it rather than > 0. */
export const MOVING_SPEED = 5;

export function isMinigameWidget(type: unknown): boolean {
  return typeof type === 'string' && MINIGAME_WIDGETS.indexOf(type) >= 0;
}

/** One sample looks like auto-move: moving, nothing held, feet on the ground. */
export function looksAutoMoving(s: MoveSample): boolean {
  return s.speed > MOVING_SPEED && !s.movementKeyHeld && !s.airborne;
}

/**
 * True only when every sample looks like auto-move and there are at least two of them. Fewer samples, any sample with a
 * movement key held, any airborne sample, or any sample at rest means no tap: leaving auto-move alone costs the player
 * one awkward round, and tapping wrongly hands them the same bug they did not have.
 */
export function shouldClearAutoMove(widgetType: unknown, samples: MoveSample[]): boolean {
  if (!isMinigameWidget(widgetType)) return false;
  if (!Array.isArray(samples) || samples.length < 2) return false;
  return samples.every(looksAutoMoving);
}
