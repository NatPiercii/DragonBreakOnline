import * as crypto from "crypto";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Proximity voice chat (LiveKit) ───────────────────────────────────────────
//
// The client asks for a room token after login; the server mints a LiveKit HS256 access token. The identity it carries
// is the player's PROFILE id ("p<n>") for a client that says it understands that, and the server-side actor id in hex
// for one that does not - voiceIdentity.ts holds the scheme and the reason (a rejoining player must evict its own
// ghost, or listeners hear it twice).
// Clients already know every remote player's refrId, so they match LiveKit participants to actors and gate volume by
// distance; server-side minting means identities cannot be spoofed.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "voiceTokenRequest", caps?: { identityV2: true } }
//   Server -> Client: { customPacketType: "voiceToken", enabled, url?, token?,
//                       room?, identity?, rangeUnits?, identityMap? }
//   Server -> Client: { customPacketType: "voiceIdentityMap", identityMap }   when the room's players change
// identityMap is actor id hex -> identity, sent only to clients that asked for it, and lists only the players whose
// identity differs from their actor id. Anything absent is keyed by actor id hex, which is what an old client
// publishes under, so a new client is right about both kinds of peer.
//
// Settings (server-settings.json "voiceChat" object):
//   { "enabled": true, "url": "ws://host:7880", "apiKey": "...",
//     "apiSecret": "...", "room": "dragonbreak", "rangeUnits": 2000 }
// rangeUnits falls back to chatRanges.say, then 2000 game units.

// Short on purpose: LiveKit refreshes tokens over live connections, and a kicked/banned player's credential dies with the TTL (no admin-API revocation)
const TOKEN_TTL_SECONDS = 60 * 60;

function b64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString("base64url");
}

import { VoicePlayer, actorKey, buildIdentityMap, voiceIdentity } from "./voiceIdentity";

// How many user slots to scan when listing who is online (adminSystem uses the same bound).
const MAX_USER_SLOTS = 1000;

