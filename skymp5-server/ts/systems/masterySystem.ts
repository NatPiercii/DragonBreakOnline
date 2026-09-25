import * as fs from "fs";
import * as path from "path";
import * as P from "./skillPoints";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { npcLevel } from "./espmMagic";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── DragonBreak skills: up to three skills per character, five tiers each ─────
//
// Grown from Alduinak's one-profession mastery system. A character chooses up
// to `maxChosen` skills (default 3) from skills.json. Each skill ranks up on
// its own from server-verified activity: one point per qualifying event, with
// a minimum gap between points, so points are hours of work. Tier thresholds
// come from skills.json `tierHours`. Every tier grants an inert marker spell
// (DBO_Skill_<id>_T<n> in the DragonBreak plugin); recipes carry HasSpell
// conditions on those markers, the one gate the crafting menu and the server
// both honour. When a tier changes, the linked vanilla actor values are set
// server-side (15 per tier) so proficiency rides the vanilla formulas.
//
// Stations and nodes are gated in onActivate: a station listed under a skill's
// `gates.stations` refuses anyone without that skill; a Harvesting node gives
// an unskilled player a slim chance and skilled players extra yield.
//
// Respec happens at standing stones: activating one opens the menu in respec
// mode for two minutes; the first respec is free, later ones cost gold.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "masteryInfoRequest" }
//     { customPacketType: "masteryChoose", profession: "<id>" }
//     { customPacketType: "masteryDrop", profession: "<id>" }      respec mode only
//   Server -> Client:
//     { customPacketType: "masteryMenu", maxChosen, tierNames, tierHours, categories,
//       skills: [{id, category, label, title, description, tiers}],
//       chosen: [{id, rank, hours}], respec: {open, free, cost, count},
//       profession, rank, hours, rankHours, professions }        (legacy fields)
//     { customPacketType: "masteryNotice", text }
//
// Persistence: `private.mastery` on the character's actor form.
//   { skills: { <id>: { points, lastPointAt, rank, granted[] } }, order: [<id>], respecs }
// A legacy one-profession record is migrated on first read.

const MASTERY_PROP = "private.mastery";
const SKILLS_FILE = "skills.json";
const GOLD_BASE_ID = 0x0000000f;

const DEFAULT_TIER_HOURS = [0, 10, 30, 70, 150];
const DEFAULT_TIER_NAMES = ["Novice", "Apprentice", "Journeyman", "Expert", "Master"];
const DEFAULT_MAX_CHOSEN = 3;
const DEFAULT_POINT_INTERVAL_MINUTES = 60;
const DEFAULT_RESPEC_GOLD = 1200;
const RESPEC_WINDOW_MS = 120000;
const CHOOSE_COOLDOWN_MS = 1000;
export const MAX_GRANT = 1000;
const MAX_QUEUED_EVENTS = 4096;
const ACTIVATE_REACH = 600;
const RANGED_REACH = 8192;
const MELEE_REACH = 400;
const ANIM_BOW = 7;
const ANIM_CROSSBOW = 9;
const INVALID_USER_ID = 65535;
const LOGIN_GRANT_DELAY_MS = 5000;
const AV_PER_TIER = 15;
// Phase 0 of the point system (serverSKILLS_DESIGN.md): before any gain curve is tuned we need to know
// what a real hour of play actually produces. This only counts and logs; nothing about crediting changes.
const CREDIT_LOG_MS = 900000;

// Kept for AdminSystem's rank display; index = rank (0..4).
export let RANK_NAMES = DEFAULT_TIER_NAMES.slice();

// Vanilla actor value names as the Papyrus VM knows them.
const AV_NAMES: Record<string, string> = {
  TwoHanded: "TwoHanded", Archery: "Marksman", OneHanded: "OneHanded", Block: "Block",
  LightArmor: "LightArmor", HeavyArmor: "HeavyArmor", Destruction: "Destruction", Conjuration: "Conjuration",
  Illusion: "Illusion", Restoration: "Restoration", Alteration: "Alteration", Smithing: "Smithing",
  Alchemy: "Alchemy", Enchanting: "Enchanting", Lockpicking: "Lockpicking", Sneak: "Sneak", Speech: "Speechcraft",
};
// Magic effect DATA "magic skill" actor value index -> school name.
const MAGIC_SKILL_AV: Record<number, string> = { 18: "Alteration", 19: "Conjuration", 20: "Destruction", 21: "Illusion", 22: "Restoration" };
// WEAP DNAM animation type -> weapon class.
const WEAPON_CLASS: Record<number, string> = {
  0: "HandToHand", 1: "Sword", 2: "Dagger", 3: "WarAxe", 4: "Mace", 5: "Greatsword", 6: "Battleaxe", 7: "Bow", 8: "Staff", 9: "Crossbow",
};
// Warhammers share DNAM type 6 with battleaxes; both count as two-handed.
const TWO_HANDED = new Set(["Greatsword", "Battleaxe", "Warhammer"]);
// Blade and Blunt replaced One-Handed and Two-Handed (suggestions forum, Nat 2026-09-24): swords, daggers and greatswords
// are Blade; axes, maces, warhammers and battleaxes Blunt, as in Oblivion. A record still holding the old ids is moved on its
// first read by the weapons the character fought with, keeping every level: one old skill goes to the side they used, two go
// to both with the higher on that side, so the pool, the seat limits and the character level are unchanged.
const OLD_MELEE = ["onehanded", "twohanded"];
const BLADE_CLASSES = new Set(["Sword", "Dagger", "Greatsword"]);
const BLUNT_CLASSES = new Set(["WarAxe", "Mace", "Battleaxe", "Warhammer"]);
const MELEE_TABLE = "melee-migration.json";
// Skyrim.esm:0001F4 "Unarmed" - the source form the engine reports for a punch or a claw.
const UNARMED_WEAPON = 0x1f4;

interface SkillDef {
  id: string;
  category: string;
  label: string;
  title: string;
  description: string;
  tiers: string[];
  vanillaSkills: string[];
  counts: Record<string, unknown>;
  gates: Record<string, unknown>;
}

interface SkillProgress {
  level: number;             // hours in the old system, the level itself under pointSystem.
                             // Stored beside a derived `points` shim; see write(). skillPoints.ts calls
                             // it `level` too, and the two names disagreeing silently cost a play session.
  lastPointAt: number;
  rank: number;
  granted: number[];
  xp?: number;               // progress inside the current level, 0..100
  lock?: P.Lock;             // raise, hold or lower: who gives way when the pool is full
  bucket?: P.Bucket;
  ring?: P.NoveltyEntry[];   // recent targets, so repetition is worth less
  day?: string;
  spentToday?: number;
  // Units of work done on a skill the character has not taken up yet. Costs no pool and never
  // appears in `order`, because the level stays 0 until the player accepts the offer (see takeUp).
  shadow?: number;
  offered?: boolean;
}

interface MasteryRecord {
  skills: Record<string, SkillProgress>;
  order: string[];
  respecs: number;
  v?: number;                // 2 once the record holds levels rather than hours
  day?: string;
  spentToday?: number;
}

export interface MasterySummary {
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
}

interface ResolvedRules {
  craftKeywords: Set<number>;
  craftStations: Set<number>;
  activatePrefixes: string[];
  activateTypes: Set<string>;
  eatIngredient: boolean;
  killKeywords: Set<number>;
  hitKeywords: Set<number>;
  weaponTypes: Set<string>;
  spellSchools: Set<string>;
  damageTakenWhileArmored: boolean;
  blockEvents: boolean;
  gateStations: Set<number>;
  gatePrefixes: string[];
  gateNodes: boolean;
}

const POINT_REFUSE_NOTICE_MS = 600000;

// "mine", "chop" and "read" are activations that finished a mini-game rather than a bare touch: they
// are matched exactly like "activate" (same reach, same prefix and type rules) but weighed higher,
// because a round of work is not one keypress. Nothing but the weight and the novelty ring tells them
// apart from "activate", so a kind missing from this list is dropped silently by enqueue().
// "skin" is a won skinning round (gamemode.js judges it), bound to the Skinner as "prayer" is to the Priest.
const ACTIVITY_KINDS = ["craft", "activate", "mine", "chop", "read", "eat", "kill", "hit", "cast", "hurt", "prayer", "lock", "skin"] as const;
type ActivityKind = typeof ACTIVITY_KINDS[number];

// Where an item's gold value sits, per record type. Measured over this whole load order rather than
// remembered - see productValue() and `server\item-value-layout.json`. ARMO keeps its armour rating
// in DNAM, not DATA, so DATA is (value, weight) like the simple types; AMMO and BOOK are the two that
// are not. Every winner below scored 100% plausible against its runner-up's 2-44%.
const PRODUCT_VALUE_AT: Record<string, { field: string; offset: number }> = {
  WEAP: { field: "DATA", offset: 0 },   // 4891 records, value@0 weight@4, 4891/4891
  ARMO: { field: "DATA", offset: 0 },   // 7346 records, value@0 weight@4, 7346/7346
  MISC: { field: "DATA", offset: 0 },   // 1623 records, value@0 weight@4, 1623/1623
  INGR: { field: "DATA", offset: 0 },   //  442 records, value@0 weight@4,  442/442
  SLGM: { field: "DATA", offset: 0 },   //   26 records, value@0 weight@4,   26/26
  SCRL: { field: "DATA", offset: 0 },   //  172 records, value@0 weight@4,  172/172
  KEYM: { field: "DATA", offset: 0 },   //  799 records, value@0 weight@4,  798/798
  // AMMO is the trap: DATA is projectile@0, flags@4, DAMAGE as a float@8, value@12. A first pass put
  // it at 4 and was reading the flags. Confirmed by the arrow ladder: iron 1, steel 2, orcish 3,
  // dwarven 4, elven 5, glass 6, ebony 7, daedric 8 at offset 12, against damage 8/10/12..24 at 8.
  AMMO: { field: "DATA", offset: 12 },  //  111 records, value@12 (some DATA are 16 bytes, not 20)
  BOOK: { field: "DATA", offset: 8 },   // offset 0 is a 4-value flag enum, 8 is gold (tome 44..725)
  ALCH: { field: "ENIT", offset: 0 },   //  896 records; ALCH keeps weight alone in DATA, value in ENIT
};

interface ActivityEvent {
  kind: ActivityKind;
  actorId: number;
  detail: Record<string, number>;
}

