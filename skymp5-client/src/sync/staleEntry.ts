// Stale entries in the client's form array (LHF/Tarhiel, 10 Oct: his old character's body stood for hours after a character
// switch, and his blows reached it). The character select detaches the player from his character without a destroy, so the
// old character's entry stays; when the body is streamed back under the same idx, IdManager.allocateIdFor gives it a second
// slot and orphans the first, and the despawn frees only the second. No imports, so tests/stale-entry-harness.js runs it
// with the real IdManager.

export interface StaleIds { getId(value: number): number; getValueById(id: number): number | undefined; freeIdFor(value: number): void }
export interface StaleModel { forms: Array<{ refrId?: number } | undefined>; playerCharacterFormIdx: number; playerCharacterRefrId: number }

// Clears the entry idx points to, as a destroy would; returns the refrId it held (0: none, -1: no entry)
export function dropStaleEntry(model: StaleModel, ids: StaleIds, idx: number): number {
  const stale = ids.getId(idx);
  if (stale < 0) return -1;
  const old = model.forms[stale];
  model.forms[stale] = undefined;
  // The old character's body streamed back before the new character's isMe: it is no longer this client's own
  if (model.playerCharacterFormIdx === stale) {
    model.playerCharacterFormIdx = -1;
    model.playerCharacterRefrId = 0;
  }
  ids.freeIdFor(idx);
  return old?.refrId ?? 0;
}

// The previous own character's idx when a new one (at slot i, idx newIdx) becomes the player's, or undefined
export function previousOwnIdx(model: StaleModel, ids: StaleIds, i: number, newIdx: number): number | undefined {
  const prev = model.playerCharacterFormIdx;
  if (prev < 0 || prev === i) return undefined;
  const prevIdx = ids.getValueById(prev);
  return typeof prevIdx === "number" && prevIdx !== newIdx ? prevIdx : undefined;
}
