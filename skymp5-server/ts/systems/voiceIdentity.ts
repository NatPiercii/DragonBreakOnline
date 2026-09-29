// The LiveKit identity a player publishes under, and the map a listener needs to resolve its peers.
//
// THE SCHEME. Until 2026-09-29 the identity was the player's server-side actor id in hex. Actor ids for players are
// dynamic (0xff...) and reassigned every session, so a player who crashed and rejoined came back as a DIFFERENT
// LiveKit participant while the old one was still in the room: a crashed client never sends a clean disconnect, and
// there is no admin API here to evict it, so it lingers until its token expires. Listeners key their audio elements
// on identity, so they held one element for the ghost and one for the new arrival and played both - one player heard
// twice (Jake's #bug 2026-09-29 15:06, after Onny crashed at 15:02:33 and rejoined at 15:03:55).
//
// The identity is now the PROFILE id, which is stable across sessions. LiveKit disconnects an existing participant
// when a second one joins with the same identity, so a reconnecting player now evicts its own ghost and no cleanup
// on our side is needed - which matters, because we have no way to do that cleanup.
//
// MIXED VERSIONS. The server build and the client package do not land together. The identity a player publishes under
// is seen by every listener, so it cannot be varied per listener: instead a client states that it understands the new
// scheme (caps.identityV2), and only those players get a profile identity. Listeners that understand it are sent a
// map from actor id to identity and translate their peer distances through it; everything not in the map is still
// keyed by actor id hex, which is exactly what an old-scheme peer publishes under. So a new client is correct about
// both kinds of peer, and an old client is correct about old-scheme peers and falls back to its default range for the
// rest - a normal talking range, never full volume.
//
// The "p" prefix keeps the two namespaces apart: an actor id in hex is always [0-9a-f]+ and can never start with "p".

export interface VoicePlayer {
  actorId: number;
  profileId: number;
  supportsV2: boolean;
}

export function actorKey(actorId: number): string {
  return (actorId >>> 0).toString(16);
}

/** The identity this player publishes under. Profile-based only when the client said it understands that. */
export function voiceIdentity(player: VoicePlayer): string {
  const profileId = Number(player.profileId);
  if (player.supportsV2 && Number.isFinite(profileId) && profileId > 0) {
    return `p${Math.floor(profileId)}`;
  }
  return actorKey(player.actorId);
}

/**
 * actor id hex -> identity, for the listeners that asked for it. Only players whose identity differs from their
 * actor key are listed: a room with no new-scheme clients in it sends an empty map, and a listener that finds no
 * entry falls back to the actor key, which is correct for every old-scheme peer.
 */
export function buildIdentityMap(players: VoicePlayer[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const player of players) {
    if (!player || !player.actorId) continue;
    const key = actorKey(player.actorId);
    const identity = voiceIdentity(player);
    if (identity !== key) map[key] = identity;
  }
  return map;
}
