// Confidence of a server-driven NPC copy. 0.3.85 (39cd30d32) made every copy Foolhardy (Confidence 4), so a hosted NPC
// never runs its flee package: that package crashed hosts mid-fight (SkyrimSE+0783642, MovementControllerNPC, 8-9 Oct).
// 0.3.90 (d88ddb75) let "passive animals" keep their own confidence so prey runs again (Nate, 9 Oct: rabbits, deer and
// foxes fought back), but it judged passive by Aggression 0 alone. Most predators are Aggression 0 in their records too
// (they fight through their factions): Bruma's own wolf, CYREncWolf (BSHeartland 03C86), is Aggression 0, Confidence 3
// (Brave), so it was let flee again, back onto the crashing package. Only an animal whose own record is Cowardly (0) or
// Cautious (1) keeps it: the deer, foxes, hares, elk, wild goats, cows and chickens of wildlife.json are all Aggression 0
// with Confidence 0, the domestic goat 1 (AIDT read from Skyrim.esm and BSHeartland.esm, 11 Oct). Everything else,
// people and every hostile, stays Foolhardy.

export const FOOLHARDY = 4;
// The highest own Confidence that still counts as prey (1 = Cautious)
export const PREY_CONFIDENCE_MAX = 1;

export interface CopyTraits {
  playerCopy: boolean;   // the copy has an appearance: a player's character
  hostile: unknown;      // the server's ff_hostile flag
  companion: unknown;    // ff_companionOf
  person: boolean;       // ActorTypeNPC
  aggression: number;    // the copy's own Aggression, read before anything raises it
  confidence: number;    // the copy's own Confidence, read before the Foolhardy write
}

// true: leave the copy's own confidence alone, so it flees as in the base game
export const keepsOwnConfidence = (t: CopyTraits): boolean =>
  !t.playerCopy && t.hostile !== true && !t.companion && !t.person
  && t.aggression === 0 && Number.isFinite(t.confidence) && t.confidence >= 0 && t.confidence <= PREY_CONFIDENCE_MAX;