interface BaseInfo { id: number; type: string; editorId: string; }
interface Location { cell: string; pos: number[]; }

const emptyRecord = (): MasteryRecord => ({ skills: {}, order: [], respecs: 0 });
const emptyProgress = (): SkillProgress => ({ level: 0, lastPointAt: 0, rank: 0, granted: [] });
const stringList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];

export class MasterySystem implements System {
  systemName = "MasterySystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    this.loadSkillsFile();
    const interval = Number(all?.["masteryPointIntervalMinutes"]);
    if (Number.isFinite(interval) && interval > 0) this.intervalMs = interval * 60000;
    await this.loadRules(ctx, s.dataDir, s.loadOrder);
    const ladder = this.points
      ? `point system ON: pool ${this.points.pool}, cap ${this.points.capPerSkill}, one skill over ${this.points.seatAbove}, ${this.points.expertCount} over ${this.points.expertAbove}`
      : `${this.maxChosen} chosen, tiers at ${this.tierHours.join("/")}h`;
    this.log(`[skills] ready: ${this.skills.length} skills, ${ladder}, ${Object.keys(this.spells).length} skills have marker spells, respec ${this.respecGold} gold after the first`);

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    (globalThis as any).__alduinakMasteryEvent = (kind: string, actorId: number, detail: unknown) => this.enqueue(kind, actorId, detail);
    // A first touch the gameplay layer decides on: spells.js takes up a school's skill when a Novice tome is read at a
    // spell study point (Nate, 2026-09-25). "ok", "held" (already taken up), "full" (no pool point free) or "unknown".
    (globalThis as any).__alduinakMasteryFirstTouch = (actorId: number, skillId: string): string => this.firstTouchFromGameplay(ctx, Number(actorId) >>> 0, String(skillId));
    this.hookNativeEvents(ctx);
  }

  // ── Definitions ─────────────────────────────────────────────────────────────

  private loadSkillsFile(): void {
    let raw: any = null;
    for (const dir of [process.cwd(), path.dirname(process.argv[1] || ""), path.join(process.cwd(), "..")]) {
      try { raw = JSON.parse(fs.readFileSync(path.join(dir, SKILLS_FILE), "utf8")); this.log(`[skills] loaded ${path.join(dir, SKILLS_FILE)}`); break; } catch { /* next */ }
    }
    if (!raw) { this.log(`[skills] ${SKILLS_FILE} not found next to the server; no skills available`); return; }
    const ps = raw.pointSystem && typeof raw.pointSystem === "object" ? raw.pointSystem : null;
    if (ps && ps.enabled === true) {
      const caps = ps.dailyCaps && typeof ps.dailyCaps === "object" ? ps.dailyCaps : {};
      const num = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
      this.points = {
        pool: num(ps.pool, 300), capPerSkill: num(ps.capPerSkill, 100),
        seatAbove: num(ps.seatAbove, 90), seatCount: num(ps.seatCount, 1),
        expertAbove: num(ps.expertAbove, 75), expertCount: num(ps.expertCount, 3),
        transferFloor: num(ps.transferFloor, 25), firstTouchCost: num(ps.firstTouchCost, 1),
        bucketBurst: num(ps.bucketBurst, 20), bucketPerHour: num(ps.bucketPerHour, 30),
        dailyCaps: { low: num(caps.low, 360), expert: num(caps.expert, 180), master: num(caps.master, 60) },
        characterDaily: num(ps.characterDaily, 1080),
      };
    }
    const hours = Array.isArray(raw.tierHours) ? raw.tierHours.map(Number).filter(Number.isFinite) : [];
    if (hours.length >= 2) this.tierHours = hours;
    const names = stringList(raw.tierNames);
    if (names.length === this.tierHours.length) { this.tierNames = names; RANK_NAMES = names.slice(); }
    const max = Number(raw.maxChosen); if (Number.isFinite(max) && max > 0) this.maxChosen = max;
    const respec = raw.respec && typeof raw.respec === "object" ? raw.respec : {};
    const cost = Number(respec.goldCostAfterFirst); if (Number.isFinite(cost) && cost >= 0) this.respecGold = cost;
    this.firstRespecFree = respec.firstRespecFree !== false;
    this.categories = Array.isArray(raw.categories) ? raw.categories.filter((c: any) => c && typeof c.id === "string") : [];
    this.skills = (Array.isArray(raw.skills) ? raw.skills : []).filter((k: any) => k && typeof k.id === "string").map((k: any) => ({
      id: String(k.id), category: String(k.category || ""), label: String(k.label || k.id), title: String(k.title || ""),
      description: String(k.description || ""), tiers: stringList(k.tiers), vanillaSkills: stringList(k.vanillaSkills),
      counts: k.counts && typeof k.counts === "object" ? k.counts : {}, gates: k.gates && typeof k.gates === "object" ? k.gates : {},
    }));
    const h = raw.skills && raw.skills.find((k: any) => k.id === "harvesting");
    if (h) {
      const c = Array.isArray(h.yieldChanceByTier) ? h.yieldChanceByTier.map(Number) : [];
      const m = Array.isArray(h.yieldMultiplierByTier) ? h.yieldMultiplierByTier.map(Number) : [];
      if (c.length) this.harvestChance = c;
      if (m.length) this.harvestMult = m;
      if (h.unskilled) { this.unskilledChance = Number(h.unskilled.yieldChance) || 0; this.unskilledMult = Number(h.unskilled.yieldMultiplier) || 0; }
    }
  }

  private def(id: string): SkillDef | undefined { return this.skills.find((k) => k.id === id); }
  private labelOf(id: string): string { const d = this.def(id); return d ? d.label : id; }

  // ── Hooks ───────────────────────────────────────────────────────────────────

  private hookNativeEvents(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const chain = (name: string, kind: ActivityKind, pick: (args: unknown[]) => [unknown, Record<string, unknown>] | null, gate?: (args: unknown[]) => boolean) => {
      const previous = typeof mp[name] === "function" ? mp[name] : null;
      mp[name] = (...args: unknown[]) => {
        if (gate && gate(args) === false) return false;
        const verdict = previous ? previous(...args) : undefined;
        if (verdict !== false) {
          const picked = pick(args);
          if (picked) this.enqueue(kind, picked[0], picked[1]);
        }
        return verdict;
      };
    };
    chain("onCraft", "craft", ([actorId, , , recipeId]) =>
      [actorId, { recipeId, held: this.holdsInputs(ctx, Number(actorId) >>> 0, Number(recipeId) >>> 0) ? 1 : 0,
                  value: this.productValue(ctx, Number(recipeId) >>> 0) }]);
    chain("onActivate", "activate", ([refrId, casterId]) => [casterId, { refrId }], ([refrId, casterId]) => this.gateActivation(ctx, Number(refrId) >>> 0, Number(casterId) >>> 0));
    chain("onEatItem", "eat", ([actorId, baseId]) => [actorId, { baseId }]);
    // onHitDamage(aggressorId, targetId, sourceId, damage): credit the attacker (hit) and the defender (hurt).
    const prevHit = typeof mp.onHitDamage === "function" ? mp.onHitDamage : null;
    mp.onHitDamage = (...args: unknown[]) => {
      const verdict = prevHit ? prevHit(...args) : undefined;
      if (verdict !== false) {
        const [aggressorId, targetId, sourceId, damage] = args;
        // `damage` is the fourth argument and was being dropped. C++ never fires this event for a
        // hit of zero or less (ActionListener::FireHitDamageEvent returns early), so it is always > 0.
        this.enqueue("hit", aggressorId, { targetId, sourceId });
        this.enqueue("hurt", targetId, { aggressorId, sourceId, value: Number(damage) || 0 });
        try {
          if ((ctx.svr as Mp).get(Number(targetId) >>> 0, "isDead")) {
            // A kill is weighed by how hard the target was to kill. Max health is the natural measure
            // and is NOT readable here: `percentages` is a 0..1 fraction and GetBaseActorValues has no
            // property binding, so it needs C++. npcLevel is the available proxy, already used by
            // conjurationSystem, and it walks the template chain like EvaluateTemplate does.
            // A kill is rare enough to afford the espm walk; `hit` is not, and stays flat.
            this.enqueue("kill", aggressorId, { victimId: targetId, value: npcLevel(ctx.svr as Mp, Number(targetId) >>> 0) });
          }
        } catch { /* not an actor */ }
      }
      return verdict;
    };
    const prevCast = typeof mp.onSpellCast === "function" ? mp.onSpellCast : null;
    mp.onSpellCast = (...args: unknown[]) => {
      const verdict = prevCast ? prevCast(...args) : undefined;
      if (verdict !== false) { const [casterId, spellId] = args; this.enqueue("cast", casterId, { spellId, value: this.spellCost(ctx, Number(spellId) >>> 0) }); }
      return verdict;
    };
  }

  private enqueue(kind: string, actorId: unknown, detail: unknown): void {
    if (ACTIVITY_KINDS.indexOf(kind as ActivityKind) === -1) return;
    const numeric: Record<string, number> = {};
    if (detail && typeof detail === "object") for (const [k, v] of Object.entries(detail as Record<string, unknown>)) numeric[k] = Number(v) >>> 0;
    if (this.events.length >= MAX_QUEUED_EVENTS) this.events.shift();
    this.events.push({ kind: kind as ActivityKind, actorId: Number(actorId) >>> 0, detail: numeric });
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "masteryInfoRequest": this.sendMenu(ctx, userId); break;
      case "masteryChoose": this.onChoose(ctx, userId, content); break;
      case "masteryDrop": this.onDrop(ctx, userId, content); break;
      case "masteryLock": this.onLock(ctx, userId, content); break;
      case "masteryTakeUp": this.onTakeUp(ctx, userId, content); break;
      default: break;
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    this.flushPendingGrants(ctx);
    this.logCreditRate();
    if (!this.events.length) return;
    const batch = this.events.splice(0, this.events.length);
    for (const ev of batch) {
      try { this.creditActivity(ctx, ev); } catch (e) { this.log(`[skills] ${ev.kind} credit failed for ${ev.actorId.toString(16)}: ${e}`); }
    }
  }

  // Phase 0 measurement. One line per window, only when something happened, so a quiet server stays quiet.
  // events = validated activity the server saw, credits = points actually granted (the 60 min interval
  // swallows the rest), suppressed = events from a character who has chosen no skill yet.
  private logCreditRate(): void {
    const now = Date.now();
    if (!this.creditStats.since) { this.creditStats.since = now; return; }
    if (now - this.creditStats.since < CREDIT_LOG_MS) return;
    const st = this.creditStats;
    const minutes = Math.round((now - st.since) / 60000);
    const fmt = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${Math.round(n * 10) / 10}`).join(", ") || "none";
    if (st.events.size || st.credits.size || st.suppressed) {
      this.log(`[skills] credit rate (last ${minutes} min, ${st.actors.size} character(s)): events ${fmt(st.events)} | credited ${fmt(st.credits)} | no skill chosen ${st.suppressed}`);
    }
    this.creditStats = { events: new Map(), credits: new Map(), actors: new Set(), suppressed: 0, since: now };
  }

  // ── Gating (stations, nodes, standing stones) ───────────────────────────────

  // Returns false to refuse the activation. Also opens respec mode at standing stones
  // and rolls Harvesting on flora.
  private gateActivation(ctx: SystemContext, refrId: number, casterId: number): boolean {
    if (!refrId || !casterId) return true;
    let profileId = -1;
    try { profileId = Number((ctx.svr as Mp).get(casterId, "profileId")); } catch { /* not a player */ }
    if (!(profileId >= 0)) return true;
    const base = this.baseOf(ctx, refrId);
    if (!base) return true;
    const edid = base.editorId.toLowerCase();
    const userId = this.userOf(ctx, casterId);

    if (edid.startsWith("doomstone") || edid.startsWith("dlc2doomstone")) {
      this.respecUntil.set(casterId, Date.now() + RESPEC_WINDOW_MS);
      this.notice(ctx, userId, "The stone hums. Open your skills (K) to change your path.");
      this.sendMenu(ctx, userId);
      return true;
    }

    const rec = this.read(ctx, casterId) || emptyRecord();
    const has = (id: string) => rec.order.indexOf(id) !== -1;
    const keywords = base.type === "FURN" || base.type === "ACTI" ? this.baseKeywords(ctx, base.id) : new Set<number>();
    for (const k of this.skills) {
      const r = this.rules[k.id]; if (!r) continue;
      const gated = (r.gateStations.size && Array.from(r.gateStations).some((kw) => keywords.has(kw))) || r.gatePrefixes.some((p) => edid.startsWith(p));
      if (gated && !has(k.id)) {
        if (this.points) {
          if (P.firstTouch(rec as unknown as P.PointRecord, k.id, this.points)) {
            this.write(ctx, casterId, rec);
            this.notice(ctx, userId, `You set your hand to the ${k.label.toLowerCase()}'s work for the first time.`);
            this.syncRank(ctx, casterId, rec, k.id, userId);
            return true;
          }
          if (Date.now() - (this.lastDenyMs.get(casterId) || 0) > 1500) {
            this.lastDenyMs.set(casterId, Date.now());
            this.notice(ctx, userId, "Your hands are full. Mark a skill to fall (K) before taking up a new trade.");
          }
          return false;
        }
        if (Date.now() - (this.lastDenyMs.get(casterId) || 0) > 1500) {
          this.lastDenyMs.set(casterId, Date.now());
          this.notice(ctx, userId, `Only a ${k.label} may use this.`);
        }
        return false;
      }
    }
    if (base.type === "FLOR" || base.type === "TREE") return this.rollHarvest(ctx, casterId, userId, rec, base);
    return true;
  }

  // Unskilled: slim chance, half yield. Skilled: tier chance, extra units from the node's ingredient.
  private rollHarvest(ctx: SystemContext, actorId: number, userId: number, rec: MasteryRecord, base: BaseInfo): boolean {
    const prog = rec.skills["harvesting"];
    const tier = prog ? prog.rank : -1;
    const chance = tier >= 0 ? (this.harvestChance[Math.min(tier, this.harvestChance.length - 1)] ?? 1) : this.unskilledChance;
    const mult = tier >= 0 ? (this.harvestMult[Math.min(tier, this.harvestMult.length - 1)] ?? 1) : this.unskilledMult;
    if (Math.random() > chance) {
      if (Date.now() - (this.lastDenyMs.get(actorId) || 0) > 1500) { this.lastDenyMs.set(actorId, Date.now()); this.notice(ctx, userId, "You find nothing worth taking."); }
      return false;
    }
    // Extra yield beyond the engine's own single unit.
    const extra = Math.max(0, Math.round(mult) - 1);
    if (extra > 0) {
      const ingr = this.fieldFormIds(this.lookup(ctx, base.id), "PFIG")[0] || 0;
      if (ingr) {
        try {
          const mp = ctx.svr as Mp;
          const inv = mp.get(actorId, "inventory") || { entries: [] };
          const entries = Array.isArray(inv.entries) ? inv.entries.slice() : [];
          const hit = entries.find((e: any) => e && Number(e.baseId) === ingr && !e.worn);
          if (hit) hit.count = (Number(hit.count) || 0) + extra; else entries.push({ baseId: ingr, count: extra });
          mp.set(actorId, "inventory", { entries });
        } catch (e) { this.log(`[skills] extra harvest failed: ${e}`); }
      }
    }
    return true;
  }

  // ── Worked hours ────────────────────────────────────────────────────────────

  // Under the point system work is metered rather than counted: every skill that could match the act is
  // tested, the act is weighed, repetition on the same target is worth less, the token bucket decides how
  // much of it an hour can hold, and a gain past the pool takes from a skill the player marked to fall.
  private creditPoints(ctx: SystemContext, ev: ActivityEvent): void {
    const cfg = this.points; if (!cfg) return;
    // A character who has never touched a station has no record yet; banking is how one starts.
    const rec = this.read(ctx, ev.actorId) || (this.isPlayer(ctx, ev.actorId) ? emptyRecord() : null);
    if (!rec) { this.creditStats.suppressed++; return; }
    const now = Date.now();
    const userId = this.userOf(ctx, ev.actorId);
    const mult = this.xpMultOf(ctx, ev.actorId);
    let changed = false;
    for (const id of this.candidates.get(ev.kind) || []) {
      const rules = this.rules[id]; if (!rules) continue;
      const prog = rec.skills[id];
      // A trade is opened at its station, not by accident - but a skill with no station declared in
      // `gates` has nowhere to walk to and so no opening move at all, and every unit it earns is thrown
      // away for ever. Those skills bank their work instead and offer themselves once there is a level's
      // worth. Combat was the first such family; prayer, reading, lockpicking and harvesting are the rest,
      // and each was silently crediting nobody (measured 2026-09-20: a character who had prayed and taken
      // a deity had no `priest` record at all).
      if (!prog || prog.level < 1) {
        if (rules.gateStations.size || rules.gatePrefixes.length) continue;
        if (!this.matches(ctx, id, rules, ev)) continue;
        const bank = prog || (rec.skills[id] = emptyProgress());
        bank.shadow = (bank.shadow || 0) + P.weightOf({ kind: ev.kind, value: ev.detail["value"] }) * mult;
        changed = true;
        if (!bank.offered && bank.shadow >= P.unitsForLevel(1)) {
          bank.offered = true;
          const enough = this.def(id)?.category === "combat"
            ? "You have fought often enough this way to call it your own."
            : "You have done this often enough to call it your own.";
          this.notice(ctx, userId, `${enough} Open your skills (K) to take up ${this.labelOf(id)}.`);
          this.write(ctx, ev.actorId, rec);
          this.sendMenu(ctx, userId);
        }
        continue;
      }
      if (!this.matches(ctx, id, rules, ev)) continue;
      const rep = P.repetitionFactor(prog.ring || [], this.noveltyOf(ev), now);
      prog.ring = rep.ring;
      // `value` is the scale term weightOf asks for per kind (ore band, product value, target health).
      // It was never passed before, so every weight sat at its v=0 base and every scaling term in
      // weightOf was dead; an emitter that does not send one still gets that base.
      const units = P.weightOf({ kind: ev.kind, value: ev.detail["value"] }) * rep.factor * mult;
      const before = prog.level;
      const out = P.applyGain(rec as unknown as P.PointRecord, id, units, cfg, now);
      changed = true;
      // Phase 0 measures units, not levels: a level is far too rare to tune weights against.
      if (out.units > 0) this.creditStats.credits.set(id, (this.creditStats.credits.get(id) || 0) + out.units);
      if (out.refused === "pool") this.noticeRefused(ctx, userId, ev.actorId);
      if (out.gained > 0) {
        this.notice(ctx, userId, `Your ${this.labelOf(id)} rises to ${prog.level}.`);
        this.syncRank(ctx, ev.actorId, rec, id, userId);
      } else if (prog.level < before) {
        this.syncRank(ctx, ev.actorId, rec, id, userId);
      }
      for (const taken of out.tookFrom) {
        if (taken.levels <= 0) continue;
        this.notice(ctx, userId, `Your ${this.labelOf(taken.id)} slips to ${rec.skills[taken.id].level}.`);
        this.syncRank(ctx, ev.actorId, rec, taken.id, userId);
      }
    }
    if (changed) this.write(ctx, ev.actorId, rec);
  }

  // The same target, station or recipe again and again is worth less; this is the key the ring counts.
  private noveltyOf(ev: ActivityEvent): number {
    const d = ev.detail || {};
    const raw = d["refrId"] || d["recipeId"] || d["victimId"] || d["targetId"] || d["spellId"] || d["baseId"] || 0;
    return (Number(raw) >>> 0) ^ (ev.kind.charCodeAt(0) << 24);
  }

  private noticeRefused(ctx: SystemContext, userId: number, actorId: number): void {
    const now = Date.now();
    const last = this.lastRefuseMs.get(actorId) || 0;
    if (now - last < POINT_REFUSE_NOTICE_MS) return;
    this.lastRefuseMs.set(actorId, now);
    this.notice(ctx, userId, "Your hands are full. Mark a skill to fall (K) before this one can rise further.");
  }

  private creditActivity(ctx: SystemContext, ev: ActivityEvent): void {
    this.creditStats.events.set(ev.kind, (this.creditStats.events.get(ev.kind) || 0) + 1);
    this.creditStats.actors.add(ev.actorId);
    if (this.points) { this.creditPoints(ctx, ev); return; }
    const rec = this.read(ctx, ev.actorId);
    if (!rec || !rec.order.length) { this.creditStats.suppressed++; return; }
    const now = Date.now();
    let changed = false;
    // Hunger slows the work: the gamemode writes private.needs.xpMult (1 fed, 0.25 starving), and a
    // quarter rate means an hour of work takes four times as long to be counted.
    const interval = this.intervalMs / this.xpMultOf(ctx, ev.actorId);
    for (const id of rec.order) {
      const prog = rec.skills[id]; const rules = this.rules[id];
      if (!prog || !rules) continue;
      const elapsed = now - prog.lastPointAt;
      if (elapsed >= 0 && elapsed < interval) continue;
      if (!this.matches(ctx, id, rules, ev)) continue;
      prog.level += 1; prog.lastPointAt = now; changed = true;
      this.creditStats.credits.set(id, (this.creditStats.credits.get(id) || 0) + 1);
      const userId = this.userOf(ctx, ev.actorId);
      this.notice(ctx, userId, `Your work as a ${this.labelOf(id)} is counted: ${prog.level} ${prog.level === 1 ? "hour" : "hours"}.`);
      this.syncRank(ctx, ev.actorId, rec, id, userId);
    }
    if (changed) this.write(ctx, ev.actorId, rec);
  }

  // 0 < mult <= 1 from the needs record times the raid penalty (dungeons.js private.partyXpMult); anything missing or odd counts as 1
  private xpMultOf(ctx: SystemContext, actorId: number): number {
    const mp = ctx.svr as Mp;
    const clamp = (v: unknown) => { const m = Number(v); return Number.isFinite(m) && m > 0 && m <= 1 ? m : 1; };
    let mult = 1;
    try { const needs = mp.get(actorId, "private.needs"); mult *= clamp(needs && typeof needs === "object" ? needs.xpMult : 1); } catch { /* fed */ }
    try { mult *= clamp(mp.get(actorId, "private.partyXpMult")); } catch { /* no party */ }
    return mult;
  }

  private matches(ctx: SystemContext, skillId: string, rules: ResolvedRules, ev: ActivityEvent): boolean {
    switch (ev.kind) {
      case "craft": {
        const bench = this.recipeBench(ctx, ev.detail["recipeId"]);
        if (!ev.detail["held"] || !bench) return false;
        const byKeyword = rules.craftKeywords.has(bench);
        if (!byKeyword && !rules.craftStations.size) return false;
        return this.benchInReach(ctx, ev.actorId, bench, (keywords) => byKeyword || Array.from(rules.craftStations).some((k) => keywords.has(k)));
      }
      case "activate": case "mine": case "chop": case "read": {
        const refrId = ev.detail["refrId"];
        const loc = this.locationOf(ctx, ev.actorId);
        if (!loc || !this.inReach(ctx, loc, refrId) || this.isDisabled(ctx, refrId)) return false;
        const base = this.baseOf(ctx, refrId);
        if (!base) return false;
        if (rules.activateTypes.has(base.type)) return true;
        const edid = base.editorId.toLowerCase();
        return rules.activatePrefixes.some((p) => edid.startsWith(p));
      }
      case "eat": return rules.eatIngredient && this.recordType(ctx, ev.detail["baseId"]) === "INGR";
      case "kill": return this.combatCounts(ctx, ev.actorId, ev.detail["victimId"], rules.killKeywords, RANGED_REACH);
      case "hit": {
        if (!rules.hitKeywords.size) return false;
        const targetId = ev.detail["targetId"]; const sourceId = ev.detail["sourceId"];
        const reach = this.hitReach(ctx, sourceId);
        if (reach <= 0 || this.isDead(ctx, targetId)) return false;
        if (rules.weaponTypes.size) {
          const cls = this.weaponClass(ctx, sourceId);
          const ok = rules.weaponTypes.has(cls) || (cls === "Battleaxe" && rules.weaponTypes.has("Warhammer"));
          if (!ok) return false;
        }
        return this.combatCounts(ctx, ev.actorId, targetId, rules.hitKeywords, reach);
      }
      case "hurt": return rules.damageTakenWhileArmored && this.wearsArmor(ctx, ev.actorId);
      case "cast": {
        if (!rules.spellSchools.size) return false;
        const school = this.spellSchool(ctx, ev.detail["spellId"]);
        return !!school && rules.spellSchools.has(school);
      }
      case "prayer": return skillId === "priest";
      case "lock": return skillId === "lockpicking";
      case "skin": return skillId === "skinner";
      default: return false;
    }
  }

  // ── Admin API (shape kept for AdminSystem) ──────────────────────────────────

  summaryOf(ctx: SystemContext, actorId: number): MasterySummary {
    const rec = this.read(ctx, actorId) || emptyRecord();
    const ranks = rec.order.map((id) => rec.skills[id] ? rec.skills[id].rank : 0);
    const hours = rec.order.reduce((s, id) => s + (rec.skills[id] ? rec.skills[id].level : 0), 0);
    const top = ranks.length ? Math.max(...ranks) : 0;
    return {
      profession: rec.order.length ? rec.order.join(",") : null,
      label: rec.order.map((id) => `${this.labelOf(id)} ${this.tierNames[rec.skills[id]?.rank || 0] || ""}`).join(", "),
      rank: top, rankName: this.tierNames[top] || "", hours,
    };
  }

  grantPoints(ctx: SystemContext, actorId: number, amount: number, skillId?: string): MasterySummary | null {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GRANT) return null;
    const rec = this.read(ctx, actorId) || emptyRecord();
    const id = skillId && rec.order.indexOf(skillId) !== -1 ? skillId : rec.order[0];
    if (!id) return null;
    const prog = rec.skills[id];
    prog.level = Math.max(0, prog.level + amount);
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, `Your hours as a ${this.labelOf(id)} now stand at ${prog.level}.`);
    this.syncRank(ctx, actorId, rec, id, userId);
    this.write(ctx, actorId, rec);
    return this.summaryOf(ctx, actorId);
  }

  resetCharacter(ctx: SystemContext, actorId: number): boolean {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.order.length) return false;
    for (const id of rec.order.slice()) this.dropSkill(ctx, actorId, rec, id);
    rec.respecs = 0;
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, "Your skills have been set aside. You may choose again.");
    this.sendMenu(ctx, userId);
    return true;
  }

  // Every skill with its label, which of them the character follows and at what tier, for the admin Skills tab
  adminDetail(ctx: SystemContext, actorId: number): { skills: Array<{ id: string; label: string; chosen: boolean; rank: number; hours: number }>; tierNames: string[]; tierHours: number[]; maxChosen: number } {
    const rec = this.read(ctx, actorId) || emptyRecord();
    return {
      skills: this.skills.map((k) => ({ id: k.id, label: k.label, chosen: rec.order.indexOf(k.id) !== -1, rank: rec.skills[k.id]?.rank ?? -1, hours: rec.skills[k.id]?.level ?? 0 })),
      tierNames: this.tierNames.slice(), tierHours: this.tierHours.slice(), maxChosen: this.maxChosen,
    };
  }

  // Admin: puts the character at the start of a tier in a skill, taking the skill up first if needed (the chosen-skill limit does not apply)
  adminSetTier(ctx: SystemContext, actorId: number, skillId: string, tier: number): boolean {
    if (!this.def(skillId) || !Number.isInteger(tier) || tier < 0 || tier >= this.tierHours.length) return false;
    const rec = this.read(ctx, actorId) || emptyRecord();
    const userId = this.userOf(ctx, actorId);
    if (rec.order.indexOf(skillId) === -1) {
      rec.order.push(skillId);
      rec.skills[skillId] = rec.skills[skillId] || emptyProgress();
      rec.skills[skillId].rank = -1;
    }
    rec.skills[skillId].level = this.tierHours[tier];
    this.syncRank(ctx, actorId, rec, skillId, userId);
    this.applyActorValues(ctx, actorId, skillId, rec.skills[skillId].rank, rec);
    this.write(ctx, actorId, rec);
    this.sendMenu(ctx, userId);
    return true;
  }

  // Admin: sets one skill aside with no standing stone, no gold and no respec counted
  adminDropSkill(ctx: SystemContext, actorId: number, skillId: string): boolean {
    const rec = this.read(ctx, actorId);
    if (!rec || rec.order.indexOf(skillId) === -1) return false;
    this.dropSkill(ctx, actorId, rec, skillId);
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, `${this.labelOf(skillId)} has been set aside.`);
    this.sendMenu(ctx, userId);
    return true;
  }

  // ── Login ───────────────────────────────────────────────────────────────────

  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.order.length) return;
    for (const id of rec.order) {
      const prog = rec.skills[id];
      const corrected = this.rankFor(prog.level);
      if (corrected < prog.rank) this.revokeAbove(ctx, actorId, prog, id, corrected);
      prog.rank = corrected;
    }
    this.write(ctx, actorId, rec);
    this.pendingGrants.set(actorId, Date.now() + LOGIN_GRANT_DELAY_MS);
  }

  private flushPendingGrants(ctx: SystemContext): void {
    if (!this.pendingGrants.size) return;
    const now = Date.now();
    this.pendingGrants.forEach((dueAt, actorId) => {
      if (now < dueAt) return;
      this.pendingGrants.delete(actorId);
      const rec = this.read(ctx, actorId);
      if (!rec) return;
      for (const id of rec.order) { this.applySpells(ctx, actorId, rec, id); this.applyActorValues(ctx, actorId, id, rec.skills[id].rank, rec); }
      this.write(ctx, actorId, rec);
    });
  }

  // ── Choose / drop ───────────────────────────────────────────────────────────

  private onChoose(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastChooseMs.get(userId) || 0) < CHOOSE_COOLDOWN_MS) return;
    this.lastChooseMs.set(userId, now);
    const actorId = this.actorOf(ctx, userId); if (!actorId) return;
    const id = String(content["profession"] || "");
    if (!this.def(id)) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    if (rec.order.indexOf(id) !== -1) { this.notice(ctx, userId, `You already follow the ${this.labelOf(id)}.`); return; }
    if (rec.order.length >= this.maxChosen) { this.notice(ctx, userId, `You can follow ${this.maxChosen} skills. Set one aside at a standing stone first.`); return; }
    rec.order.push(id);
    rec.skills[id] = rec.skills[id] || emptyProgress();
    rec.skills[id].rank = this.rankFor(rec.skills[id].level);
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec, id);
    this.applyActorValues(ctx, actorId, id, rec.skills[id].rank, rec);
    this.write(ctx, actorId, rec);
    this.notice(ctx, userId, `You take up ${this.labelOf(id)}.`);
    this.sendMenu(ctx, userId);
  }

  private onDrop(ctx: SystemContext, userId: number, content: Content): void {
    const actorId = this.actorOf(ctx, userId); if (!actorId) return;
    const id = String(content["profession"] || "");
    const rec = this.read(ctx, actorId) || emptyRecord();
    if (rec.order.indexOf(id) === -1) return;
    if ((this.respecUntil.get(actorId) || 0) < Date.now()) { this.notice(ctx, userId, "Skills can only be set aside at a standing stone."); return; }
    const free = this.firstRespecFree && rec.respecs === 0;
    if (!free && this.respecGold > 0) {
      if (!this.takeGold(ctx, actorId, this.respecGold)) { this.notice(ctx, userId, `The stone asks ${this.respecGold} gold to change your path.`); return; }
    }
    this.dropSkill(ctx, actorId, rec, id);
    rec.respecs += 1;
    this.write(ctx, actorId, rec);
    this.notice(ctx, userId, `You set aside ${this.labelOf(id)}${free ? "" : ` for ${this.respecGold} gold`}. Its hours are lost.`);
    this.sendMenu(ctx, userId);
  }

  private dropSkill(ctx: SystemContext, actorId: number, rec: MasteryRecord, id: string): void {
    const prog = rec.skills[id];
    if (prog) { for (const spellId of prog.granted.slice()) this.removeSpell(ctx, actorId, spellId); }
    delete rec.skills[id];
    rec.order = rec.order.filter((x) => x !== id);
    this.applyActorValues(ctx, actorId, id, -1, rec);
  }

  private takeGold(ctx: SystemContext, actorId: number, amount: number): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory") || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.map((e: any) => Object.assign({}, e)) : [];
      let have = 0; for (const e of entries) if (Number(e.baseId) === GOLD_BASE_ID) have += Number(e.count) || 0;
      if (have < amount) return false;
      let left = amount;
      for (const e of entries) { if (Number(e.baseId) !== GOLD_BASE_ID || left <= 0) continue; const take = Math.min(left, Number(e.count) || 0); e.count = (Number(e.count) || 0) - take; left -= take; }
      mp.set(actorId, "inventory", { entries: entries.filter((e: any) => (Number(e.count) || 0) > 0) });
      return true;
    } catch (e) { this.log(`[skills] gold take failed: ${e}`); return false; }
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  // Which skill gives way when the pool is full: raise, hold or lower.
  private onLock(ctx: SystemContext, userId: number, content: Content): void {
    if (!this.points) return;
    const actorId = this.actorOf(ctx, userId); if (!actorId) return;
    const id = String((content as any).skill || "");
    const lock = String((content as any).lock || "");
    if (!this.def(id) || (lock !== "raise" && lock !== "hold" && lock !== "lower")) return;
    const rec = this.read(ctx, actorId); if (!rec) return;
    const prog = rec.skills[id]; if (!prog) return;
    prog.lock = lock as P.Lock;
    this.write(ctx, actorId, rec);
    this.sendMenu(ctx, userId);
  }

  // Accepts an offer made by creditPoints: spends one pool point on the skill, then credits every unit
  // banked while it was unopened, so the fighting done before the player agreed is not wasted.
  private onTakeUp(ctx: SystemContext, userId: number, content: Content): void {
    const cfg = this.points; if (!cfg) return;
    const actorId = this.actorOf(ctx, userId); if (!actorId) return;
    const id = String((content as any).skill || ""); if (!this.def(id)) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    const prog = rec.skills[id];
    if (prog && prog.level >= 1) return;                      // already held
    if (!prog || !prog.offered) return;                       // no offer stands for this skill
    if (!P.firstTouch(rec as unknown as P.PointRecord, id, cfg)) {
      this.notice(ctx, userId, "Your hands are full. Mark a skill to fall (K) before taking up a new trade.");
      return;
    }
    this.completeTakeUp(ctx, actorId, userId, rec, id, Math.max(0, Number(prog.shadow) || 0));
  }

  private firstTouchFromGameplay(ctx: SystemContext, actorId: number, id: string): string {
    const cfg = this.points; if (!cfg || !actorId || !this.def(id)) return "unknown";
    const rec = this.read(ctx, actorId) || emptyRecord();
    const prog = rec.skills[id];
    if (prog && prog.level >= 1) return "held";
    if (!P.firstTouch(rec as unknown as P.PointRecord, id, cfg)) return "full";
    this.completeTakeUp(ctx, actorId, this.userOf(ctx, actorId), rec, id, Math.max(0, Number(prog?.shadow) || 0));
    return "ok";
  }

  // After P.firstTouch has spent the pool point: settle the new entry, credit the banked units, write, and sync
  private completeTakeUp(ctx: SystemContext, actorId: number, userId: number, rec: MasteryRecord, id: string, banked: number): void {
    const cfg = this.points; if (!cfg) return;
    const fresh = rec.skills[id];
    // firstTouch rebuilds the entry as { level, xp, lock }: without granted and rank the tier-spell sync below threw
    // (playtest 2026-09-25), leaving the new skill's spells ungranted and the menu stale until the next rank change
    if (!Array.isArray(fresh.granted)) fresh.granted = [];
    if (!Number.isFinite(fresh.rank)) fresh.rank = 0;
    if (!Number.isFinite(fresh.lastPointAt)) fresh.lastPointAt = 0;
    fresh.shadow = 0; fresh.offered = false;
    this.notice(ctx, userId, `You take up ${this.labelOf(id)}.`);
    if (banked > 0) {
      const out = P.applyGain(rec as unknown as P.PointRecord, id, banked, cfg, Date.now());
      if (out.gained > 0) this.notice(ctx, userId, `Your ${this.labelOf(id)} rises to ${fresh.level}.`);
    }
    this.write(ctx, actorId, rec);
    this.syncRank(ctx, actorId, rec, id, userId);
    this.sendMenu(ctx, userId);
  }

  private sendMenu(ctx: SystemContext, userId: number): void {
    const actorId = this.actorOf(ctx, userId); if (!actorId) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    const chosen = rec.order.map((id) => ({ id, rank: rec.skills[id]?.rank || 0, hours: rec.skills[id]?.level || 0 }));
    const cfg = this.points;
    const points = cfg ? {
      enabled: true, pool: cfg.pool, capPerSkill: cfg.capPerSkill,
      seatAbove: cfg.seatAbove, seatCount: cfg.seatCount, expertAbove: cfg.expertAbove, expertCount: cfg.expertCount,
      transferFloor: cfg.transferFloor,
      used: Object.values(rec.skills).reduce((n, pr) => n + (pr.level || 0), 0),
      offers: Object.entries(rec.skills)
        .filter(([, pr]) => pr.level < 1 && pr.offered)
        .map(([id, pr]) => ({ id, banked: Math.round(pr.shadow || 0) })),
      held: Object.entries(rec.skills).filter(([, pr]) => pr.level >= 1)
        .map(([id, pr]) => ({ id, level: pr.level, xp: Math.round(pr.xp || 0), tier: pr.rank, lock: pr.lock || "raise" }))
        .sort((a, b) => b.level - a.level),
    } : undefined;
    const first = chosen[0];
    this.send(ctx, userId, {
      customPacketType: "masteryMenu",
      points,
      maxChosen: this.maxChosen, tierNames: this.tierNames, tierHours: this.tierHours, categories: this.categories,
      // `openable` tells the menu how this skill is taken up at all, because the two answers want
      // different words: a trade is opened by walking to its station, a stationless skill by working
      // at it until the bank offers. `hint` names the station in a player's words (skills.json
      // `gates.hint`) - without it the menu said "set your hand to its work" for a skill whose work
      // is a deer corpse, which read as "skinning is broken" in the 2026-09-20 playtest.
      skills: this.skills.map((k) => {
        const r = this.rules[k.id];
        const station = !!r && (r.gateStations.size > 0 || r.gatePrefixes.length > 0);
        return {
          id: k.id, category: k.category, label: k.label, title: k.title, description: k.description, tiers: k.tiers,
          openable: station ? "station" : "work",
          hint: String((k.gates as Record<string, unknown>)["hint"] || ""),
        };
      }),
      chosen,
      respec: { open: (this.respecUntil.get(actorId) || 0) > Date.now(), free: this.firstRespecFree && rec.respecs === 0, cost: this.respecGold, count: rec.respecs },
      // legacy fields for the old menu
      profession: first ? first.id : null, rank: first ? first.rank : 0, hours: first ? first.hours : 0, rankHours: this.tierHours,
      professions: this.skills.map((k) => ({ id: k.id, label: k.label, title: k.title })),
    });
  }

  // ── Ranks, marker spells, actor values ──────────────────────────────────────

  private rankFor(points: number): number {
    if (this.points) return Math.max(0, P.tierOfLevel(points));
    let rank = 0;
    for (let i = 0; i < this.tierHours.length; i++) if (points >= this.tierHours[i]) rank = i;
    return rank;
  }

  private syncRank(ctx: SystemContext, actorId: number, rec: MasteryRecord, id: string, userId: number): void {
    const prog = rec.skills[id]; if (!prog) return;
    const oldRank = prog.rank; const newRank = this.rankFor(prog.level);
    if (newRank < oldRank) this.revokeAbove(ctx, actorId, prog, id, newRank);
    prog.rank = newRank;
    this.applySpells(ctx, actorId, rec, id);
    if (newRank === oldRank) return;
    this.applyActorValues(ctx, actorId, id, newRank, rec);
    this.notice(ctx, userId, newRank > oldRank ? `You are now ${this.tierNames[newRank]} in ${this.labelOf(id)}.` : `Your standing in ${this.labelOf(id)} has fallen to ${this.tierNames[newRank]}.`);
  }

  private missingSpells(prog: SkillProgress, id: string): number[] {
    const list = this.spells[id]; if (!list) return [];
    const out: number[] = [];
    if (!Array.isArray(prog.granted)) prog.granted = [];
    for (let i = 0; i <= prog.rank && i < list.length; i++) { const s = list[i]; if (s && prog.granted.indexOf(s) === -1) out.push(s); }
    return out;
  }

  private applySpells(ctx: SystemContext, actorId: number, rec: MasteryRecord, id: string): void {
    const prog = rec.skills[id]; if (!prog) return;
    for (const spellId of this.missingSpells(prog, id)) { this.addSpell(ctx, actorId, spellId); prog.granted.push(spellId); }
  }

  private revokeAbove(ctx: SystemContext, actorId: number, prog: SkillProgress, id: string, keepRank: number): void {
    const list = this.spells[id]; if (!list) return;
    for (let i = keepRank + 1; i < list.length; i++) {
      const spellId = list[i]; const at = prog.granted.indexOf(spellId);
      if (spellId && at !== -1) { this.removeSpell(ctx, actorId, spellId); prog.granted.splice(at, 1); }
    }
  }

  // Vanilla actor values follow the tier: 15 per tier; -1 resets to the vanilla base of 15.
  // Blade and Blunt both drive OneHanded and TwoHanded, so each actor value takes the best rank among the skills held.
  private applyActorValues(ctx: SystemContext, actorId: number, id: string, rank: number, rec: MasteryRecord | null): void {
    const d = this.def(id); if (!d || !d.vanillaSkills.length) return;
    const mp = ctx.svr as Mp;
    for (const sk of d.vanillaSkills) {
      const av = AV_NAMES[sk]; if (!av) continue;
      let best = rank;
      for (const other of rec ? rec.order : []) {
        const od = this.def(other);
        if (other !== id && od && od.vanillaSkills.includes(sk) && rec!.skills[other]) best = Math.max(best, rec!.skills[other].rank);
      }
      const value = best < 0 ? 15 : AV_PER_TIER * (best + 1);
      try {
        const self = { type: "form", desc: mp.getDescFromId(actorId) };
        mp.callPapyrusFunction("method", "Actor", "SetActorValue", self, [av, value]);
      } catch (e) { this.log(`[skills] SetActorValue ${av} failed: ${e}`); }
    }
  }

  private addSpell(ctx: SystemContext, actorId: number, spellId: number): void {
    if (!spellId) return;
    const mp = ctx.svr as Mp;
    try { mp.callPapyrusFunction("method", "Actor", "AddSpell", { type: "form", desc: mp.getDescFromId(actorId) }, [{ type: "espm", desc: mp.getDescFromId(spellId) }, false]); }
    catch (e) { this.log(`[skills] could not grant spell ${spellId.toString(16)}: ${e}`); }
  }

  private removeSpell(ctx: SystemContext, actorId: number, spellId: number): void {
    if (!spellId) return;
    const mp = ctx.svr as Mp;
    try { mp.callPapyrusFunction("method", "Actor", "RemoveSpell", { type: "form", desc: mp.getDescFromId(actorId) }, [{ type: "espm", desc: mp.getDescFromId(spellId) }]); }
    catch (e) { this.log(`[skills] could not revoke spell ${spellId.toString(16)}: ${e}`); }
  }

  // ── Rules and marker resolution ─────────────────────────────────────────────

  private async loadRules(ctx: SystemContext, dataDir: string, loadOrder: string[]): Promise<void> {
    const wanted = new Set<string>();
    const raw: Record<string, { craftKeywords: string[]; craftStations: string[]; activatePrefixes: string[]; activateTypes: string[]; eatIngredient: boolean; killKeywords: string[]; hitKeywords: string[]; weaponTypes: string[]; spellSchools: string[]; damageTakenWhileArmored: boolean; blockEvents: boolean; gateStations: string[]; gatePrefixes: string[]; gateNodes: boolean }> = {};
    const markerNames: string[] = [];
    for (const k of this.skills) {
      const c = k.counts as Record<string, unknown>; const g = k.gates as Record<string, unknown>;
      const stations = stringList(g["stations"]);
      const r = {
        craftKeywords: stringList(c["craftKeywords"]), craftStations: stringList(c["craftStations"]),
        activatePrefixes: stringList(c["activatePrefixes"]), activateTypes: stringList(c["activateTypes"]),
        eatIngredient: !!c["eatIngredient"], killKeywords: stringList(c["killKeywords"]), hitKeywords: stringList(c["hitKeywords"]),
        weaponTypes: stringList(c["weaponTypes"]), spellSchools: stringList(c["spellCastSchools"]),
        damageTakenWhileArmored: !!c["damageTakenWhileArmored"], blockEvents: !!c["blockEvents"],
        // Every station entry is tried as a keyword first; whatever does not resolve gates by base editor id prefix instead.
        gateStations: stations,
        gatePrefixes: [] as string[],
        gateNodes: !!g["nodes"],
      };
      raw[k.id] = r;
      for (const w of r.craftKeywords.concat(r.craftStations, r.killKeywords, r.hitKeywords, r.gateStations)) wanted.add(w);
      for (let t = 1; t <= this.tierHours.length; t++) markerNames.push(`DBO_Skill_${k.id}_T${t}`);
    }
    wanted.add("ActorTypeNPC");
    const names = Array.from(wanted).concat(markerNames);
    const scan = await resolveEditorIds(names.filter(isEditorId), dataDir, loadOrder, this.log, ["KYWD", "SPEL"]);
    const mp = ctx.svr as Mp;
    const ids = new Map<string, number>(); const unresolved: string[] = [];
    for (const name of names) {
      let id = 0;
      try {
        if (name.includes(":")) id = mp.getIdFromDesc(name) >>> 0;
        else if (!isEditorId(name)) id = parseInt(name, 16) >>> 0;
        else { const desc = scan.resolved.get(name.toLowerCase()); if (desc) id = mp.getIdFromDesc(desc) >>> 0; }
      } catch { id = 0; }
      if (id) ids.set(name, id); else unresolved.push(name);
    }
    this.playerKeyword = ids.get("ActorTypeNPC") || 0;
    const missingMarkers = unresolved.filter((n) => n.startsWith("DBO_Skill_"));
    // Station names that are not keywords are fine: they become editor-id prefixes below.
    const stationNames = new Set<string>(); for (const k of this.skills) for (const n of raw[k.id].gateStations) stationNames.add(n);
    this.log(`[skills] resolved ${ids.size}/${names.length} form(s) in ${scan.scannedMs} ms${unresolved.length ? `, unresolved: ${unresolved.filter((n) => !n.startsWith("DBO_Skill_") && !stationNames.has(n)).join(", ") || "none"}` : ""}${missingMarkers.length ? `, ${missingMarkers.length} marker spell(s) missing` : ""}`);
    const toIds = (list: string[]): Set<number> => new Set(list.map((n) => ids.get(n) || 0).filter((v) => v));
    for (const k of this.skills) {
      const r = raw[k.id];
      this.rules[k.id] = {
        craftKeywords: toIds(r.craftKeywords), craftStations: toIds(r.craftStations),
        activatePrefixes: r.activatePrefixes.map((p) => p.toLowerCase()), activateTypes: new Set(r.activateTypes.map((t) => t.toUpperCase())),
        eatIngredient: r.eatIngredient, killKeywords: toIds(r.killKeywords), hitKeywords: toIds(r.hitKeywords),
        weaponTypes: new Set(r.weaponTypes), spellSchools: new Set(r.spellSchools), damageTakenWhileArmored: r.damageTakenWhileArmored, blockEvents: r.blockEvents,
        gateStations: toIds(r.gateStations), gatePrefixes: r.gateStations.filter((n) => !ids.has(n)).map((n) => n.toLowerCase()), gateNodes: r.gateNodes,
      };
      const list: number[] = [];
      for (let t = 1; t <= this.tierHours.length; t++) list.push(ids.get(`DBO_Skill_${k.id}_T${t}`) || 0);
      if (list.some((v) => v)) this.spells[k.id] = list;
    }
    this.indexCandidates();
  }

  private indexCandidates(): void {
    this.candidates = new Map();
    const add = (kind: string, id: string) => {
      const list = this.candidates.get(kind) || [];
      if (list.indexOf(id) === -1) list.push(id);
      this.candidates.set(kind, list);
    };
    for (const [id, r] of Object.entries(this.rules)) {
      if (r.craftKeywords.size || r.craftStations.size) add("craft", id);
      // The mini-game kinds match through the same rules as a bare activation, so a skill that can be
      // credited by touching a thing can also be credited by working it.
      if (r.activatePrefixes.length || r.activateTypes.size) { add("activate", id); add("mine", id); add("chop", id); add("read", id); }
      if (r.eatIngredient) add("eat", id);
      if (r.killKeywords.size) add("kill", id);
      if (r.hitKeywords.size) add("hit", id);
      if (r.spellSchools.size) add("cast", id);
      if (r.damageTakenWhileArmored) add("hurt", id);
    }
    add("prayer", "priest");
    add("lock", "lockpicking");
    add("skin", "skinner");
  }

  // ── Lookups ─────────────────────────────────────────────────────────────────

  private weaponClass(ctx: SystemContext, sourceId: number): string {
    const hit = this.weaponCache.get(sourceId); if (hit !== undefined) return hit;
    // The C++ damage formula calls a hit unarmed when its source is exactly this form
    // (TES5DamageFormula.cpp `IsUnarmedAttack`). Name it here without depending on the DNAM byte.
    if ((sourceId >>> 0) === UNARMED_WEAPON) { this.weaponCache.set(sourceId, "HandToHand"); return "HandToHand"; }
    const res = this.lookup(ctx, sourceId); let cls = "";
    if (res && String(res.record.type || "") === "WEAP") {
      const dnam = (res.record.fields || []).find((f: any) => f.type === "DNAM" && f.data instanceof Uint8Array && f.data.byteLength);
      cls = dnam ? (WEAPON_CLASS[dnam.data[0]] || "") : "";
    }
    this.weaponCache.set(sourceId, cls); return cls;
  }

  // School of a spell: the magic skill of its first magic effect.
  private spellSchool(ctx: SystemContext, spellId: number): string {
    const hit = this.schoolCache.get(spellId); if (hit !== undefined) return hit;
    let school = "";
    const spell = this.lookup(ctx, spellId);
    if (spell) {
      const effects = this.fieldFormIds(spell, "EFID");
      for (const mgefId of effects) {
        const mgef = this.lookup(ctx, mgefId); if (!mgef) continue;
        const data = (mgef.record.fields || []).find((f: any) => f.type === "DATA" && f.data instanceof Uint8Array && f.data.byteLength >= 16);
        if (!data) continue;
        const view = new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength);
        const av = view.getInt32(12, true);
        if (MAGIC_SKILL_AV[av]) { school = MAGIC_SKILL_AV[av]; break; }
      }
    }
    this.schoolCache.set(spellId, school); return school;
  }

  private wearsArmor(ctx: SystemContext, actorId: number): boolean {
    try {
      const eq = (ctx.svr as Mp).get(actorId, "equipment");
      const entries = eq && Array.isArray(eq.inv?.entries) ? eq.inv.entries : (Array.isArray(eq?.entries) ? eq.entries : []);
      return entries.some((e: any) => e && e.worn && this.recordType(ctx, Number(e.baseId) >>> 0) === "ARMO");
    } catch { return false; }
  }

  private locationOf(ctx: SystemContext, actorId: number): Location | null {
    try {
      const loc = (ctx.svr as Mp).get(actorId, "locationalData");
      if (!loc || !Array.isArray(loc.pos) || loc.pos.length !== 3) return null;
      return { cell: String(loc.cellOrWorldDesc), pos: loc.pos.map(Number) };
    } catch { return null; }
  }

  private isDisabled(ctx: SystemContext, refrId: number): boolean { try { return !!(ctx.svr as Mp).get(refrId, "isDisabled"); } catch { return true; } }
  private isDead(ctx: SystemContext, actorId: number): boolean { try { return !!(ctx.svr as Mp).get(actorId, "isDead"); } catch { return true; } }

  private inReach(ctx: SystemContext, loc: Location, refrId: number, reach = ACTIVATE_REACH): boolean {
    const mp = ctx.svr as Mp;
    try {
      if (loc.cell !== String(mp.get(refrId, "worldOrCellDesc"))) return false;
      const pos = mp.get(refrId, "pos"); if (!Array.isArray(pos)) return false;
      const d = Math.hypot(loc.pos[0] - pos[0], loc.pos[1] - pos[1], loc.pos[2] - pos[2]);
      return Number.isFinite(d) && d <= reach;
    } catch { return false; }
  }

  private combatCounts(ctx: SystemContext, actorId: number, targetId: number, keywords: Set<number>, reach: number): boolean {
    if (!targetId || targetId === actorId || !keywords.size) return false;
    const loc = this.locationOf(ctx, actorId);
    if (!loc || !this.inReach(ctx, loc, targetId, reach)) return false;
    return this.actorHasAny(ctx, targetId, keywords);
  }

  private hitReach(ctx: SystemContext, sourceId: number): number {
    const hit = this.reachCache.get(sourceId); if (hit !== undefined) return hit;
    const res = this.lookup(ctx, sourceId); const type = res ? String(res.record.type || "") : ""; let reach = 0;
    if (type === "SPEL") reach = RANGED_REACH;
    else if (type === "WEAP") { const cls = this.weaponClass(ctx, sourceId); reach = cls === "Bow" || cls === "Crossbow" ? RANGED_REACH : MELEE_REACH; }
    this.reachCache.set(sourceId, reach); return reach;
  }

  private holdsInputs(ctx: SystemContext, actorId: number, recipeId: number): boolean {
    const needed = this.recipeInputs(ctx, recipeId); if (!needed.length) return false;
    let held: Map<number, number>;
    try {
      const inv = (ctx.svr as Mp).get(actorId, "inventory"); held = new Map();
      for (const e of (inv && Array.isArray(inv.entries)) ? inv.entries : []) { const baseId = Number(e.baseId) >>> 0; held.set(baseId, (held.get(baseId) || 0) + (Number(e.count) || 0)); }
    } catch { return false; }
    return needed.every((n) => (held.get(n.baseId) || 0) >= n.count);
  }

  private benchInReach(ctx: SystemContext, actorId: number, bench: number, accept: (stationKeywords: Set<number>) => boolean): boolean {
    const loc = this.locationOf(ctx, actorId); if (!loc) return false;
    let near: unknown;
    try { near = (ctx.svr as Mp).getNeighborsByPosition(loc.cell, loc.pos); }
    catch (e) { if (!this.neighborsFailed) this.log(`[skills] getNeighborsByPosition failed, crafts cannot be credited: ${e}`); this.neighborsFailed = true; return false; }
    if (!Array.isArray(near)) return false;
    for (const id of near) {
      const refrId = Number(id) >>> 0; if (!refrId || !this.inReach(ctx, loc, refrId)) continue;
      const base = this.baseOf(ctx, refrId); if (!base || (base.type !== "FURN" && base.type !== "ACTI")) continue;
      const keywords = this.baseKeywords(ctx, base.id);
      if (keywords.has(bench) && accept(keywords)) return true;
    }
    return false;
  }

  private lookup(ctx: SystemContext, formId: number): any {
    if (!formId) return null;
    try { const res = (ctx.svr as Mp).lookupEspmRecordById(formId >>> 0); return res && res.record ? res : null; } catch { return null; }
  }
  private fieldFormIds(res: any, fieldType: string): number[] { return espmFieldFormIds(res, fieldType); }
  private recordType(ctx: SystemContext, formId: number): string { const info = this.baseInfo(ctx, formId); return info ? info.type : ""; }

  private recipeBench(ctx: SystemContext, recipeId: number): number {
    const hit = this.benchCache.get(recipeId); if (hit !== undefined) return hit;
    const bench = this.fieldFormIds(this.lookup(ctx, recipeId), "BNAM")[0] || 0;
    this.benchCache.set(recipeId, bench); return bench;
  }

  // Gold value of what a recipe makes, for skillPoints.weightOf's "craft" scale term.
  // Every offset below was measured over this load order by `py ck-mcp\itemvalues.py`, never assumed:
  // the winning layout is the one where the neighbouring float parses as a plausible weight for
  // essentially every record of that type, and a wrong offset fails that test loudly. Results are in
  // `server\item-value-layout.json`. 6687 of the 6695 COBJ recipes here resolve to one of these types.
  // A product with no known layout returns 0, which is weightOf's flat base - never a wrong number.
  private productValue(ctx: SystemContext, recipeId: number): number {
    const hit = this.valueCache.get(recipeId); if (hit !== undefined) return hit;
    let value = 0;
    const product = this.fieldFormIds(this.lookup(ctx, recipeId), "CNAM")[0] || 0;
    const res = product ? this.lookup(ctx, product) : null;
    const spot = res ? PRODUCT_VALUE_AT[String(res.record.type || "")] : undefined;
    if (spot) {
      const f = (res.record.fields || []).find((x: any) => x.type === spot.field && x.data instanceof Uint8Array && x.data.byteLength >= spot.offset + 4);
      if (f) {
        const v = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getInt32(spot.offset, true);
        if (v > 0 && v < 1000000) value = v;
      }
    }
    this.valueCache.set(recipeId, value); return value;
  }

  // Magicka cost of a spell, for weightOf's "cast" scale term: SPIT.spellCost, a uint32 at offset 0
  // of a 36-byte block (libespm's own SPITData, `static_assert(sizeof(SPITData) == 36)`).
  // Measured over this load order: it tracks spell power exactly - Flames 14, Healing 12, Firebolt 41,
  // Fireball 86, Incinerate 171, Icy Spear 320, Blizzard 1106. 748 of the 986 castable Spell-type
  // records carry one; the rest are auto-calculated and left at 0, and fall back to the flat base.
  private spellCost(ctx: SystemContext, spellId: number): number {
    const hit = this.costCache.get(spellId); if (hit !== undefined) return hit;
    let cost = 0;
    const res = this.lookup(ctx, spellId);
    if (res && (String(res.record.type || "") === "SPEL" || String(res.record.type || "") === "SCRL")) {
      const f = (res.record.fields || []).find((x: any) => x.type === "SPIT" && x.data instanceof Uint8Array && x.data.byteLength >= 36);
      if (f) {
        const v = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(0, true);
        if (v > 0 && v < 1000000) cost = v;
      }
    }
    this.costCache.set(spellId, cost); return cost;
  }

  private recipeInputs(ctx: SystemContext, recipeId: number): Array<{ baseId: number; count: number }> {
    const hit = this.inputCache.get(recipeId); if (hit) return hit;
    const out: Array<{ baseId: number; count: number }> = [];
    const res = this.lookup(ctx, recipeId);
    if (res && typeof res.toGlobalRecordId === "function") {
      for (const f of res.record.fields || []) {
        if (f.type !== "CNTO" || !(f.data instanceof Uint8Array) || f.data.byteLength < 8) continue;
        const view = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
        try { out.push({ baseId: res.toGlobalRecordId(view.getUint32(0, true)) >>> 0, count: view.getUint32(4, true) }); } catch { /* unmapped master */ }
      }
    }
    this.inputCache.set(recipeId, out); return out;
  }

  private baseOf(ctx: SystemContext, refrId: number): BaseInfo | null {
    const mp = ctx.svr as Mp; let baseId = 0;
    try { baseId = mp.getIdFromDesc(String(mp.get(refrId, "baseDesc"))) >>> 0; } catch { return null; }
    return baseId ? this.baseInfo(ctx, baseId) : null;
  }

  private baseInfo(ctx: SystemContext, formId: number): BaseInfo | null {
    const hit = this.baseCache.get(formId); if (hit !== undefined) return hit;
    const res = this.lookup(ctx, formId);
    const info = res ? { id: formId, type: String(res.record.type || ""), editorId: String(res.record.editorId || "") } : null;
    this.baseCache.set(formId, info); return info;
  }

  private actorHasAny(ctx: SystemContext, actorId: number, keywords: Set<number>): boolean {
    if (!keywords.size || !actorId) return false;
    const mp = ctx.svr as Mp; let profileId = -1;
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { /* not an actor */ }
    if (profileId >= 0) return keywords.has(this.playerKeyword);
    for (const baseId of this.baseChain(mp, actorId)) for (const k of this.baseKeywords(ctx, baseId)) if (keywords.has(k)) return true;
    return false;
  }

  private baseChain(mp: Mp, actorId: number): number[] {
    const chain: number[] = [];
    try { chain.push(mp.getIdFromDesc(String(mp.get(actorId, "baseDesc"))) >>> 0); } catch { /* no base */ }
    try { const tpl = mp.get(actorId, "templateChain"); if (Array.isArray(tpl)) for (const id of tpl) chain.push(Number(id) >>> 0); } catch { /* not an actor */ }
    return chain.filter((id, i) => id && chain.indexOf(id) === i);
  }

  private baseKeywords(ctx: SystemContext, baseId: number): Set<number> {
    const hit = this.keywordCache.get(baseId); if (hit) return hit;
    const out = new Set<number>(); const rec = this.lookup(ctx, baseId);
    if (rec) {
      for (const k of this.fieldFormIds(rec, "KWDA")) out.add(k);
      const raceId = String(rec.record.type) === "NPC_" ? this.fieldFormIds(rec, "RNAM")[0] : 0;
      if (raceId) for (const k of this.fieldFormIds(this.lookup(ctx, raceId), "KWDA")) out.add(k);
    }
    this.keywordCache.set(baseId, out); return out;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  // Renames onehanded/twohanded in a stored record to blade/blunt once skills.json has made the switch
  private migrateMelee(ctx: SystemContext, actorId: number, r: any): any {
    if (!r || !r.skills || typeof r.skills !== "object") return r;
    if (!this.def("blade") || !this.def("blunt") || this.def("onehanded") || this.def("twohanded")) return r;
    const old = OLD_MELEE.filter((id) => r.skills[id]);
    if (!old.length || r.skills.blade || r.skills.blunt) return r;
    const levelOf = (id: string) => Number(r.skills[id].level ?? r.skills[id].points) || 0;
    old.sort((a, b) => levelOf(b) - levelOf(a));
    const side = this.meleeSide(ctx, actorId);
    const other = side === "blade" ? "blunt" : "blade";
    const moved: string[] = [];
    old.forEach((id, i) => {
      const to = i === 0 ? side : other;
      const prog = Object.assign({}, r.skills[id]);
      for (const spellId of Array.isArray(prog.granted) ? prog.granted : []) this.removeSpell(ctx, actorId, Number(spellId) >>> 0);
      prog.granted = [];
      r.skills[to] = prog;
      delete r.skills[id];
      moved.push(`${id} ${Number(prog.level ?? prog.points) || 0} -> ${to}`);
    });
    r.order = stringList(r.order).map((id) => (id === old[0] ? side : id === old[1] ? other : id));
    this.log(`[skills] ${actorId.toString(16)} melee moved to Blade/Blunt (fought with ${side}): ${moved.join(", ")}`);
    return r;
  }

  // Which of Blade or Blunt a character fought with: melee-migration.json (from the server log), else the last outfit
  private meleeSide(ctx: SystemContext, actorId: number): "blade" | "blunt" {
    const mp = ctx.svr as Mp;
    if (this.meleeTable === null) {
      try { this.meleeTable = JSON.parse(fs.readFileSync(path.resolve(MELEE_TABLE), "utf8")).byTag || {}; }
      catch { this.meleeTable = {}; }
    }
    let tag = "";
    try { tag = String(mp.get(actorId, "private.charTag") || ""); } catch { /* none */ }
    const known = tag && this.meleeTable![tag];
    if (known === "blade" || known === "blunt") return known;
    let blade = 0, blunt = 0;
    let worn: unknown = null;
    try { worn = mp.get(actorId, "private.lastWorn"); } catch { /* none */ }
    for (const e of Array.isArray(worn) ? worn : []) {
      const cls = this.weaponClass(ctx, Number(Array.isArray(e) ? e[0] : e) >>> 0);
      if (BLADE_CLASSES.has(cls)) blade++; else if (BLUNT_CLASSES.has(cls)) blunt++;
    }
    return blunt > blade ? "blunt" : "blade";
  }

  private read(ctx: SystemContext, actorId: number): MasteryRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, MASTERY_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = this.migrateMelee(ctx, actorId, raw as any);
      const rec = emptyRecord();
      if (this.points && r.skills && typeof r.skills === "object") {
        const v2 = Number(r.v) === 2;
        rec.v = 2; rec.respecs = Math.max(0, Number(r.respecs) || 0);
        rec.day = typeof r.day === "string" ? r.day : undefined;
        rec.spentToday = Math.max(0, Number(r.spentToday) || 0);
        const wasChosen = new Set(stringList(r.order));
        for (const id of Object.keys(r.skills)) {
          if (!this.def(id)) continue;
          const src = r.skills[id] || {};
          // A v2 record stores the level under `level`; `points` beside it is only the derived shim the
          // gameplay layer reads. Records written by the mismatched build carry no `level` at all, so
          // fall back to `points` rather than resetting them to zero.
          const level = v2 ? Math.max(0, Math.min(P.MAX_LEVEL, Math.floor(Number(src.level ?? src.points) || 0)))
            : P.levelFromOldPoints(Number(src.points) || 0).level;
          const xp = v2 ? Math.max(0, Number(src.xp) || 0) : P.levelFromOldPoints(Number(src.points) || 0).xp;
          const lock: P.Lock = src.lock === "hold" || src.lock === "lower" ? src.lock : (v2 || wasChosen.has(id) ? "raise" : "hold");
          rec.skills[id] = {
            level, xp, lock, rank: Math.max(0, P.tierOfLevel(level)),
            lastPointAt: Math.max(0, Number(src.lastPointAt) || 0),
            granted: Array.isArray(src.granted) ? src.granted.map((v: unknown) => Number(v) >>> 0).filter((v: number) => v) : [],
            bucket: src.bucket && typeof src.bucket === "object" ? { tokens: Number(src.bucket.tokens) || 0, at: Number(src.bucket.at) || 0 } : undefined,
            ring: Array.isArray(src.ring) ? src.ring.filter((e: any) => e && Number.isFinite(e.h) && Number.isFinite(e.at)).map((e: any) => ({ h: Number(e.h), at: Number(e.at) })) : undefined,
            day: typeof src.day === "string" ? src.day : undefined,
            spentToday: Math.max(0, Number(src.spentToday) || 0),
            shadow: Math.max(0, Number(src.shadow) || 0) || undefined,
            offered: src.offered === true || undefined,
          };
        }
        rec.order = P.derivedOrder(rec as unknown as P.PointRecord);
        return rec;
      }
      if (r.skills && typeof r.skills === "object") {
        rec.order = stringList(r.order).filter((id) => this.def(id));
        for (const id of rec.order) {
          const p = r.skills[id] || {};
          rec.skills[id] = { level: Math.max(0, Math.floor(Number(p.points) || 0)), lastPointAt: Math.max(0, Number(p.lastPointAt) || 0), rank: Math.min(this.tierHours.length - 1, Math.max(0, Number(p.rank) || 0)), granted: Array.isArray(p.granted) ? p.granted.map((v: unknown) => Number(v) >>> 0).filter((v: number) => v) : [] };
        }
        rec.respecs = Math.max(0, Number(r.respecs) || 0);
        return rec;
      }
      // Legacy one-profession record from Alduinak's mastery: keep its hours under the same id when it exists.
      if (typeof r.profession === "string" && this.def(r.profession)) {
        rec.order = [r.profession];
        rec.skills[r.profession] = { level: Math.max(0, Math.floor(Number(r.points) || 0)), lastPointAt: Number(r.lastPointAt) || 0, rank: 0, granted: [] };
      }
      return rec;
    } catch { return null; }
  }

  private write(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    if (this.points) {
      for (const [, prog] of Object.entries(rec.skills)) prog.rank = Math.max(0, P.tierOfLevel(prog.level));
      rec.order = P.derivedOrder(rec as unknown as P.PointRecord);
      rec.v = 2;
    }
    // `points` is the name gamemode.js, labour.js and dungeons.js read. Derive it from `level` on every
    // save, exactly as `order` and `rank` are, so nothing outside this file has to change.
    for (const prog of Object.values(rec.skills)) (prog as unknown as Record<string, unknown>).points = prog.level;
    try { (ctx.svr as Mp).set(actorId, MASTERY_PROP, rec); } catch (e) { this.log(`[skills] write failed for ${actorId.toString(16)}: ${e}`); }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private isPlayer(ctx: SystemContext, actorId: number): boolean { try { return Number((ctx.svr as Mp).get(actorId, "profileId")) >= 0; } catch { return false; } }
  private actorOf(ctx: SystemContext, userId: number): number { if (userId < 0) return 0; try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; } }
  private userOf(ctx: SystemContext, actorId: number): number {
    try { const userId = (ctx.svr as Mp).getUserByActor(actorId); return userId === INVALID_USER_ID ? -1 : userId; } catch { return -1; }
  }
  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }
  private notice(ctx: SystemContext, userId: number, text: string): void { this.send(ctx, userId, { customPacketType: "masteryNotice", text }); }

  private points: P.PointConfig | null = null;      // set only when skills.json turns the point system on
  private candidates = new Map<string, string[]>();  // event kind -> the skills that could possibly match it
  private lastRefuseMs = new Map<number, number>();
  private skills: SkillDef[] = [];
  private categories: Array<{ id: string; label: string }> = [];
  private tierHours = DEFAULT_TIER_HOURS.slice();
  private tierNames = DEFAULT_TIER_NAMES.slice();
  private maxChosen = DEFAULT_MAX_CHOSEN;
  private respecGold = DEFAULT_RESPEC_GOLD;
  private firstRespecFree = true;
  private harvestChance = [0.6, 0.7, 0.8, 0.9, 1.0];
  private harvestMult = [1, 1.25, 1.5, 1.75, 2];
  private unskilledChance = 0.25;
  private unskilledMult = 0.5;
  private intervalMs = DEFAULT_POINT_INTERVAL_MINUTES * 60000;
  private spells: Record<string, number[]> = {};
  private rules: Record<string, ResolvedRules> = {};
  private playerKeyword = 0;
  private neighborsFailed = false;
  private events: ActivityEvent[] = [];
  // counted per window: events drained by kind, points credited by skill, and who was involved
  private creditStats = { events: new Map<string, number>(), credits: new Map<string, number>(), actors: new Set<number>(), suppressed: 0, since: 0 };
  private lastChooseMs = new Map<number, number>();
  private lastDenyMs = new Map<number, number>();
  private respecUntil = new Map<number, number>();
  private pendingGrants = new Map<number, number>();
  private benchCache = new Map<number, number>();
  private valueCache = new Map<number, number>();
  private costCache = new Map<number, number>();
  private reachCache = new Map<number, number>();
  private weaponCache = new Map<number, string>();
  private meleeTable: Record<string, string> | null = null;
  private schoolCache = new Map<number, string>();
  private inputCache = new Map<number, Array<{ baseId: number; count: number }>>();
  private baseCache = new Map<number, BaseInfo | null>();
  private keywordCache = new Map<number, Set<number>>();
}
