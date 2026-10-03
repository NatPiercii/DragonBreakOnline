// Beast form loadout choices for beastFormService.ts, import-free so a harness can drive it

export interface LoadoutEntry { id: number; shout?: number }

// The slot's new index: a form spell held there other than ourId (the service's last equip) was picked by the player
export function adoptHeld(list: LoadoutEntry[], chosen: number, heldId: number | null | undefined, ourId: number): number {
  if (!list.length || !heldId || (heldId >>> 0) === (ourId >>> 0)) return chosen;
  const i = list.findIndex((e) => !e.shout && (e.id >>> 0) === (heldId >>> 0));
  return i >= 0 ? i : chosen;
}
