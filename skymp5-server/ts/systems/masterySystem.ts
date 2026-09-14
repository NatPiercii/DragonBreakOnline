import * as fs from "fs";
import * as path from "path";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";

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
  points: number;
  lastPointAt: number;
  rank: number;
  granted: number[];
}

interface MasteryRecord {
  skills: Record<string, SkillProgress>;
  order: string[];
  respecs: number;
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

const ACTIVITY_KINDS = ["craft", "activate", "eat", "kill", "hit", "cast", "hurt", "prayer", "lock"] as const;
type ActivityKind = typeof ACTIVITY_KINDS[number];

interface ActivityEvent {
  kind: ActivityKind;
  actorId: number;
  detail: Record<string, number>;
}

interface BaseInfo { id: number; type: string; editorId: string; }
interface Location { cell: string; pos: number[]; }

const emptyRecord = (): MasteryRecord => ({ skills: {}, order: [], respecs: 0 });
const emptyProgress = (): SkillProgress => ({ points: 0, lastPointAt: 0, rank: 0, granted: [] });
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
    this.log(`[skills] ready: ${this.skills.length} skills, ${this.maxChosen} chosen, tiers at ${this.tierHours.join("/")}h, ${Object.keys(this.spells).length} skills have marker spells, respec ${this.respecGold} gold after the first`);

