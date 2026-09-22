import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { AdminTier, AdminRoleConfig, TIER_CAPS, readAdminRoleConfig, adminTierOf } from "./adminRoles";
import { NpcSpawnSystem } from "./npcSpawnSystem";
import { MasterySystem, MAX_GRANT } from "./masterySystem";
import { kickWithReason } from "./kickUtil";
import { AdminBans } from "./adminBans";
import * as fs from "fs";
import * as path from "path";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── In-game admin (Discord-role gated) ───────────────────────────────────────
// Admins resolve to a tier (senior | developer | gm) via adminRoles.ts from "adminRoles", the legacy "adminRoleIds" and "adminProfileIds".
// Every tier gets the server console (consoleCommandsAllowed per assign; keep enableConsoleCommandsForAll OFF) and the tabbed admin panel (client AdminMenuService, Insert key).
// Only tiers with TIER_CAPS.ban may ban; the refusal is enforced here, never in the client.
// Bans post to the backend (master key + auth token), which snapshots discordId/hwid/ip into bans.json; connection-check then refuses the player permanently.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "debugInfoRequest" }  any player, answered before the admin gate
//                     { customPacketType: "adminMenuRequest" }
//                     { customPacketType: "npcZonesRequest" }
//                     { customPacketType: "adminAction", action, target }  action: teleportTo | summon | kick | ban (target: actor id hex) | teleportLoc (target: location name)
//                     { customPacketType: "adminAction", action: "toggleMode", mode }
//                     { customPacketType: "adminAction", action: "npcZoneAdd", zone }  zone: JSON string of one NPC-Spawns.json entry
//                     { customPacketType: "adminAction", action: "npcZoneTp" | "npcZoneReset" | "npcZoneDelete", target }  target: zone name
//                     { customPacketType: "adminAction", action: "masteryGrant", target, amount }  worked hours to add (negative removes), any tier, self allowed
//                     { customPacketType: "adminAction", action: "masteryReset", target }  clears the character's chosen craft and its hours
//                     (F7 panel, 2026-09-16)
//                     { customPacketType: "adminAction", action: "kill" | "deleteCharacter" | "ipBan", target }  target: online actor id hex
//                     { customPacketType: "adminAction", action: "tempBan", target, hours }
//                     { customPacketType: "adminAction", action: "unban", target }  target: ban id
//                     { customPacketType: "adminMasteryRequest", target?, targetName? }  -> adminMastery
//                     { customPacketType: "adminAction", action: "masterySetTier", target?, targetName?, skill, tier }
//                     { customPacketType: "adminAction", action: "masteryDrop", target?, targetName?, skill }
//                     { customPacketType: "adminItemsRequest" }  -> adminItems
//                     { customPacketType: "adminLocationsRequest" }  -> adminLocations  (settings locations + admin-locations.json map markers)
//                     { customPacketType: "adminAction", action: "giveItem", item, count, targetName? }
//                     { customPacketType: "adminAction", action: "giveSpells" | "giveShouts" | "giveWerewolf" | "giveVampireLord", targetName? }
//                     A missing target/targetName means the admin themself; targetName takes a name, a name prefix or #TAG.
//   Server -> Client: { customPacketType: "adminMastery", targetName, detail }
//                     { customPacketType: "adminItems", categories: [{ id, label, items: [[desc, name, plugin?]] }] }
//                     { customPacketType: "adminLocations", locations: [{ name, region, worldName }] }
//                     { customPacketType: "dboTeachShouts", shouts: [{ shout, words: [desc] }] }  -> the target's client (AdminModeService)
//   Server -> Client: { customPacketType: "debugInfo", serverName, serverTime, serverTzOffsetMin, actorId, profileId }  actorId: the requester's own actor id hex
//                     { customPacketType: "adminMenu", players: [{a?, p, n, d, dn, ip, hwid, online, ping, m?}], locations: [{name}], modes: [{id, label, active}], npcZones: [ZoneSummary], tier, caps: {ban}, mastery }
//                       m / mastery: MasterySummary {profession, label, rank, rankName, hours} of the online row / of the admin's own character
//                     { customPacketType: "adminMode", mode, on }  also re-sent for every active mode when the admin's actor is assigned
//                     { customPacketType: "npcZones", zones: [ZoneSummary] }  after npcZonesRequest and after every zone mutation
//                     { customPacketType: "adminActionResult", ok, text }
// The roster merges online actors with the backend's full player list (GET /:key/players);
// ips are masked to the first two octets before leaving the server (full ip stays in the backend).
// Non-admin requests are ignored silently; every Insert press sends adminMenuRequest, so that refusal is logged once per user slot.

const MAX_USER_SLOTS = 1024;
const PING_CACHE_MS = 3000;

const ADMIN_MODES: Array<{ id: string; label: string }> = [
  { id: "god", label: "God" },
  { id: "noclip", label: "NoClip" },
  { id: "invis", label: "Invisible" },
  { id: "ghost", label: "Ghost" },
  { id: "freecam", label: "Freecam" },
  { id: "smite", label: "Smite" },
  { id: "healhit", label: "Heal on Hit" },
];

// Modes mirrored onto the neighbors-visible ff_adminModes actor property (registered in gamemode.js)
const MIRRORED_MODES = ["god", "smite", "healhit", "invis"];

