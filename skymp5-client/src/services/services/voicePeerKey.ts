// Which LiveKit identity a peer is publishing under, from the actor id this client already knows.
//
// The server mints a profile-based identity ("p<n>") for clients that said they understand it (caps.identityV2), and
// keeps the old actor-id hex for those that did not, because the server build and the client package do not land at
// the same moment. A player publishes under ONE identity that every listener sees, so it cannot be varied per
// listener: instead the server sends this client a map of actor id hex -> identity, listing only the players whose
// identity differs from their actor id.
//
// So the rule is: use the map when it has the peer, otherwise the actor id hex - which is exactly what an
// old-scheme peer publishes under. That makes this client correct about both kinds of peer, and correct again once
// every client has updated and the map covers everyone.
//
// Getting this wrong is not cosmetic: the key carries the distance, and a peer whose key does not match any
// participant falls back to the browser's default range rather than the range the speaker chose.
//
// Kept free of imports so tests/voicepeerkey-harness.js can drive it, as badMenuPolicy.ts does.

export type IdentityMap = Record<string, string>;

/** Accepts only a flat string->string object; anything else becomes an empty map rather than a half-trusted one. */
export function parseIdentityMap(raw: unknown): IdentityMap {
  const map: IdentityMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && key && typeof value === "string" && value) map[key] = value;
  }
  return map;
}

/** The identity to key this peer's distance by. `actorIdHex` is the peer's refrId in hex, lower case. */
export function peerKey(actorIdHex: string, map: IdentityMap | null | undefined): string {
  if (map) {
    const mapped = map[actorIdHex];
    if (typeof mapped === "string" && mapped) return mapped;
  }
  return actorIdHex;
}
