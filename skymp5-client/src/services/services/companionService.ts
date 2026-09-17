import { Actor, HitEvent, ObjectReference, Quest, ReferenceAlias, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { WorldCleanerService } from "./worldCleanerService";
import { getViewFromStorage, isRemoteHostedByMe, localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { COMPANION_IDS_KEY, isOwnCompanion } from "../../sync/ownCompanions";
import { applyMovement } from "../../sync/movementApply";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";

export { isOwnCompanion };

// Owner side of the server companion library (companionSystem.ts, docs/docs_roleplay_companions.md).
// The owner hosts its companions, so this engine's AI drives them: teammate setup, following, and combat with the server's target.


const PLAYER_ID = 0x14;
const PLAYER_FACTION = 0xdb1;
const TWIN_SOULS_PERK = 0xd5f1c;
// Vanilla summoning flash (SummonTargetFXActivator), played where a companion appears and where it vanishes
const SUMMON_FX = 0x07cd55;
// Vanilla DialogueFollower: its Follower and Animal aliases carry the engine's follow-the-player packages, so a companion
// forced into one walks the navmesh, uses doors and fights like a hired follower. Papyrus events are blocked on the client,
// so the quest's scripts stay inert; one slot per companion, which covers the summon limit of two.
const DIALOGUE_FOLLOWER = 0x0750ba;
const FOLLOW_ALIASES = ["Follower", "Animal"];
// Owner-side list the party panel reads: [{ id (local), name, leftMs, at, staying }]
export const COMPANION_HUD_KEY = "dboCompanionHud";

interface CompanionEntry {
  id: number;
  target: number;
  staying: boolean;
  leftMs: number;
  at: number;
}

// Per local copy; a respawned copy gets a new local id and is set up again
interface LocalState {
  localId: number;
  following: boolean;
  followAngle: number;
  followResult: string;
  // Native follow through a DialogueFollower alias: slot name, when it was forced, and whether it failed the check
  aliasSlot: string;
  aliasAt: number;
  aliasFailed: boolean;
  reportAt: number;
  fightingTarget: number;
  // Stuck watch: last sampled position, when it stopped moving, and when it was last lifted out
  stuckPos?: number[];
  stuckSince: number;
  unstuckAt: number;
  // This copy ignores the engine's orders, so the client walks it itself
  driven: boolean;
}

export class CompanionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionAccepted", () => this.onConnectionAccepted());
    this.controller.on("hit", (e) => this.onHit(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onConnectionAccepted(): void {
    this.setCompanions([]);
    this.sentTwinSouls = false;
    this.lastPerkCheckMs = 0;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "companionState") {
      return;
    }
    const raw = Array.isArray(content["companions"]) ? content["companions"] as Record<string, unknown>[] : [];
    const list: CompanionEntry[] = raw
      .filter((x) => x && typeof x["id"] === "number")
      .map((x) => ({
        id: x["id"] as number, target: typeof x["target"] === "number" ? x["target"] as number : 0,
        staying: x["staying"] === true, leftMs: typeof x["leftMs"] === "number" ? x["leftMs"] as number : 0, at: Date.now(),
      }));
    // A new companion stands in for the engine's own summon, which the world cleaner removes
    if (list.some((c) => !this.companions.some((old) => old.id === c.id))) {
      // Delayed: a burst started now can sweep our own copy before its view is mapped and protected
      this.pendingBurstAt = Date.now() + CompanionService.burstDelayMs;
    }
    this.setCompanions(list);
  }

  private setCompanions(list: CompanionEntry[]): void {
    // A companion that left the list vanishes with the summoning flash where it stood
    for (const old of this.companions) {
      if (list.some((c) => c.id === old.id)) continue;
      const pos = this.lastPos.get(old.id);
      if (pos) this.pendingFx.push(pos);
      this.lastPos.delete(old.id);
    }
    this.companions = list;
    storage[COMPANION_IDS_KEY] = list.map((c) => c.id);
    Array.from(this.local.keys()).forEach((id) => {
      if (!list.some((c) => c.id === id)) {
        const gone = this.local.get(id);
        if (gone && gone.aliasSlot) this.pendingAliasClear.push(gone.aliasSlot);
        this.local.delete(id);
      }
    });
  }

  // The owner's hit with a weapon or a hostile spell is the attack order, as vanilla summons join the caster's fights
  private onHit(e: HitEvent): void {
    if (!this.companions.length || !e.aggressor || !e.target || e.aggressor.getFormID() !== PLAYER_ID) {
      return;
    }
    const target = this.sp.Actor.from(e.target);
    if (!target || target.getFormID() === PLAYER_ID || target.isDead() || !this.isHostileSource(e)) {
      return;
    }
    const targetId = localIdToRemoteId(target.getFormID());
    if (!targetId || isOwnCompanion(targetId)) {
      return;
    }
    const now = Date.now();
    if (targetId === this.lastOrderTarget && now - this.lastOrderMs < CompanionService.orderRepeatMs) {
      return;
    }
    this.lastOrderTarget = targetId;
    this.lastOrderMs = now;
    sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "attack", targetId });
  }

  private isHostileSource(e: HitEvent): boolean {
    if (this.sp.Weapon.from(e.source)) {
      return true;
    }
    const spell = this.sp.Spell.from(e.source);
    if (spell) {
      return spell.isHostile();
    }
    const scroll = this.sp.Scroll.from(e.source);
    if (!scroll) {
      return false;
    }
    for (let i = 0; i < scroll.getNumEffects(); i++) {
      if (scroll.getNthEffectMagicEffect(i)?.isEffectFlagSet(CompanionService.hostileEffectFlag)) {
        return true;
      }
    }
    return false;
  }

  private onUpdate(): void {
    const now = Date.now();
    if (this.pendingBurstAt && now >= this.pendingBurstAt) {
      this.pendingBurstAt = 0;
      this.controller.lookupListener(WorldCleanerService).sweepBurst(CompanionService.cleanerBurstMs);
    }
    this.reportPerks(now);
    if (!this.companions.length || now - this.lastApplyMs < CompanionService.applyIntervalMs) {
      return;
    }
    this.lastApplyMs = now;
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    this.playPendingFx(now);
    for (const slot of this.pendingAliasClear.splice(0)) {
      try { this.aliasByName(slot)?.clear(); } catch { /* quest gone */ }
    }
    this.recordTrail(player);
    this.assist(player, now);
    this.publishHud(now);
    for (const c of this.companions) {
      const actor = this.sp.Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(c.id)));
      if (!actor || actor.isDead() || !actor.is3DLoaded()) {
        continue;
      }
      // Set up as an ally at once: the summon's own AI runs before our host grant and would pick a fight with its caster
      const state = this.stateFor(c.id, actor);
      this.lastPos.set(c.id, [actor.getPositionX(), actor.getPositionY(), actor.getPositionZ()]);
      if (actor.getCombatTarget()?.getFormID() === PLAYER_ID) {
        actor.stopCombat();
      }
      if (!isRemoteHostedByMe(c.id)) {
        continue;
      }
      const target = c.target ? this.sp.Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(c.target))) : null;
      if (target && !target.isDead()) {
        this.fight(actor, target, state);
      } else if (c.staying) {
        this.stay(actor, state);
      } else if (state.driven) {
        // applyMovement throws on a cell mismatch; a throw here would break every companion this tick
        try { this.drive(actor, player, state); } catch (e) { state.followResult = "drive failed"; }
      } else {
        this.follow(actor, player, state);
      }
      // A throw here would break every companion this tick, so the driven path is contained
      try { if (!c.staying && !state.driven) this.unstick(actor, player, state, now); } catch (e) { state.followResult = "unstick failed"; }
      this.report(c.id, actor, player, state);
    }
  }

  // A companion born inside geometry cannot walk anywhere, whatever order it holds, so it is lifted to the owner
  private unstick(actor: Actor, player: Actor, state: LocalState, now: number): void {
    const here = [actor.getPositionX(), actor.getPositionY(), actor.getPositionZ()];
    const before = state.stuckPos;
    state.stuckPos = here;
    const distance = actor.getDistance(player);
    if (!before || distance <= CompanionService.stuckDistance) {
      state.stuckSince = 0;
      return;
    }
    if (Math.hypot(here[0] - before[0], here[1] - before[1], here[2] - before[2]) > CompanionService.stuckUnits) {
      state.stuckSince = 0;
      return;
    }
    state.stuckSince = state.stuckSince || now;
    if (now - state.stuckSince < CompanionService.stuckMs || now - state.unstuckAt < CompanionService.stuckMs) {
      return;
    }
    state.stuckSince = 0;
    // Teleported once already and still going nowhere: this copy will not take an order, so drive it
    if (state.unstuckAt) {
      state.driven = true;
      actor.clearKeepOffsetFromActor();
      state.following = false;
      state.followResult = "driving from " + Math.round(distance);
      return;
    }
    state.unstuckAt = now;
    actor.moveTo(player, 0, CompanionService.followOffsetY, 0, false);
    state.following = false;
    state.followResult = "unstuck at " + Math.round(distance);
  }

  // Walked positions of the owner, the newest last, so a driven companion follows ground the owner crossed
  private trail: number[][] = [];

  private recordTrail(player: Actor): void {
    const here = [player.getPositionX(), player.getPositionY(), player.getPositionZ()];
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(here[0] - last[0], here[1] - last[1], here[2] - last[2]) < CompanionService.trailStepUnits) {
      return;
    }
    this.trail.push(here);
    if (this.trail.length > CompanionService.trailPoints) this.trail.shift();
  }

  // Some copies ignore every order the engine takes, so the client walks them itself along the owner's trail
  private drive(actor: Actor, player: Actor, state: LocalState): void {
    const from = [actor.getPositionX(), actor.getPositionY(), actor.getPositionZ()];
    const distance = actor.getDistance(player);
    if (distance <= CompanionService.followRadius * 2) {
      state.followResult = "driven, at heel";
      return;
    }
    // Head for the owner, taking the height from the nearest ground the owner actually walked on,
    // so a step never sinks into a slope or hangs in the air
    const target = [player.getPositionX(), player.getPositionY(), player.getPositionZ()];
    let nearest = Infinity;
    for (const point of this.trail) {
      const d = Math.hypot(point[0] - from[0], point[1] - from[1]);
      if (d < nearest) {
        nearest = d;
        target[2] = point[2];
      }
    }
    const dx = target[0] - from[0];
    const dy = target[1] - from[1];
    const flat = Math.hypot(dx, dy) || 1;
    const facing = ((Math.atan2(dx, dy) * 180 / Math.PI) % 360 + 360) % 360;
    // Too far to run back: put it behind the owner, since a driven companion has no leash of its own
    if (distance > CompanionService.teleportDistance) {
      actor.setPosition(target[0] - dx / flat * CompanionService.followRadius,
        target[1] - dy / flat * CompanionService.followRadius, target[2]);
      state.followResult = "driven, caught up from " + Math.round(distance);
      return;
    }
    const running = distance > CompanionService.catchUpRadius;
    const speed = running ? CompanionService.driveRunSpeed : CompanionService.driveWalkSpeed;
    const step = Math.min(speed * CompanionService.applyIntervalMs / 1000, flat);
    // applyMovement throws RespawnNeededError when this does not match the actor's own cell
    applyMovement(actor, {
      worldOrCell: ObjectReferenceEx.getWorldOrCell(actor),
      pos: [from[0] + dx / flat * step, from[1] + dy / flat * step, target[2]],
      rot: [0, 0, facing],
      runMode: running ? "Running" : "Walking",
      direction: 0,
      isInJumpState: false,
      isSneaking: false,
      isBlocking: false,
      isWeapDrawn: actor.isWeaponDrawn(),
      isDead: false,
      healthPercentage: 1,
      speed,
    });
    state.following = false;
    state.followResult = `driven ${running ? "running" : "walking"} at ${Math.round(distance)}`;
  }

  private stateFor(remoteId: number, actor: Actor): LocalState {
    let state = this.local.get(remoteId);
    if (!state || state.localId !== actor.getFormID()) {
      state = { localId: actor.getFormID(), following: false, followAngle: 0, followResult: "none", aliasSlot: "", aliasAt: 0, aliasFailed: false, reportAt: 0, fightingTarget: 0, stuckSince: 0, unstuckAt: 0, driven: false };
      this.local.set(remoteId, state);
      this.prepare(actor);
      if (!this.announced.has(remoteId)) {
        this.announced.add(remoteId);
        this.summonFx(actor);
      }
    }
    return state;
  }

  // A teammate in the player faction instead of its own factions, so it is never hostile to the owner and only attacks enemies unprovoked
  private prepare(actor: Actor): void {
    actor.removeFromAllFactions();
    const faction = this.sp.Faction.from(this.sp.Game.getFormEx(PLAYER_FACTION));
    if (faction) {
      actor.setFactionRank(faction, 0);
    }
    actor.setPlayerTeammate(true, false);
    actor.ignoreFriendlyHits(true);
    actor.setActorValue("Aggression", 1);
    // A spawned copy can carry a zero speed, which leaves it inching along instead of walking
    if (actor.getActorValue("SpeedMult") < 50) actor.setActorValue("SpeedMult", 100);
    actor.setDontMove(false);
    actor.clearKeepOffsetFromActor();
    actor.stopCombat();
    actor.stopCombatAlarm();
  }

  private fight(actor: Actor, target: Actor, state: LocalState): void {
    state.fightingTarget = target.getFormID();
    if (actor.getCombatTarget()?.getFormID() !== state.fightingTarget) {
      actor.startCombat(target);
    }
  }

  private follow(actor: Actor, player: Actor, state: LocalState): void {
    // The order ended (target dead, gone or recalled): leave that fight, not one the engine picked itself
    if (state.fightingTarget) {
      if (actor.getCombatTarget()?.getFormID() === state.fightingTarget) {
        actor.stopCombat();
      }
      state.fightingTarget = 0;
    }
    // A fight the engine picked itself used to strand the companion: no follow order, no leash either
    if (actor.isInCombat()) {
      const distance = actor.getDistance(player);
      if (distance < CompanionService.combatLeashDistance) {
        if (state.following) {
          actor.clearKeepOffsetFromActor();
          state.following = false;
        }
        state.followResult = "fighting at " + Math.round(distance);
        return;
      }
      actor.stopCombat();
      state.fightingTarget = 0;
      state.followResult = "left a fight " + Math.round(distance) + " away";
    }
    if (!state.aliasFailed && this.nativeFollow(actor, state)) {
      return;
    }
    // Fallback when the alias is unavailable: a keep-offset behind the owner. Its angle is relative to
    // the owner's heading, so it is recomputed to face the owner, or the companion walks backwards when the owner turns.
    const distance = actor.getDistance(player);
    if (distance > CompanionService.teleportDistance) {
      actor.moveTo(player, 0, CompanionService.followOffsetY, 0, false);
      state.following = false;
      state.followResult = "moved to owner";
      return;
    }
    const dx = player.getPositionX() - actor.getPositionX();
    const dy = player.getPositionY() - actor.getPositionY();
    const facing = Math.atan2(dx, dy) * 180 / Math.PI;
    const angle = ((facing - player.getAngleZ()) % 360 + 540) % 360 - 180;
    const turn = Math.abs(((angle - state.followAngle) % 360 + 540) % 360 - 180);
    if (!state.following || (distance > CompanionService.followRadius && turn > CompanionService.followTurnDeg)) {
      actor.keepOffsetFromActor(player, 0, CompanionService.followOffsetY, 0, 0, 0, angle,
        CompanionService.catchUpRadius, CompanionService.followRadius);
      // An offset alone leaves the current package running, so the AI never acts on it
      actor.evaluatePackage();
      state.following = true;
      state.followAngle = angle;
      state.followResult = "offset " + Math.round(angle);
    }
  }

  // Puts the companion in a free DialogueFollower alias once, then checks after a few seconds that the engine took it:
  // the alias holds it and a package runs. Returns false when the fallback follow should run instead.
  private nativeFollow(actor: Actor, state: LocalState): boolean {
    const now = Date.now();
    if (state.aliasSlot) {
      const alias = this.aliasByName(state.aliasSlot);
      const held = alias?.getReference()?.getFormID() === actor.getFormID();
      if (now - state.aliasAt > CompanionService.aliasCheckMs && (!held || !actor.getCurrentPackage())) {
        state.aliasFailed = true;
        state.followResult = `alias failed (held ${held}, package ${actor.getCurrentPackage() ? "yes" : "none"})`;
        this.releaseAlias(state);
        return false;
      }
      return true;
    }
    const quest = this.followerQuest();
    if (!quest) {
      state.aliasFailed = true;
      state.followResult = "no DialogueFollower quest";
      return false;
    }
    const taken = new Set(Array.from(this.local.values()).map((x) => x.aliasSlot).filter(Boolean));
    const slot = FOLLOW_ALIASES.find((name) => !taken.has(name) && !this.aliasByName(name)?.getReference());
    if (!slot) return false;
    const alias = this.aliasByName(slot);
    if (!alias) return false;
    if (state.following) {
      actor.clearKeepOffsetFromActor();
      state.following = false;
    }
    alias.forceRefTo(actor);
    actor.evaluatePackage();
    state.aliasSlot = slot;
    state.aliasAt = now;
    state.followResult = "alias " + slot;
    return true;
  }

  private releaseAlias(state: LocalState): void {
    if (!state.aliasSlot) return;
    try {
      const alias = this.aliasByName(state.aliasSlot);
      if (alias && alias.getReference()?.getFormID() === state.localId) alias.clear();
    } catch { /* quest gone */ }
    state.aliasSlot = "";
  }

  private followerQuest(): Quest | null {
    const quest = Quest.from(this.sp.Game.getFormFromFile(DIALOGUE_FOLLOWER, "Skyrim.esm"));
    if (quest && !quest.isRunning() && !this.questStartAsked) {
      this.questStartAsked = true;
      quest.start().catch(() => { /* reported by the alias check */ });
    }
    return quest;
  }

  private aliasByName(name: string): ReferenceAlias | null {
    const quest = Quest.from(this.sp.Game.getFormFromFile(DIALOGUE_FOLLOWER, "Skyrim.esm"));
    return quest ? ReferenceAlias.from(quest.getAliasByName(name)) : null;
  }

  // Ordered to stay: holds its ground, still fights what attacks it or its owner
  private stay(actor: Actor, state: LocalState): void {
    this.releaseAlias(state);
    if (state.following) {
      actor.clearKeepOffsetFromActor();
      state.following = false;
      state.followResult = "staying";
    }
    if (state.fightingTarget && !actor.isInCombat()) state.fightingTarget = 0;
  }

  // Summons join fights the owner is already in: anything nearby in combat with the owner or one of the owner's companions
  // becomes the attack order, without waiting for the owner's first hit. The server still checks every target.
  private assist(player: Actor, now: number): void {
    if (now - this.lastAssistMs < CompanionService.assistMs) return;
    this.lastAssistMs = now;
    if (this.companions.every((c) => c.target)) return;
    const view = getViewFromStorage();
    if (!view) return;
    const guarded = new Set<number>([PLAYER_ID]);
    for (const c of this.companions) guarded.add(remoteIdToLocalId(c.id));
    const views = view.getFormViews();
    let best = 0;
    let bestDistance = CompanionService.assistRadius;
    for (let i = 0; i < views.getFormViewsArrayLength(); i++) {
      const fv = views.getNthFormView(i);
      if (!fv) continue;
      const remoteId = fv.getRemoteRefrId();
      if (!remoteId || isOwnCompanion(remoteId)) continue;
      const enemy = Actor.from(this.sp.Game.getFormEx(fv.getLocalRefrId()));
      if (!enemy || enemy.isDead() || !enemy.is3DLoaded()) continue;
      const theirTarget = enemy.getCombatTarget();
      if (!theirTarget || !guarded.has(theirTarget.getFormID())) continue;
      const distance = enemy.getDistance(player);
      if (distance < bestDistance) { best = remoteId; bestDistance = distance; }
    }
    if (!best || (best === this.lastOrderTarget && now - this.lastOrderMs < CompanionService.orderRepeatMs)) return;
    this.lastOrderTarget = best;
    this.lastOrderMs = now;
    sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "attack", targetId: best });
  }

  // The party panel shows each companion with its health and the time it has left
  private publishHud(now: number): void {
    const rows: Array<{ id: number; name: string; leftMs: number; staying: boolean }> = [];
    for (const c of this.companions) {
      const localId = remoteIdToLocalId(c.id);
      const actor = localId ? Actor.from(this.sp.Game.getFormEx(localId)) : null;
      const name = actor ? (actor.getDisplayName() || actor.getBaseObject()?.getName() || "Companion") : "Companion";
      rows.push({ id: localId, name, leftMs: c.leftMs ? Math.max(0, c.leftMs - (now - c.at)) : 0, staying: c.staying });
    }
    storage[COMPANION_HUD_KEY] = rows;
  }

  private summonFx(ref: ObjectReference, at?: number[]): void {
    try {
      const fx = this.sp.Game.getFormFromFile(SUMMON_FX, "Skyrim.esm");
      const placed = fx ? ref.placeAtMe(fx, 1, false, false) : null;
      if (!placed) return;
      if (at) placed.setPosition(at[0], at[1], at[2]);
      this.fxRefs.push([placed.getFormID(), Date.now() + CompanionService.fxLifeMs]);
    } catch { /* effect not loaded, no flash */ }
  }

  // Vanish flashes queued from the packet handler, plus clean-up of finished flashes
  private playPendingFx(now: number): void {
    const player = this.sp.Game.getPlayer();
    for (const pos of this.pendingFx.splice(0)) {
      if (player) this.summonFx(player, pos);
    }
    this.fxRefs = this.fxRefs.filter(([id, until]) => {
      if (until > now) return true;
      try { ObjectReference.from(this.sp.Game.getFormEx(id))?.delete(); } catch { /* already gone */ }
      return false;
    });
  }

  // Diagnostic: every few seconds the owner reports each companion's state to the server log (dbo npcDrift, kind companion)
  private report(remoteId: number, actor: Actor, player: Actor, state: LocalState): void {
    const now = Date.now();
    if (now - state.reportAt < CompanionService.reportMs) {
      return;
    }
    state.reportAt = now;
    const base = actor.getBaseObject();
    // Whether it actually moved since the last report, so an order that changes nothing is visible
    const here = [actor.getPositionX(), actor.getPositionY(), actor.getPositionZ()];
    const then = this.reportPos.get(remoteId);
    const moved = then ? Math.round(Math.hypot(here[0] - then[0], here[1] - then[1], here[2] - then[2])) : -1;
    this.reportPos.set(remoteId, here);
    sendCustomPacket(this.controller, {
      customPacketType: "dbo", event: "npcDrift", args: [{
        kind: "companion", remoteId: remoteId.toString(16), base: `${base?.getName() || "?"} ${(base?.getFormID() ?? 0).toString(16)}`,
        hosted: isRemoteHostedByMe(remoteId), distance: Math.round(actor.getDistance(player)), inCombat: actor.isInCombat(),
        combatTarget: (actor.getCombatTarget()?.getFormID() ?? 0).toString(16), aiDisabled: actor.isAIEnabled() === false,
        following: state.following, follow: state.followResult, weaponDrawn: actor.isWeaponDrawn(), moved,
        deleted: actor.isDeleted(), disabled: actor.isDisabled(), loaded: actor.is3DLoaded(), var10: Math.round(actor.getActorValue("Variable10")), speedMult: Math.round(actor.getActorValue("SpeedMult")), driven: state.driven,
        localId: actor.getFormID().toString(16), at: here.map(Math.round), owner: [player.getPositionX(), player.getPositionY(), player.getPositionZ()].map(Math.round),
        package: (actor.getCurrentPackage()?.getFormID() ?? 0).toString(16), aliasSlot: state.aliasSlot,
      }],
    });
  }

  // Twin Souls raises the summon limit to two; the server only keeps the flag for a character in game, so it is repeated while true
  private reportPerks(now: number): void {
    if (now - this.lastPerkCheckMs < CompanionService.perkCheckMs) {
      return;
    }
    this.lastPerkCheckMs = now;
    const player = this.sp.Game.getPlayer();
    const perk = this.sp.Perk.from(this.sp.Game.getFormEx(TWIN_SOULS_PERK));
    const twinSouls = !!player && !!perk && player.hasPerk(perk);
    if (!twinSouls && !this.sentTwinSouls) {
      return;
    }
    this.sentTwinSouls = twinSouls;
    sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "perks", twinSouls });
  }

  private companions: CompanionEntry[] = [];
  private local = new Map<number, LocalState>();
  private announced = new Set<number>();
  private pendingFx: number[][] = [];
  private lastPos = new Map<number, number[]>();
  private fxRefs: Array<[number, number]> = [];
  private lastAssistMs = 0;
  private questStartAsked = false;
  private pendingAliasClear: string[] = [];
  private lastApplyMs = 0;
  private lastOrderTarget = 0;
  private lastOrderMs = 0;
  private lastPerkCheckMs = 0;
  private sentTwinSouls = false;
  // When the delayed cleaner burst is due, 0 when none is pending
  private pendingBurstAt = 0;
  // Position at the last report, to tell a companion that will not move from one that is keeping up
  private reportPos = new Map<number, number[]>();

  private static readonly applyIntervalMs = 250;
  private static readonly orderRepeatMs = 2000;
  private static readonly cleanerBurstMs = 3000;
  // The engine summon our copy replaces is swept after this, once our own copy is safely mapped
  private static readonly burstDelayMs = 3000;
  private static readonly perkCheckMs = 10000;
  private static readonly followOffsetY = -128;
  private static readonly catchUpRadius = 512;
  private static readonly followRadius = 128;
  private static readonly followTurnDeg = 25;
  private static readonly teleportDistance = 2048;
  // Past this the companion breaks off its own fight and comes back, so it cannot be left behind
  private static readonly combatLeashDistance = 1500;
  // Moving less than this far while this far from the owner, for this long, counts as stuck
  private static readonly stuckUnits = 8;
  private static readonly stuckDistance = 400;
  private static readonly stuckMs = 3000;
  // Client-driven follow: trail spacing and length, and the speeds it walks and runs at
  private static readonly trailStepUnits = 96;
  private static readonly trailPoints = 48;
  private static readonly driveWalkSpeed = 260;
  private static readonly driveRunSpeed = 900;
  private static readonly assistMs = 1000;
  private static readonly assistRadius = 2048;
  private static readonly fxLifeMs = 4000;
  private static readonly aliasCheckMs = 3000;
  private static readonly reportMs = 5000;
  private static readonly hostileEffectFlag = 0x1;
}