interface TeleportLocation {
  name: string;
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

export class AdminSystem implements System {
  systemName = "AdminSystem";
  constructor(private log: Log, private npcSpawns: NpcSpawnSystem, private mastery: MasterySystem) { }

  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private masterUrl = "";
  private masterKey = "";
  private authToken = "";
  private locations: TeleportLocation[] = [];
  private modesByProfile = new Map<number, Record<string, boolean>>();
  private pingCache = new Map<number, number>();
  private pingCacheAt = 0;
  private serverName = "";
  private menuRefusalLogged = new Set<number>();
  private bans!: AdminBans;
  private lastBanSweep = 0;
  private itemCatalog: Array<{ id: string; label: string; items: Array<[string, string]> }> | null = null;
  private markerLocations: Array<TeleportLocation & { region: string; worldName: string }> | null = null;

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    this.serverName = typeof s.name === "string" ? s.name : "";
    this.masterUrl = typeof s.master === "string" ? s.master.replace(/\/+$/, "") : "";
    this.masterKey = typeof s.masterKey === "string" ? s.masterKey : "";
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    this.roleCfg = readAdminRoleConfig(all);
    if (Array.isArray(all?.["adminTeleportLocations"])) {
      const mp = ctx.svr as Mp;
      for (const raw of all["adminTeleportLocations"]) {
        const loc = this.parseLocation(mp, raw);
        if (loc) this.locations.push(loc);
      }
    }

    this.installGodModeHook(ctx.svr as Mp);
    this.bans = new AdminBans(this.log);

    // Console rights and admin modes follow the admin check on every actor assignment
    ctx.gm.on("userAssignActor", (userId: number) => {
      const mp = ctx.svr as Mp;
      try {
        const actorId = mp.getUserActor(userId);
        if (!actorId) return;
        const tier = this.tierOf(mp, actorId);
        mp.set(actorId, "consoleCommandsAllowed", tier !== null);
        if (tier) this.log(`AdminSystem: console granted to actor ${actorId.toString(16)} (${tier})`);
        this.resyncModes(mp, userId, actorId, tier !== null);
        // Shouts live only in the client's game, so a character given all shouts is taught them again at every login
        let shouts = false;
        try { shouts = mp.get(actorId, "private.dboAllShouts") === true; } catch { }
        if (shouts) setTimeout(() => this.teachShouts(mp, userId), 15000);
      } catch (e) {
        this.log(`AdminSystem: assign hook failed: ${e}`);
      }
    });

    const { tierRoles, adminRoleIds, adminProfileIds } = this.roleCfg;
    this.log(`AdminSystem: tier roles senior ${tierRoles.senior.length} / developer ${tierRoles.developer.length} / gm ${tierRoles.gm.length}, ${adminRoleIds.length} legacy admin role(s), ${adminProfileIds.length} admin profile(s), ${this.locations.length} teleport location(s)`);
  }

  // Validated like npcSpawnSystem zones; bad descs are dropped at boot
  private parseLocation(mp: Mp, raw: any): TeleportLocation | null {
    try {
      const name = String(raw?.name ?? "");
      const cellOrWorldDesc = String(raw?.cellOrWorldDesc ?? "");
      const pos = Array.isArray(raw?.pos) ? raw.pos.map(Number) : null;
      const rot = Array.isArray(raw?.rot) && raw.rot.length === 3 ? raw.rot.map(Number) : [0, 0, 0];
      if (!name || !cellOrWorldDesc || !pos || pos.length !== 3 || pos.some((n: number) => !Number.isFinite(n))) {
        this.log(`AdminSystem: teleport location '${name || "?"}' skipped, needs name/cellOrWorldDesc/pos`);
        return null;
      }
      mp.getIdFromDesc(cellOrWorldDesc);
      return { name, cellOrWorldDesc, pos, rot };
    } catch (e) {
      this.log(`AdminSystem: bad teleport location skipped: ${e}`);
      return null;
    }
  }

  private tierOf(mp: Mp, actorId: number): AdminTier | null {
    return adminTierOf(mp, actorId, this.roleCfg);
  }

  private isAdminActor(mp: Mp, actorId: number): boolean {
    return this.tierOf(mp, actorId) !== null;
  }

