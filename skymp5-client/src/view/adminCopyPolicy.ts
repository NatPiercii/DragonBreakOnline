// Whether a watcher keeps a local copy of a player hidden by ff_adminModes.invis (an Invisible admin, character creation).
// A copy at alpha 0 still ran its animation graph, so its foot events played footstep sounds, and it still had a body.
// The copy returns only after REVEAL_HOLD_MS un-hidden, so a mirror rewritten for a moment does not spawn and delete one.
// No imports, so tests/invisquiet-harness.js can transpile and drive it.

export type AdminView = "visible" | "hidden" | "ghost";

export const REVEAL_HOLD_MS = 1500;

/** The moment the player was last seen hidden: now while hidden, otherwise unchanged. */
export function nextHiddenAt(view: AdminView, lastHiddenAt: number, now: number): number {
  return view === "hidden" ? now : lastHiddenAt;
}

/** True while the watcher should keep no copy: hidden now, or un-hidden for less than REVEAL_HOLD_MS. */
export function keepNoCopy(view: AdminView, lastHiddenAt: number, now: number): boolean {
  if (view === "hidden") return true;
  return lastHiddenAt > 0 && now - lastHiddenAt < REVEAL_HOLD_MS;
}