// Hand-minted LiveKit access token; the payload shape matches livekit-server-sdk.
function mintLiveKitToken(apiKey: string, apiSecret: string, identity: string, room: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: identity,
    jti: identity,
    iat: now,
    nbf: now - 10,
    exp: now + TOKEN_TTL_SECONDS,
    name: identity,
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export class VoiceSystem implements System {
  systemName = "VoiceSystem";
  constructor(private log: Log) { }

  private enabled = false;
  // Users whose client said it understands profile identities (caps.identityV2 in the token request).
  private v2Users = new Set<number>();
  // Each mint also sends the identity map to every voice player; the client asks every 5 s at most
  private lastMintAt = new Map<number, number>();
  private static readonly MINT_COOLDOWN_MS = 2000;
  private url = "";
  private apiKey = "";
  private apiSecret = "";
  private room = "dragonbreak";
  // Voice modes cycled in-game with Alt+V; units are game units (70 per meter): whisper 2m, talk 12m, shout 45m by default
  private modes: Array<{ key: string; label: string; units: number }> = [
    { key: "whisper", label: "Whisper", units: 140 },
    { key: "talk", label: "Talk", units: 840 },
    { key: "shout", label: "Shout", units: 3150 },
  ];

  async initAsync(_ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const vc = all?.["voiceChat"];
    if (!vc || typeof vc !== "object") {
      this.log("VoiceSystem: no voiceChat settings, voice disabled");
      return;
    }
    this.url = typeof vc.url === "string" ? vc.url : "";
    this.apiKey = typeof vc.apiKey === "string" ? vc.apiKey : "";
    this.apiSecret = typeof vc.apiSecret === "string" ? vc.apiSecret : "";
    if (typeof vc.room === "string" && vc.room) this.room = vc.room;

    // Optional override: voiceChat.modes = [{ key, label, meters }]
    if (Array.isArray(vc.modes) && vc.modes.length) {
      const parsed: Array<{ key: string; label: string; units: number }> = [];
      for (const m of vc.modes) {
        const key = String(m?.key ?? "");
        const meters = Number(m?.meters);
        const units = Number.isFinite(meters) && meters > 0 ? meters * 70 : Number(m?.units);
        if (key && Number.isFinite(units) && units > 0) {
          parsed.push({ key, label: String(m?.label ?? key), units: Math.round(units) });
        }
      }
      if (parsed.length) this.modes = parsed;
    }

    this.enabled = vc.enabled !== false && !!(this.url && this.apiKey && this.apiSecret);
    (globalThis as any).__dboVoiceEnabled = this.enabled;
    const modeDesc = this.modes.map(m => `${m.label} ${Math.round(m.units / 70)}m`).join(", ");
    this.log(`VoiceSystem: ${this.enabled ? `enabled, room '${this.room}', modes: ${modeDesc}` : "disabled (missing url/apiKey/apiSecret or enabled=false)"}`);
  }

  // A client that leaves takes its capability with it, and everyone left needs a map without it.
  disconnect(userId: number, ctx: SystemContext): void {
    this.lastMintAt.delete(userId);
    if (!this.v2Users.delete(userId)) return;
    if (!this.enabled) return;
    try { this.broadcastIdentityMap(ctx.svr as Mp); } catch (e) { this.log(`VoiceSystem: map broadcast on disconnect failed: ${e}`); }
  }

  private onlineVoicePlayers(mp: Mp): Array<VoicePlayer & { userId: number }> {
    const out: Array<VoicePlayer & { userId: number }> = [];
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (!mp.isConnected(userId)) continue; } catch { continue; }
      let actorId = 0;
      try { actorId = mp.getUserActor(userId); } catch { continue; }
      if (!actorId) continue;
      let profileId = 0;
      try { profileId = Number(mp.get(actorId, "profileId")) || 0; } catch { /* form gone */ }
      out.push({ userId, actorId, profileId, supportsV2: this.v2Users.has(userId) });
    }
    return out;
  }

  // Only the listeners that asked for it are told; an old client would not know what to do with it.
  private broadcastIdentityMap(mp: Mp): void {
    const players = this.onlineVoicePlayers(mp);
    const identityMap = buildIdentityMap(players);
    const payload = JSON.stringify({ customPacketType: "voiceIdentityMap", identityMap });
    for (const player of players) {
      if (!this.v2Users.has(player.userId)) continue;
      try { mp.sendCustomPacket(player.userId, payload); } catch (e) { /* gone between the scan and the send */ }
    }
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "voiceTokenRequest") return;
    const mp = ctx.svr as Mp;
    if (!this.enabled) {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "voiceToken", enabled: false }));
      return;
    }
    // Stated by the client, never assumed: an old package sends no caps and keeps the actor-id identity.
    const caps = (content as Record<string, unknown>)?.["caps"];
    const supportsV2 = !!(caps && typeof caps === "object" && (caps as Record<string, unknown>)["identityV2"] === true);
    if (supportsV2) this.v2Users.add(userId); else this.v2Users.delete(userId);

    let actorId = 0;
    try { actorId = mp.getUserActor(userId); } catch { }
    if (!actorId) return; // not spawned yet; the client re-requests after assign
    const now = Date.now();
    if (now - (this.lastMintAt.get(userId) || 0) < VoiceSystem.MINT_COOLDOWN_MS) return;
    this.lastMintAt.set(userId, now);
    let profileId = 0;
    try { profileId = Number(mp.get(actorId, "profileId")) || 0; } catch { /* falls back to the actor id */ }
    const identity = voiceIdentity({ actorId, profileId, supportsV2 });
    if (supportsV2 && identity === actorKey(actorId)) {
      this.log(`VoiceSystem: user ${userId} asked for a profile identity but has no profile id; keeping the actor id`);
    }
    try {
      const token = mintLiveKitToken(this.apiKey, this.apiSecret, identity, this.room);
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "voiceToken",
        enabled: true,
        url: this.url,
        token,
        room: this.room,
        identity,
        modes: this.modes,
        identityMap: supportsV2 ? buildIdentityMap(this.onlineVoicePlayers(mp)) : undefined,
      }));
      // This player just changed the map for everyone else too
      this.broadcastIdentityMap(mp);
    } catch (e) {
      this.log(`VoiceSystem: token mint failed for user ${userId}: ${e}`);
    }
  }
}