  private onlinePlayers(mp: Mp): Array<{ userId: number; actorId: number; profileId: number; name: string }> {
    const out: Array<{ userId: number; actorId: number; profileId: number; name: string }> = [];
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (!mp.isConnected(userId)) continue; } catch { continue; }
      let actorId = 0;
      try { actorId = mp.getUserActor(userId); } catch { continue; }
      if (!actorId) continue;
      let name = "";
      try { name = String(mp.get(actorId, "appearance")?.name ?? ""); } catch { }
      let profileId = 0;
      try { profileId = Number(mp.get(actorId, "profileId")) || 0; } catch { }
      out.push({ userId, actorId, profileId, name });
    }
    return out;
  }

  // Per-slot ping in ms parsed from the prometheus text; cached to match the C++ update period
  private pings(mp: Mp): Map<number, number> {
    const now = Date.now();
    if (now - this.pingCacheAt < PING_CACHE_MS) return this.pingCache;
    this.pingCache = new Map();
    this.pingCacheAt = now;
    try {
      const text = String(mp.getPrometheusMetrics() ?? "");
      const re = /skymp_server_ping_per_slot_seconds\{networking_user_id="(\d+)"\}\s+([0-9.eE+-]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        this.pingCache.set(Number(m[1]), Math.round(Number(m[2]) * 1000));
      }
    } catch { }
    return this.pingCache;
  }

  // In-game ip display conflicts with hideIpRoleId; only the first two octets leave the server
  private maskIp(ip: unknown): string {
    const text = String(ip ?? "").trim();
    if (!text) return "";
    const parts = text.split(".");
    if (parts.length !== 4) return "x.x.x.x";
    return `${parts[0]}.${parts[1]}.x.x`;
  }

  private async fetchBackendRoster(): Promise<any[]> {
    if (!this.masterUrl || !this.masterKey || !this.authToken) return [];
    try {
      const res = await fetch(`${this.masterUrl}/api/servers/${this.masterKey}/players`, {
        headers: { "X-Auth-Token": this.authToken },
      });
      if (!res.ok) {
        this.log(`AdminSystem: backend roster fetch failed with status ${res.status}`);
        return [];
      }
      const body: any = await res.json();
      return Array.isArray(body?.players) ? body.players : [];
    } catch (e) {
      this.log(`AdminSystem: backend roster fetch failed: ${e}`);
      return [];
    }
  }

  // Offline backend records merged with live actors; online rows win their profile slot
  private buildRoster(ctx: SystemContext, myActorId: number, adminProfile: number, backendPlayers: any[]): any[] {
    const mp = ctx.svr as Mp;
    const pings = this.pings(mp);
    const byProfile = new Map<number, any>();
    for (const raw of backendPlayers) {
      const profileId = Number(raw?.profileId);
      if (!Number.isFinite(profileId) || profileId <= 0) continue;
      byProfile.set(profileId, {
        p: profileId,
        n: "",
        d: String(raw?.discordId ?? ""),
        dn: String(raw?.displayName || raw?.username || ""),
        ip: this.maskIp(raw?.lastIp),
        hwid: String(raw?.hwid ?? ""),
        online: false,
        ping: null,
      });
    }
    const extra: any[] = [];
    for (const p of this.onlinePlayers(mp)) {
      if (p.actorId === myActorId) continue;
      const base = byProfile.get(p.profileId);
      let discordId = "";
      try { discordId = String(mp.get(p.actorId, "private.skympDiscordId") ?? ""); } catch { }
      if (!discordId) {
        try { discordId = String(mp.get(p.actorId, "private.indexed.discordId") ?? ""); } catch { }
      }
      let ip = "";
      try { ip = String(mp.getUserIp(p.userId) ?? ""); } catch { }
      let guid = "";
      try { guid = String(mp.getUserGuid(p.userId) ?? ""); } catch { }
      const row = {
        a: p.actorId.toString(16),
        p: p.profileId,
        n: p.name || "(no name)",
        d: discordId || (base ? base.d : ""),
        dn: base ? base.dn : "",
        ip: this.maskIp(ip) || (base ? base.ip : ""),
        hwid: (base && base.hwid) ? base.hwid : guid,
        online: true,
        ping: pings.get(p.userId) ?? null,
        m: this.mastery.summaryOf(ctx, p.actorId),
      };
      if (p.profileId > 0) byProfile.set(p.profileId, row);
      else extra.push(row);
    }
    byProfile.delete(adminProfile);
    const rows = Array.from(byProfile.values()).concat(extra);
    rows.sort((a, b) => (a.online === b.online) ? a.p - b.p : (a.online ? -1 : 1));
    return rows;
  }

  private modesFor(adminProfile: number): Array<{ id: string; label: string; active: boolean }> {
    const state = this.modesByProfile.get(adminProfile) ?? {};
    return ADMIN_MODES.map(m => ({ id: m.id, label: m.label, active: !!state[m.id] }));
  }

  private reply(mp: Mp, userId: number, ok: boolean, text: string): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminActionResult", ok, text }));
    } catch { }
  }

  // Routes into the gamemode's admin.log + staff channel when loaded
  private adminLog(text: string): void {
    try { (globalThis as any).__alduinakAdminLog?.(text); } catch { }
  }

  // Any player with an actor may ask; the reply carries nothing about other players
  private sendDebugInfo(mp: Mp, userId: number): void {
    let actorId = 0;
    try { actorId = mp.getUserActor(userId); } catch { }
    if (!actorId) return;
    let profileId = 0;
    try { profileId = Number(mp.get(actorId, "profileId")) || 0; } catch { }
    try {
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "debugInfo",
        serverName: this.serverName,
        serverTime: Date.now(),
        serverTzOffsetMin: new Date().getTimezoneOffset(),
        actorId: actorId.toString(16),
        profileId,
      }));
    } catch (e) {
      this.log(`AdminSystem: debugInfo reply failed: ${e}`);
    }
  }

  // Bans from the panel: an ip ban refuses the connection at once, a profile ban as soon as a character loads
  connect(userId: number, ctx: SystemContext): void {
    this.enforceBan(ctx.svr as Mp, userId, 0);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    if (now - this.lastBanSweep < 2000 || !this.bans) return;
    this.lastBanSweep = now;
    const mp = ctx.svr as Mp;
    for (const p of this.onlinePlayers(mp)) this.enforceBan(mp, p.userId, p.profileId);
  }

  private enforceBan(mp: Mp, userId: number, profileId: number): void {
    if (!this.bans) return;
    let ip = "";
    try { ip = String(mp.getUserIp(userId) || ""); } catch { return; }
    const ban = this.bans.find(profileId, ip);
    if (!ban) return;
    const until = ban.until ? `until ${new Date(ban.until).toISOString().replace("T", " ").slice(0, 16)} UTC` : "permanently";
    this.log(`AdminSystem: refused user ${userId} (profile ${profileId}, banned ${until} by ${ban.by})`);
    try { kickWithReason(mp, userId, `You are banned from this server ${until}.${ban.reason ? " " + ban.reason : ""}`); } catch { }
  }

  // Slots are reused, so the next player in this slot gets the refusal diagnostic again
  disconnect(userId: number): void {
    this.menuRefusalLogged.delete(userId);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type === "debugInfoRequest") {
      this.sendDebugInfo(ctx.svr as Mp, userId);
      return;
    }
    if (type !== "adminMenuRequest" && type !== "adminAction" && type !== "npcZonesRequest" && type !== "adminMasteryRequest" && type !== "adminItemsRequest" && type !== "adminLocationsRequest") return;
    const mp = ctx.svr as Mp;
    let myActorId = 0;
    try { myActorId = mp.getUserActor(userId); } catch { }
    if (!myActorId || !this.isAdminActor(mp, myActorId)) {
      if (type === "adminMenuRequest" && myActorId) {
        if (this.menuRefusalLogged.has(userId)) return;
        this.menuRefusalLogged.add(userId);
      }
      // Log the actor's real roles so a misconfigured adminRoleIds is diagnosable from the game
      let roles: unknown = [];
      try { roles = mp.get(myActorId, "private.discordRoles"); } catch { }
      this.log(`AdminSystem: refused '${type}' from actor ${myActorId.toString(16)} (not an admin). Their roles: ${JSON.stringify(roles)}. Configured: ${JSON.stringify({ ...this.roleCfg.tierRoles, legacy: this.roleCfg.adminRoleIds })}`);
      return;
    }
    const tier = this.tierOf(mp, myActorId) as AdminTier;
    const caps = TIER_CAPS[tier];

    let adminProfile = 0;
    try { adminProfile = Number(mp.get(myActorId, "profileId")) || 0; } catch { }

    if (type === "adminMenuRequest") {
      this.fetchBackendRoster().then(backendPlayers => {
        try {
          // The fetch outlives the packet handler; the slot must still belong to the same admin
          if (mp.getUserActor(userId) !== myActorId) return;
          mp.sendCustomPacket(userId, JSON.stringify({
            customPacketType: "adminMenu",
            players: this.buildRoster(ctx, myActorId, adminProfile, backendPlayers),
            locations: this.locations.map(l => ({ name: l.name })),
            modes: this.modesFor(adminProfile),
            npcZones: this.npcSpawns.listZones(),
            tier,
            caps,
            mastery: this.mastery.summaryOf(ctx, myActorId),
            bans: this.bans.list(),
          }));
        } catch (e) {
          this.log(`AdminSystem: adminMenu reply failed: ${e}`);
        }
      });
      return;
    }
    if (type === "npcZonesRequest") {
      this.sendZones(mp, userId, myActorId);
      return;
    }
    if (type === "adminLocationsRequest") {
      const locations = this.locations.map((l) => ({ name: l.name, region: "Custom", worldName: "" }))
        .concat(this.markers().map((l) => ({ name: l.name, region: l.region, worldName: l.worldName })));
      try { mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminLocations", locations })); }
      catch (e) { this.log(`AdminSystem: adminLocations reply failed: ${e}`); }
      return;
    }
    if (type === "adminItemsRequest") {
      try { mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminItems", categories: this.items() })); }
      catch (e) { this.log(`AdminSystem: adminItems reply failed: ${e}`); }
      return;
    }
    if (type === "adminMasteryRequest") {
      const who = this.resolveTarget(mp, myActorId, content);
      if (!who) { this.reply(mp, userId, false, "No online player by that name"); return; }
      try { mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminMastery", targetName: who.name, target: who.actorId.toString(16), detail: this.mastery.adminDetail(ctx, who.actorId) })); }
      catch (e) { this.log(`AdminSystem: adminMastery reply failed: ${e}`); }
      return;
    }

    const action = String(content["action"] ?? "");

    if (action === "toggleMode") {
      this.toggleMode(mp, userId, myActorId, adminProfile, String(content["mode"] ?? ""));
      return;
    }
    if (action.startsWith("npcZone")) {
      this.npcZoneAction(mp, userId, myActorId, adminProfile, action, content);
      return;
    }
    if (action === "teleportLoc") {
      const name = String(content["target"] ?? "");
      const loc = this.locations.find(l => l.name === name) || this.markers().find(l => l.name === name);
      if (!loc) {
        this.reply(mp, userId, false, "Unknown location");
        return;
      }
      try {
        mp.set(myActorId, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos: loc.pos, rot: loc.rot });
        this.adminLog(`profile ${adminProfile} teleported to location '${loc.name}'`);
        this.reply(mp, userId, true, `Teleported to ${loc.name}`);
      } catch (e) {
        this.log(`AdminSystem: teleportLoc '${name}' by profile ${adminProfile} failed: ${e}`);
        this.reply(mp, userId, false, "Teleport failed, see server log");
      }
      return;
    }

    if (action === "unban") {
      if (!caps.ban) { this.reply(mp, userId, false, "Your rank cannot lift bans"); return; }
      const lifted = this.bans.remove(String(content["target"] ?? ""));
      if (lifted) this.adminLog(`profile ${adminProfile} lifted the ban on ${lifted.name || "profile " + lifted.profileId}${lifted.ip ? " / ip " + lifted.ip : ""}`);
      this.reply(mp, userId, !!lifted, lifted ? `Ban on ${lifted.name || lifted.ip} lifted` : "No such ban");
      return;
    }
    if (["masterySetTier", "masteryDrop", "giveItem", "giveSpells", "giveShouts", "giveWerewolf", "giveVampireLord"].indexOf(action) !== -1) {
      const who = this.resolveTarget(mp, myActorId, content);
      if (!who) { this.reply(mp, userId, false, "No online player by that name"); return; }
      this.selfServiceAction(ctx, mp, userId, myActorId, adminProfile, action, who, content);
      return;
    }

    const targetId = parseInt(String(content["target"] ?? ""), 16);
    // Only currently-online player actors are valid targets; the admin's own row is absent from the roster, but mastery testing may target self
    const target = this.onlinePlayers(mp).find(p => p.actorId === targetId);
    if (!target) {
      this.reply(mp, userId, false, "Target is no longer online");
      return;
    }

    try {
      if (action === "teleportTo") {
        mp.set(myActorId, "locationalData", mp.get(target.actorId, "locationalData"));
        this.adminLog(`profile ${adminProfile} teleported to ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Teleported to ${target.name}`);
      } else if (action === "summon") {
        mp.set(target.actorId, "locationalData", mp.get(myActorId, "locationalData"));
        this.adminLog(`profile ${adminProfile} summoned ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Summoned ${target.name}`);
      } else if (action === "kick") {
        // Disable boots to the menu; kick drops the connection so they can't re-enter from character select
        ctx.svr.setEnabled(target.actorId, false);
        try { kickWithReason(mp, target.userId, "You were kicked from the server by an admin."); } catch { }
        this.log(`AdminSystem: profile ${adminProfile} kicked profile ${target.profileId} (${target.name})`);
        this.adminLog(`profile ${adminProfile} kicked ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Kicked ${target.name}`);
      } else if (action === "ban") {
        if (!caps.ban) {
          this.log(`AdminSystem: profile ${adminProfile} (${tier}) refused a ban on profile ${target.profileId} (${target.name})`);
          this.adminLog(`profile ${adminProfile} (${tier}) was refused a ban on ${target.name} (profile ${target.profileId})`);
          this.reply(mp, userId, false, "Your rank cannot ban players");
        } else {
          this.banViaBackend(mp, ctx, userId, myActorId, target, adminProfile, tier);
        }
      } else if (action === "kill") {
        mp.set(target.actorId, "isDead", true);
        this.adminLog(`profile ${adminProfile} killed ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Killed ${target.name}`);
      } else if (action === "deleteCharacter") {
        if (!caps.ban) { this.reply(mp, userId, false, "Your rank cannot delete characters"); return; }
        if (target.actorId === myActorId) { this.reply(mp, userId, false, "Delete your own character from character select"); return; }
        try { kickWithReason(mp, target.userId, "Your character was deleted by an admin."); } catch { }
        const doomed = target.actorId;
        setTimeout(() => { try { mp.destroyActor(doomed); } catch (e) { this.log(`AdminSystem: destroyActor ${doomed.toString(16)} failed: ${e}`); } }, 1500);
        this.log(`AdminSystem: profile ${adminProfile} deleted character ${doomed.toString(16)} ${target.name} (profile ${target.profileId})`);
        this.adminLog(`profile ${adminProfile} deleted the character ${target.name} (profile ${target.profileId}, actor ${doomed.toString(16)})`);
        this.reply(mp, userId, true, `Deleted ${target.name}`);
      } else if (action === "ipBan" || action === "tempBan") {
        if (!caps.ban) { this.reply(mp, userId, false, "Your rank cannot ban players"); return; }
        if (target.actorId === myActorId) { this.reply(mp, userId, false, "You cannot ban yourself"); return; }
        const hours = action === "tempBan" ? Number(content["hours"]) : 0;
        if (action === "tempBan" && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365)) { this.reply(mp, userId, false, "Pick a ban length between 1 hour and a year"); return; }
        let ip = "";
        try { ip = String(mp.getUserIp(target.userId) || "").split(":")[0]; } catch { }
        if (action === "ipBan" && !ip) { this.reply(mp, userId, false, "Their ip is unknown"); return; }
        const ban = this.bans.add({
          profileId: target.profileId, name: target.name, ip: action === "ipBan" ? ip : "",
          until: action === "tempBan" ? Date.now() + Math.round(hours * 3600000) : 0,
          reason: String(content["reason"] ?? "").slice(0, 200), by: `profile ${adminProfile}`,
        });
        const what = action === "ipBan" ? `ip-banned ${target.name} (profile ${target.profileId}, ip ${ip})` : `banned ${target.name} (profile ${target.profileId}) for ${hours}h`;
        this.log(`AdminSystem: profile ${adminProfile} ${what}, ban ${ban.id}`);
        this.adminLog(`profile ${adminProfile} ${what}`);
        this.enforceBan(mp, target.userId, target.profileId);
        this.reply(mp, userId, true, action === "ipBan" ? `IP-banned ${target.name}` : `Banned ${target.name} for ${hours} hour(s)`);
      } else if (action === "masteryGrant") {
        const amount = Number(content["amount"]);
        const summary = this.mastery.grantPoints(ctx, target.actorId, amount);
        if (!summary) {
          this.reply(mp, userId, false, `Hours must be a whole number between -${MAX_GRANT} and ${MAX_GRANT}`);
        } else {
          const standing = summary.label ? `${summary.rankName} ${summary.label}` : "no craft chosen";
          this.adminLog(`profile ${adminProfile} granted ${amount} mastery hour(s) to ${target.name} (profile ${target.profileId}), now ${summary.hours}h, ${standing}`);
          this.reply(mp, userId, true, `${target.name}: ${summary.hours}h, ${standing}`);
        }
      } else if (action === "masteryReset") {
        const ok = this.mastery.resetCharacter(ctx, target.actorId);
        if (ok) this.adminLog(`profile ${adminProfile} reset the craft and hours of ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, ok, ok ? `Reset the craft and hours of ${target.name}` : `${target.name} has no craft to reset`);
      } else {
        this.reply(mp, userId, false, `Unknown action '${action}'`);
      }
    } catch (e) {
      this.log(`AdminSystem: action '${action}' by profile ${adminProfile} failed: ${e}`);
      this.reply(mp, userId, false, "Action failed, see server log");
    }
  }

  // A named player (name, unique name prefix or #TAG), an actor id hex, or the admin themself when neither is given
  private resolveTarget(mp: Mp, myActorId: number, content: Content): { userId: number; actorId: number; profileId: number; name: string } | null {
    const online = this.onlinePlayers(mp);
    const hex = parseInt(String(content["target"] ?? ""), 16);
    if (hex) return online.find((p) => p.actorId === hex) || null;
    const query = String(content["targetName"] ?? "").trim().toLowerCase();
    if (!query) return online.find((p) => p.actorId === myActorId) || null;
    const tag = query.match(/#([a-z0-9]{4})$/);
    if (tag) {
      const byTag = online.find((p) => { try { return String(mp.get(p.actorId, "ff_charTag") || "").toLowerCase() === tag[1]; } catch { return false; } });
      if (byTag) return byTag;
    }
    const bare = query.replace(/\s*#[a-z0-9]{4}$/, "");
    const exact = online.filter((p) => p.name.toLowerCase() === bare);
    if (exact.length === 1) return exact[0];
    const prefix = online.filter((p) => p.name.toLowerCase().startsWith(bare));
    return prefix.length === 1 ? prefix[0] : null;
  }

  private selfServiceAction(ctx: SystemContext, mp: Mp, userId: number, myActorId: number, adminProfile: number,
    action: string, who: { userId: number; actorId: number; profileId: number; name: string }, content: Content): void {
    const whom = who.actorId === myActorId ? "themself" : `${who.name} (profile ${who.profileId})`;
    try {
      if (action === "masterySetTier" || action === "masteryDrop") {
        const skill = String(content["skill"] ?? "");
        const tier = Number(content["tier"]);
        const ok = action === "masterySetTier" ? this.mastery.adminSetTier(ctx, who.actorId, skill, tier) : this.mastery.adminDropSkill(ctx, who.actorId, skill);
        if (ok) this.adminLog(`profile ${adminProfile} ${action === "masterySetTier" ? `set ${skill} to tier ${tier} for` : `dropped ${skill} for`} ${whom}`);
        this.reply(mp, userId, ok, ok ? (action === "masterySetTier" ? `${who.name}: ${skill} set` : `${who.name}: ${skill} set aside`) : "That did not work");
        if (ok) mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminMastery", targetName: who.name, target: who.actorId.toString(16), detail: this.mastery.adminDetail(ctx, who.actorId) }));
        return;
      }
      if (action === "giveItem") {
        const desc = String(content["item"] ?? "");
        const count = Math.floor(Number(content["count"]));
        if (!Number.isFinite(count) || count < 1 || count > 100000) { this.reply(mp, userId, false, "Count must be 1 to 100000"); return; }
        let baseId = 0;
        try { baseId = mp.getIdFromDesc(desc) >>> 0; } catch { }
        if (!baseId) { this.reply(mp, userId, false, "Unknown item"); return; }
        const inv = mp.get(who.actorId, "inventory") || { entries: [] };
        const entries = Array.isArray(inv.entries) ? inv.entries.map((e: any) => Object.assign({}, e)) : [];
        const hit = entries.find((e: any) => e && (Number(e.baseId) >>> 0) === baseId && !e.worn && !e.wornLeft);
        if (hit) hit.count = (Number(hit.count) || 0) + count; else entries.push({ baseId, count });
        mp.set(who.actorId, "inventory", { entries });
        this.adminLog(`profile ${adminProfile} spawned ${count}x ${desc} for ${whom}`);
        this.reply(mp, userId, true, `${count}x given to ${who.name}`);
        return;
      }
      const powers = this.powers();
      if (!powers) { this.reply(mp, userId, false, "admin-powers.json is missing on the server"); return; }
      if (action === "giveSpells" || action === "giveWerewolf" || action === "giveVampireLord") {
        const list: string[] = action === "giveSpells" ? powers.spells.map((x) => x[0]) : [action === "giveWerewolf" ? powers.werewolf : powers.vampirelord].filter((x): x is string => !!x);
        let n = 0;
        for (const desc of list) {
          try {
            mp.callPapyrusFunction("method", "Actor", "AddSpell", { type: "form", desc: mp.getDescFromId(who.actorId) }, [{ type: "espm", desc }, false]);
            n++;
          } catch (e) { this.log(`AdminSystem: AddSpell ${desc} failed: ${e}`); }
        }
        const formName = action === "giveWerewolf" ? "werewolf beast form" : "Vampire Lord form";
        if (action !== "giveSpells") { try { mp.set(who.actorId, action === "giveWerewolf" ? "private.werewolfGrant" : "private.vampireLordGrant", true); } catch { /* offline */ } }
        this.adminLog(`profile ${adminProfile} gave ${action === "giveSpells" ? `${n} spells` : formName} to ${whom}`);
        this.reply(mp, userId, n > 0, action === "giveSpells" ? `${n} spells given to ${who.name}` : `${who.name} can now take ${formName}`);
        return;
      }
      if (action === "giveShouts") {
        mp.set(who.actorId, "private.dboAllShouts", true);
        this.teachShouts(mp, who.userId);
        this.adminLog(`profile ${adminProfile} gave every shout to ${whom}`);
        this.reply(mp, userId, true, `${powers.shouts.length} shouts taught to ${who.name}`);
      }
    } catch (e) {
      this.log(`AdminSystem: action '${action}' by profile ${adminProfile} failed: ${e}`);
      this.reply(mp, userId, false, "Action failed, see server log");
    }
  }

  private teachShouts(mp: Mp, userId: number): void {
    const powers = this.powers();
    if (!powers) return;
    try { mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "dboTeachShouts", shouts: powers.shouts.map((x) => ({ shout: x.shout, words: x.words })) })); }
    catch (e) { this.log(`AdminSystem: dboTeachShouts failed: ${e}`); }
  }

  // admin-powers.json from ck-mcp/admin_powers.py: tome spells, shouts with their words, the werewolf power
  private powers(): { spells: Array<[string, string]>; shouts: Array<{ shout: string; name: string; words: string[] }>; werewolf: string; vampirelord?: string } | null {
    try { return JSON.parse(fs.readFileSync(path.resolve("admin-powers.json"), "utf8")); } catch { return null; }
  }

  // Map markers of every worldspace from ck-mcp/admin_catalog.py, grouped by region
  private markers(): Array<TeleportLocation & { region: string; worldName: string }> {
    if (this.markerLocations) return this.markerLocations;
    const out: Array<TeleportLocation & { region: string; worldName: string }> = [];
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve("admin-locations.json"), "utf8"));
      for (const l of Array.isArray(raw.locations) ? raw.locations : []) {
        if (!l || !l.name || !l.world || !Array.isArray(l.pos)) continue;
        out.push({ name: String(l.name), cellOrWorldDesc: String(l.world), pos: l.pos.map(Number), rot: Array.isArray(l.rot) ? l.rot.map(Number) : [0, 0, 0], region: String(l.region || "Other"), worldName: String(l.worldName || "") });
      }
    } catch (e) { this.log(`AdminSystem: admin-locations.json unreadable: ${e}`); }
    this.markerLocations = out;
    return out;
  }

  // Item categories for the spawn tab: admin-items.json (every playable item of every plugin) when present,
  // otherwise loot.json pools plus the spell tomes and scrolls from readables.json
  private items(): Array<{ id: string; label: string; items: Array<[string, string]> }> {
    if (this.itemCatalog) return this.itemCatalog;
    try {
      const full = JSON.parse(fs.readFileSync(path.resolve("admin-items.json"), "utf8"));
      if (Array.isArray(full.categories) && full.categories.length) {
        this.itemCatalog = full.categories;
        return full.categories;
      }
    } catch { /* not generated: fall back to the loot pools */ }
    const LABELS: Record<string, string> = {
      weapons: "Weapons", ench_weapons: "Enchanted Weapons", armor: "Armor", ench_armor: "Enchanted Armor", arrows: "Arrows",
      potions: "Potions", food: "Food", ingredients: "Ingredients", materials: "Materials", gems: "Gems", soulgems: "Soul Gems", lockpicks: "Misc",
    };
    const out: Array<{ id: string; label: string; items: Array<[string, string]> }> = [];
    try {
      const loot = JSON.parse(fs.readFileSync(path.resolve("loot.json"), "utf8"));
      for (const [id, list] of Object.entries(loot.pools || {})) {
        if (!Array.isArray(list)) continue;
        out.push({ id, label: LABELS[id] || id, items: (list as any[]).map((x) => [String(x.id), String(x.name)] as [string, string]) });
      }
    } catch (e) { this.log(`AdminSystem: loot.json unreadable: ${e}`); }
    try {
      const r = JSON.parse(fs.readFileSync(path.resolve("readables.json"), "utf8"));
      const desc = (canon: string) => { const [plugin, hex] = String(canon).split(":"); return `${parseInt(hex, 16).toString(16)}:${plugin}`; };
      if (Array.isArray(r.tomes)) out.push({ id: "tomes", label: "Spell Tomes", items: r.tomes.map((x: any) => [desc(x.id), String(x.name)] as [string, string]) });
      if (Array.isArray(r.scrolls)) out.push({ id: "scrolls", label: "Scrolls", items: r.scrolls.map((x: any) => [desc(x.id), String(x.name)] as [string, string]) });
    } catch (e) { this.log(`AdminSystem: readables.json unreadable: ${e}`); }
    const order = ["weapons", "ench_weapons", "armor", "ench_armor", "arrows", "potions", "food", "ingredients", "materials", "gems", "soulgems", "tomes", "scrolls", "lockpicks"];
    out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    this.itemCatalog = out;
    return out;
  }

  // Every tier may manage NPC zones; the slot must still belong to the admin because add/delete finish asynchronously
  private sendZones(mp: Mp, userId: number, adminActorId: number): void {
    try {
      if (mp.getUserActor(userId) !== adminActorId) return;
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "npcZones", zones: this.npcSpawns.listZones() }));
    } catch (e) {
      this.log(`AdminSystem: npcZones reply failed: ${e}`);
    }
  }

  private npcZoneAction(mp: Mp, userId: number, myActorId: number, adminProfile: number, action: string, content: Content): void {
    const name = String(content["target"] ?? "");
    if (action === "npcZoneAdd") {
      let raw: unknown;
      try { raw = JSON.parse(String(content["zone"] ?? "")); } catch { raw = null; }
      if (!raw || typeof raw !== "object") {
        this.reply(mp, userId, false, "Bad zone data");
        return;
      }
      const zoneName = String((raw as Record<string, unknown>)["Name"] ?? "");
      this.npcSpawns.addZone(raw).then(err => {
        if (!err) this.adminLog(`profile ${adminProfile} added npc zone '${zoneName}'`);
        this.replyIfSameAdmin(mp, userId, myActorId, !err, err ?? `Added zone ${zoneName}`);
        if (!err) this.sendZones(mp, userId, myActorId);
      }).catch(e => {
        this.log(`AdminSystem: npcZoneAdd by profile ${adminProfile} failed: ${e}`);
        this.replyIfSameAdmin(mp, userId, myActorId, false, "Action failed, see server log");
      });
      return;
    }
    if (action === "npcZoneDelete") {
      this.npcSpawns.deleteZone(name).then(ok => {
        if (ok) this.adminLog(`profile ${adminProfile} deleted npc zone '${name}'`);
        this.replyIfSameAdmin(mp, userId, myActorId, ok, ok ? `Deleted zone ${name}` : "Unknown zone");
        if (ok) this.sendZones(mp, userId, myActorId);
      }).catch(e => {
        this.log(`AdminSystem: npcZoneDelete '${name}' by profile ${adminProfile} failed: ${e}`);
        this.replyIfSameAdmin(mp, userId, myActorId, false, "Action failed, see server log");
      });
      return;
    }
    if (action === "npcZoneReset") {
      const ok = this.npcSpawns.resetZone(name);
      if (ok) this.adminLog(`profile ${adminProfile} reset npc zone '${name}'`);
      this.reply(mp, userId, ok, ok ? `Reset zone ${name}` : "Unknown zone");
      if (ok) this.sendZones(mp, userId, myActorId);
      return;
    }
    if (action === "npcZoneTp") {
      const target = this.npcSpawns.teleportTarget(name);
      if (!target) {
        this.reply(mp, userId, false, "Unknown zone");
        return;
      }
      try {
        mp.set(myActorId, "locationalData", { cellOrWorldDesc: target.cellOrWorldDesc, pos: target.pos, rot: [0, 0, 0] });
        this.adminLog(`profile ${adminProfile} teleported to npc zone '${name}'`);
        this.reply(mp, userId, true, `Teleported to ${name}`);
      } catch (e) {
        this.log(`AdminSystem: npcZoneTp '${name}' by profile ${adminProfile} failed: ${e}`);
        this.reply(mp, userId, false, "Teleport failed, see server log");
      }
      return;
    }
    this.reply(mp, userId, false, `Unknown action '${action}'`);
  }

  private toggleMode(mp: Mp, userId: number, actorId: number, adminProfile: number, mode: string): void {
    if (!ADMIN_MODES.some(m => m.id === mode)) {
      this.reply(mp, userId, false, `Unknown mode '${mode}'`);
      return;
    }
    const state = this.modesByProfile.get(adminProfile) ?? {};
    state[mode] = !state[mode];
    this.modesByProfile.set(adminProfile, state);
    const on = !!state[mode];
    if (MIRRORED_MODES.includes(mode)) this.writeModeMirror(mp, actorId, state);
    this.sendMode(mp, userId, mode, on);
    this.adminLog(`profile ${adminProfile} turned mode ${mode} ${on ? "on" : "off"}`);
  }

  // Registration lives in gamemode.js; a missing property must not break the toggle
  private writeModeMirror(mp: Mp, actorId: number, state: Record<string, boolean>): void {
    try {
      const mirror: Record<string, boolean> = {};
      for (const m of MIRRORED_MODES) mirror[m] = !!state[m];
      mp.set(actorId, "ff_adminModes", mirror);
    } catch (e) {
      this.log(`AdminSystem: ff_adminModes mirror failed (property registered in gamemode.js?): ${e}`);
    }
  }

  private sendMode(mp: Mp, userId: number, mode: string, on: boolean): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminMode", mode, on }));
    } catch { }
  }

  private profileOf(mp: Mp, actorId: number): number {
    try { return Number(mp.get(actorId, "profileId")) || 0; } catch { return 0; }
  }

  // Modes live in memory per profile but the mirror persists on the actor; re-push them on reconnect and clear a stale mirror
  private resyncModes(mp: Mp, userId: number, actorId: number, isAdmin: boolean): void {
    const profileId = this.profileOf(mp, actorId);
    if (!isAdmin) this.modesByProfile.delete(profileId);
    const state = this.modesByProfile.get(profileId) ?? {};
    let mirror: Record<string, unknown> | null = null;
    try { mirror = mp.get(actorId, "ff_adminModes") ?? null; } catch { }
    if (MIRRORED_MODES.some(m => !!mirror?.[m] !== !!state[m])) this.writeModeMirror(mp, actorId, state);
    for (const m of ADMIN_MODES) {
      if (state[m.id]) this.sendMode(mp, userId, m.id, true);
    }
  }

  // C++ fires onHitDamageAttempt before applying weapon and spell damage; returning false refuses it
  private installGodModeHook(mp: Mp): void {
    const previous = typeof mp.onHitDamageAttempt === "function" ? mp.onHitDamageAttempt : null;
    mp.onHitDamageAttempt = (aggressorId: number, targetId: number, sourceId: number, damage: number): boolean => {
      if (this.hasMode(mp, targetId, "god")) return false;
      if (!previous) return true;
      try {
        return previous.call(mp, aggressorId, targetId, sourceId, damage) !== false;
      } catch {
        return true;
      }
    };
  }

  private hasMode(mp: Mp, actorId: number, mode: string): boolean {
    if (this.modesByProfile.size === 0) return false;
    const profileId = this.profileOf(mp, actorId);
    return profileId > 0 && !!this.modesByProfile.get(profileId)?.[mode];
  }

  private banViaBackend(
    mp: Mp,
    ctx: SystemContext,
    userId: number,
    adminActorId: number,
    target: { userId: number; actorId: number; profileId: number; name: string },
    adminProfile: number,
    tier: AdminTier
  ): void {
    if (!this.masterUrl || !this.masterKey || !this.authToken) {
      this.reply(mp, userId, false, "Ban unavailable: master api not configured");
      return;
    }
    if (!target.profileId) {
      this.reply(mp, userId, false, "Ban unavailable: target has no profile id");
      return;
    }
    fetch(`${this.masterUrl}/api/servers/${this.masterKey}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": this.authToken },
      body: JSON.stringify({
        profileId: target.profileId,
        reason: "in-game admin ban",
        bannedBy: `profile ${adminProfile} (${tier})`,
      }),
    }).then(res => {
      if (res.ok) {
        // Boot AND drop the connection; connection-check refuses the reconnect
        try { ctx.svr.setEnabled(target.actorId, false); } catch { }
        try { kickWithReason(mp, target.userId, "You were banned from the server."); } catch { }
        this.log(`AdminSystem: profile ${adminProfile} (${tier}) banned profile ${target.profileId} (${target.name})`);
        this.adminLog(`profile ${adminProfile} (${tier}) banned ${target.name} (profile ${target.profileId})`);
        this.replyIfSameAdmin(mp, userId, adminActorId, true, `Banned ${target.name}`);
      } else {
        this.log(`AdminSystem: backend ban failed with status ${res.status}`);
        this.replyIfSameAdmin(mp, userId, adminActorId, false, `Ban failed (backend ${res.status})`);
      }
    }).catch(e => {
      this.log(`AdminSystem: backend ban request failed: ${e}`);
      this.replyIfSameAdmin(mp, userId, adminActorId, false, "Ban failed: backend unreachable");
    });
  }

  // The HTTP round-trip outlives the packet handler; verify the userId slot still belongs to the same admin before sending the toast
  private replyIfSameAdmin(mp: Mp, userId: number, adminActorId: number, ok: boolean, text: string): void {
    try {
      if (mp.getUserActor(userId) !== adminActorId) return;
    } catch {
      return;
    }
    this.reply(mp, userId, ok, text);
  }
}