    ctx.gm.on("userAssignActor", (userId: number, actorId: number) => this.onActorAssigned(ctx, userId, actorId >>> 0));
    (globalThis as any).__alduinakMasteryEvent = (kind: string, actorId: number, detail: unknown) => this.enqueue(kind, actorId, detail);
    this.hookNativeEvents(ctx);
  }

  // ── Definitions ─────────────────────────────────────────────────────────────

  private loadSkillsFile(): void {
    let raw: any = null;
    for (const dir of [process.cwd(), path.dirname(process.argv[1] || ""), path.join(process.cwd(), "..")]) {
      try { raw = JSON.parse(fs.readFileSync(path.join(dir, SKILLS_FILE), "utf8")); this.log(`[skills] loaded ${path.join(dir, SKILLS_FILE)}`); break; } catch { /* next */ }
    }
    if (!raw) { this.log(`[skills] ${SKILLS_FILE} not found next to the server; no skills available`); return; }
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
      [actorId, { recipeId, held: this.holdsInputs(ctx, Number(actorId) >>> 0, Number(recipeId) >>> 0) ? 1 : 0 }]);
    chain("onActivate", "activate", ([refrId, casterId]) => [casterId, { refrId }], ([refrId, casterId]) => this.gateActivation(ctx, Number(refrId) >>> 0, Number(casterId) >>> 0));
    chain("onEatItem", "eat", ([actorId, baseId]) => [actorId, { baseId }]);
    // onHitDamage(aggressorId, targetId, sourceId, damage): credit the attacker (hit) and the defender (hurt).
    const prevHit = typeof mp.onHitDamage === "function" ? mp.onHitDamage : null;
    mp.onHitDamage = (...args: unknown[]) => {
      const verdict = prevHit ? prevHit(...args) : undefined;
      if (verdict !== false) {
        const [aggressorId, targetId, sourceId] = args;
        this.enqueue("hit", aggressorId, { targetId, sourceId });
        this.enqueue("hurt", targetId, { aggressorId, sourceId });
        try { if ((ctx.svr as Mp).get(Number(targetId) >>> 0, "isDead")) this.enqueue("kill", aggressorId, { victimId: targetId }); } catch { /* not an actor */ }
      }
      return verdict;
    };
    const prevCast = typeof mp.onSpellCast === "function" ? mp.onSpellCast : null;
    mp.onSpellCast = (...args: unknown[]) => {
      const verdict = prevCast ? prevCast(...args) : undefined;
      if (verdict !== false) { const [casterId, spellId] = args; this.enqueue("cast", casterId, { spellId }); }
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
      default: break;
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    this.flushPendingGrants(ctx);
    if (!this.events.length) return;
    const batch = this.events.splice(0, this.events.length);
    for (const ev of batch) {
      try { this.creditActivity(ctx, ev); } catch (e) { this.log(`[skills] ${ev.kind} credit failed for ${ev.actorId.toString(16)}: ${e}`); }
    }
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

  private creditActivity(ctx: SystemContext, ev: ActivityEvent): void {
    const rec = this.read(ctx, ev.actorId);
    if (!rec || !rec.order.length) return;
    const now = Date.now();
    let changed = false;
    for (const id of rec.order) {
      const prog = rec.skills[id]; const rules = this.rules[id];
      if (!prog || !rules) continue;
      const elapsed = now - prog.lastPointAt;
      if (elapsed >= 0 && elapsed < this.intervalMs) continue;
      if (!this.matches(ctx, id, rules, ev)) continue;
      prog.points += 1; prog.lastPointAt = now; changed = true;
      const userId = this.userOf(ctx, ev.actorId);
      this.notice(ctx, userId, `Your work as a ${this.labelOf(id)} is counted: ${prog.points} ${prog.points === 1 ? "hour" : "hours"}.`);
      this.syncRank(ctx, ev.actorId, rec, id, userId);
    }
    if (changed) this.write(ctx, ev.actorId, rec);
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
      case "activate": {
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
      default: return false;
    }
  }

  // ── Admin API (shape kept for AdminSystem) ──────────────────────────────────

  summaryOf(ctx: SystemContext, actorId: number): MasterySummary {
    const rec = this.read(ctx, actorId) || emptyRecord();
    const ranks = rec.order.map((id) => rec.skills[id] ? rec.skills[id].rank : 0);
    const hours = rec.order.reduce((s, id) => s + (rec.skills[id] ? rec.skills[id].points : 0), 0);
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
    prog.points = Math.max(0, prog.points + amount);
    this.write(ctx, actorId, rec);
    const userId = this.userOf(ctx, actorId);
    this.notice(ctx, userId, `Your hours as a ${this.labelOf(id)} now stand at ${prog.points}.`);
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

  // ── Login ───────────────────────────────────────────────────────────────────

  private onActorAssigned(ctx: SystemContext, userId: number, actorId: number): void {
    const rec = this.read(ctx, actorId);
    if (!rec || !rec.order.length) return;
    for (const id of rec.order) {
      const prog = rec.skills[id];
      const corrected = this.rankFor(prog.points);
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
      for (const id of rec.order) { this.applySpells(ctx, actorId, rec, id); this.applyActorValues(ctx, actorId, id, rec.skills[id].rank); }
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
    rec.skills[id].rank = this.rankFor(rec.skills[id].points);
    this.write(ctx, actorId, rec);
    this.applySpells(ctx, actorId, rec, id);
    this.applyActorValues(ctx, actorId, id, rec.skills[id].rank);
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
    this.applyActorValues(ctx, actorId, id, -1);
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

  private sendMenu(ctx: SystemContext, userId: number): void {
    const actorId = this.actorOf(ctx, userId); if (!actorId) return;
    const rec = this.read(ctx, actorId) || emptyRecord();
    const chosen = rec.order.map((id) => ({ id, rank: rec.skills[id]?.rank || 0, hours: rec.skills[id]?.points || 0 }));
    const first = chosen[0];
    this.send(ctx, userId, {
      customPacketType: "masteryMenu",
      maxChosen: this.maxChosen, tierNames: this.tierNames, tierHours: this.tierHours, categories: this.categories,
      skills: this.skills.map((k) => ({ id: k.id, category: k.category, label: k.label, title: k.title, description: k.description, tiers: k.tiers })),
      chosen,
      respec: { open: (this.respecUntil.get(actorId) || 0) > Date.now(), free: this.firstRespecFree && rec.respecs === 0, cost: this.respecGold, count: rec.respecs },
      // legacy fields for the old menu
      profession: first ? first.id : null, rank: first ? first.rank : 0, hours: first ? first.hours : 0, rankHours: this.tierHours,
      professions: this.skills.map((k) => ({ id: k.id, label: k.label, title: k.title })),
    });
  }

  // ── Ranks, marker spells, actor values ──────────────────────────────────────

  private rankFor(points: number): number {
    let rank = 0;
    for (let i = 0; i < this.tierHours.length; i++) if (points >= this.tierHours[i]) rank = i;
    return rank;
  }

  private syncRank(ctx: SystemContext, actorId: number, rec: MasteryRecord, id: string, userId: number): void {
    const prog = rec.skills[id]; if (!prog) return;
    const oldRank = prog.rank; const newRank = this.rankFor(prog.points);
    if (newRank < oldRank) this.revokeAbove(ctx, actorId, prog, id, newRank);
    prog.rank = newRank;
    this.applySpells(ctx, actorId, rec, id);
    if (newRank === oldRank) return;
    this.applyActorValues(ctx, actorId, id, newRank);
    this.notice(ctx, userId, newRank > oldRank ? `You are now ${this.tierNames[newRank]} in ${this.labelOf(id)}.` : `Your standing in ${this.labelOf(id)} has fallen to ${this.tierNames[newRank]}.`);
  }

  private missingSpells(prog: SkillProgress, id: string): number[] {
    const list = this.spells[id]; if (!list) return [];
    const out: number[] = [];
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
  private applyActorValues(ctx: SystemContext, actorId: number, id: string, rank: number): void {
    const d = this.def(id); if (!d || !d.vanillaSkills.length) return;
    const mp = ctx.svr as Mp;
    const value = rank < 0 ? 15 : AV_PER_TIER * (rank + 1);
    for (const sk of d.vanillaSkills) {
      const av = AV_NAMES[sk]; if (!av) continue;
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
  }

  // ── Lookups ─────────────────────────────────────────────────────────────────

  private weaponClass(ctx: SystemContext, sourceId: number): string {
    const hit = this.weaponCache.get(sourceId); if (hit !== undefined) return hit;
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

  private read(ctx: SystemContext, actorId: number): MasteryRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(actorId, MASTERY_PROP);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as any;
      const rec = emptyRecord();
      if (r.skills && typeof r.skills === "object") {
        rec.order = stringList(r.order).filter((id) => this.def(id));
        for (const id of rec.order) {
          const p = r.skills[id] || {};
          rec.skills[id] = { points: Math.max(0, Math.floor(Number(p.points) || 0)), lastPointAt: Math.max(0, Number(p.lastPointAt) || 0), rank: Math.min(this.tierHours.length - 1, Math.max(0, Number(p.rank) || 0)), granted: Array.isArray(p.granted) ? p.granted.map((v: unknown) => Number(v) >>> 0).filter((v: number) => v) : [] };
        }
        rec.respecs = Math.max(0, Number(r.respecs) || 0);
        return rec;
      }
      // Legacy one-profession record from Alduinak's mastery: keep its hours under the same id when it exists.
      if (typeof r.profession === "string" && this.def(r.profession)) {
        rec.order = [r.profession];
        rec.skills[r.profession] = { points: Math.max(0, Math.floor(Number(r.points) || 0)), lastPointAt: Number(r.lastPointAt) || 0, rank: 0, granted: [] };
      }
      return rec;
    } catch { return null; }
  }

  private write(ctx: SystemContext, actorId: number, rec: MasteryRecord): void {
    try { (ctx.svr as Mp).set(actorId, MASTERY_PROP, rec); } catch (e) { this.log(`[skills] write failed for ${actorId.toString(16)}: ${e}`); }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private actorOf(ctx: SystemContext, userId: number): number { if (userId < 0) return 0; try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; } }
  private userOf(ctx: SystemContext, actorId: number): number {
    try { const userId = (ctx.svr as Mp).getUserByActor(actorId); return userId === INVALID_USER_ID ? -1 : userId; } catch { return -1; }
  }
  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }
  private notice(ctx: SystemContext, userId: number, text: string): void { this.send(ctx, userId, { customPacketType: "masteryNotice", text }); }

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
  private lastChooseMs = new Map<number, number>();
  private lastDenyMs = new Map<number, number>();
  private respecUntil = new Map<number, number>();
  private pendingGrants = new Map<number, number>();
  private benchCache = new Map<number, number>();
  private reachCache = new Map<number, number>();
  private weaponCache = new Map<number, string>();
  private schoolCache = new Map<number, string>();
  private inputCache = new Map<number, Array<{ baseId: number; count: number }>>();
  private baseCache = new Map<number, BaseInfo | null>();
  private keywordCache = new Map<number, Set<number>>();
}
