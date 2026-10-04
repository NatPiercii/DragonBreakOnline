import { ClientListener, CombinedController, Sp } from "./clientListener";
import { NiPoint3 } from "../../sync/movement";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { Actor } from "skyrimPlatform";
import { logTrace } from "../../logging";
import { isOwnCompanion, isAnyCompanion } from "../../sync/ownCompanions";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { WcPluginDeletes } from "./wcPluginDeletes";
import { isHandedToDelete, safeDelete } from "../../view/npcLifetimeRuntime";

export class WorldCleanerService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("gameLoad", () => this.onGameLoad());
  }

  modWcProtection(actorId: number, mod: number): void {
    const currentProtection = this.protection.get(actorId);
    this.protection.set(actorId, currentProtection ? currentProtection + mod : mod);
  }

  getWcProtection(actorId: number): number {
    return this.protection.get(actorId) || 0;
  }

  // Faster sweeps for a while, so an engine summon replaced by a server companion goes at once
  sweepBurst(durationMs: number): void {
    this.burstUntil = Math.max(this.burstUntil, Date.now() + durationMs);
  }

  private onGameLoad() {
    let player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }

    this.initialPos = ObjectReferenceEx.getPos(player);
    this.initialCellOrWorld = ObjectReferenceEx.getWorldOrCell(player);
  }

  private onUpdate() {
    this.notePluginDeletes(this.pluginDeletes.due(Date.now()));
    const count = Date.now() < this.burstUntil ? WorldCleanerService.burstActorsPerUpdate : 1;
    for (let i = 0; i < count; i++) {
      this.processOneActor();
    }
  }

  private processOneActor() {
    const pc = this.sp.Game.getPlayer();
    if (pc === null) {
      return;
    }
    try { this.notePluginDeletes(this.pluginDeletes.seeCell(ObjectReferenceEx.getWorldOrCell(pc), Date.now())); } catch (e) { /* diagnostics only */ }

    const actor = this.sp.Game.findRandomActor(
      pc.getPositionX(),
      pc.getPositionY(),
      pc.getPositionZ(),
      8192
    );
    if (actor === null) {
      return;
    }

    const actorId = actor.getFormID();

    if (actorId >= 0xff000000 && !this.firstSeen.has(actorId)) {
      this.firstSeen.set(actorId, Date.now());
      if (this.firstSeen.size > 512) {
        // Keep the map from growing across a long session
        const oldest = this.firstSeen.keys().next();
        if (!oldest.done) this.firstSeen.delete(oldest.value);
      }
    }

    const currentProtection = this.protection.get(actorId) || 0;
    if (currentProtection > 0) {
      return;
    }

    if (actorId === 0x14 || actor.isDisabled() || actor.isDeleted()) {
      return;
    }

    // Delete() is latent, so a copy the view deleted a moment ago still reads as not deleted: queue nothing on it
    if (isHandedToDelete(actorId)) {
      return;
    }

    // A companion is swept before its view protects it, and a deleted one can never move again
    if (isAnyCompanion(localIdToRemoteId(actorId))) {
      return;
    }

    if (this.isActorInDialogue(actor)) {
      if (actorId < 0xff000000 && !actor.isDead()) this.countPluginDelete(actor, actorId);
      // Deleting an actor in dialogue crashes Skyrim: https://github.com/skyrim-multiplayer/issue-tracker/issues/13
      actor.setPosition(0, 0, 0);
      actor.disableNoWait(true); // Seems to not crash
      return;
    }

    // Keep vanila pre-placed bodies, but delete player bodies
    if (actor.isDead() && actorId < 0xff000000) {
      actor.blockActivation(true);
      return;
    }

    const pos = ObjectReferenceEx.getPos(actor);
    const cellOrWorld = ObjectReferenceEx.getWorldOrCell(actor);

    const chickenRace = 0xa919d;

    // Anomaly chickens fail to Disable if we load the game near them. Refs: 106C22, 106C23
    if (actorId < 0xff000000 && actor.getRace()?.getFormID() === chickenRace) {
      if (this.initialPos && ObjectReferenceEx.getDistanceNoZ(pos, this.initialPos) < 4096) {
        if (cellOrWorld === this.initialCellOrWorld) {
          if (this.isActorInDialogue(actor)) {
            return;
          }
          logTrace(this, `Deleting chicken anomaly`, actorId.toString(16));
          actor.killSilent(null);
          actor.blockActivation(true);
          actor.disableNoWait(false);
          actor.setAlpha(0, false);
          return;
        }
      }
    }

    // A server spawn reaching this point is worth recording: protection is only registered when formView adopts the
    // actor (formView.ts modWcProtection), so a spawn swept before that is removed while the server still believes in
    // it. The same race is already noted above for companions. Under investigation as the Niryastare crash, where a
    // spawned actor's animation graph was stepped through a freed pointer (2026-09-29).
    if (actorId >= 0xff000000) {
      this.noteSpawnSwept(actor, actorId, currentProtection);
    } else {
      this.countPluginDelete(actor, actorId);
    }

    // Disabled now and deleted once its 3D is gone, never in the frame the engine may still animate it
    // (npcLifetime.ts; the Niryastare crash above stepped a swept actor's graph through a freed pointer)
    safeDelete(actor, { defer: true });
  }

  // Logging only. remoteId 0 means the view never adopted it, which is the case that matters.
  private noteSpawnSwept(actor: Actor, actorId: number, protection: number): void {
    const note = (globalThis as any).__dboDiagNote;
    if (typeof note !== "function") return;
    let base = 0;
    try { base = actor.getBaseObject()?.getFormID() || 0; } catch (e) { /* gone already */ }
    let remoteId = 0;
    try { remoteId = localIdToRemoteId(actorId) || 0; } catch (e) { /* not in the view */ }
    const firstSeen = this.firstSeen.get(actorId);
    const age = firstSeen ? `${Date.now() - firstSeen}ms since first seen` : "first sight";
    let loaded = "?";
    try { loaded = String(actor.is3DLoaded()); } catch (e) { /* gone already */ }
    note("wc:sweep", `${(actorId >>> 0).toString(16)} base=${base.toString(16)} adopted=${remoteId ? "yes" : "NO"} protection=${protection} 3d=${loaded} ${age}`);
  }

  private countPluginDelete(actor: Actor, actorId: number): void {
    try {
      this.pluginDeletes.add(actorId, actor.getBaseObject()?.getFormID() || 0, actor.isInCombat(), actor.is3DLoaded(), Date.now());
    } catch (e) { /* diagnostics only */ }
  }

  private notePluginDeletes(line: string | null): void {
    if (!line) return;
    const note = (globalThis as any).__dboDiagNote;
    if (typeof note === "function") note("wc:plugin", line);
  }

  private isActorInDialogue(ac: Actor) {
    return ac.isInDialogueWithPlayer() || ac.getDialogueTarget() !== null;
  }

  private protection = new Map<number, number>();
  // When this client first laid eyes on a server spawn, so a sweep can say how young the actor was
  private firstSeen = new Map<number, number>();
  private burstUntil = 0;
  private pluginDeletes = new WcPluginDeletes();
  private static readonly burstActorsPerUpdate = 8;
  private initialPos?: NiPoint3;
  private initialCellOrWorld?: number;
}
