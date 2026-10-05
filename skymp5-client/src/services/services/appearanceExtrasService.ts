import { Actor, ActorBase, Game, Ui } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { RemoteServer } from "./remoteServer";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { isGuardedActor, isGuardedRace } from "../../sync/beastRaces";
import {
  PACKET_GET, PACKET_INDEX, PACKET_REV, PACKET_SET, CopyInfo, Extras, Job, JobRunner, NativeCall, RemoteTracker,
  applyJob, captureJob, clearRef, isEmpty, readExtras, sameExtras,
} from "./appearanceExtrasPlan";

// RaceMenu extras, part 1 (see appearanceExtrasPlan.ts): the player's overlays, node scales and body morphs are read
// after RaceMenu closes and kept by the server (appearanceextras.js), put back on the player at every spawn (a SkyMP login
// loads a save with no SKSE co-save, so skee forgets them), and painted on other players' copies.
//
// Client -> Server: { customPacketType: "dboAppearanceExtras", f, ov, tr, mo }        the player's own, after RaceMenu
//                   { customPacketType: "dboAppearanceExtrasGet", self?, index?, ids? }
// Server -> Client: { customPacketType: "dboAppearanceExtras", actor, rev, self?, f, ov, tr, mo }
//                   { customPacketType: "dboAppearanceExtrasIndex", revs: [[actor, rev], ...] }
//                   { customPacketType: "dboAppearanceExtrasRev", actor, rev }
//
// Rules this keeps: nothing runs while RaceSexMenu is open or for 3 s after it closed (RaceMenu frees head parts then:
// memory racemenu-open-during-teleport-crashes); natives only in update; no Actor kept across frames, only form ids;
// a copy's ActorBase is never passed to skee (after applyTints it resolves to the player's own base), only the Actor
// ref; beast and non-humanoid races are skipped.

const RACE_MENU_SETTLE_MS = 3000;
const CAPTURE_AFTER_CLOSE_MS = 3000;
const SPAWN_APPLY_AFTER_MS = 5000;
const SCAN_MS = 500;
// Native calls per frame across every job
const CALL_BUDGET = 24;
const SELF_READ_MS = 250;
const DIAG_LINES = 40;
const PLAYER_ID = 0x14;

export class AppearanceExtrasService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => {
      if (!e.message.isMe) return;
      this.spawnAt = Date.now();
      this.selfApplied = false;
      this.askedSelf = false;
      this.gotSelf = false;
      this.capturing = false;
      this.runner.drop(PLAYER_ID);
    });
    this.controller.on("update", () => this.onUpdate());
    // formView.destroy runs this in update, before it deletes a copy: skee's data is keyed by form id, so a 0xff id the
    // game hands out again would inherit this copy's overlays and scales (the face-tint bleed's class of bug)
    (globalThis as any).__dboAppearanceExtrasForget = (localId: number) => {
      try { this.forget(Number(localId) >>> 0); } catch (e) { /* never break the delete */ }
    };
    // RaceMenu part 2 (face presets) wipes these extras whenever it loads a preset on an actor, then calls this
    (globalThis as any).__dboRaceMenuExtrasReapply = (localId: number) => {
      try {
        const id = Number(localId) >>> 0;
        if (id === PLAYER_ID) this.selfApplied = false;
        else this.tracker.reapply.add(id);
      } catch (e) { /* best effort */ }
    };
  }

  private call: NativeCall = (fn, ...args) => this.sp.callNative("NiOverride", fn, undefined, ...(args as any[]));

  private note(text: string): void {
    if (this.diagLines >= DIAG_LINES) return;
    this.diagLines++;
    try {
      const n = (globalThis as any).__dboDiagNote;
      if (typeof n === "function") n("rmx", text);
    } catch (e) { /* diagnostics never break the caller */ }
  }

  // skee64 and its NiOverride script present: one native with no arguments answers
  private available(): boolean {
    if (this.skee !== undefined) return this.skee;
    try {
      this.call("GetNumBodyOverlays");
      this.skee = true;
    } catch (e) {
      this.skee = false;
      this.note(`NiOverride unavailable: ${String(e).slice(0, 160)}`);
    }
    return this.skee;
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    const type = content["customPacketType"];
    if (type === PACKET_INDEX) {
      this.tracker.setIndex(content["revs"]);
    } else if (type === PACKET_REV) {
      this.tracker.setRev(Number(content["actor"]) >>> 0, Number(content["rev"]) >>> 0);
    } else if (type === PACKET_SET) {
      const extras = readExtras(content);
      const rev = Number(content["rev"]) >>> 0;
      if (content["self"]) {
        const changed = !sameExtras(this.selfExtras, extras);
        this.selfExtras = extras;
        // The server's answer to our own capture: only a clamped value differs from what the player already shows
        if (changed && !(this.lastSent && sameExtras(this.lastSent, extras))) this.selfApplied = false;
        this.gotSelf = true;
      } else {
        this.tracker.setData(Number(content["actor"]) >>> 0, rev, extras);
      }
    }
  }

  private raceMenuSettling(): boolean {
    let open = false;
    try { open = Ui.isMenuOpen("RaceSex Menu"); } catch (e) { open = true; }
    if (open) return true;
    const closedAt = Number((globalThis as any).__dboRaceMenuClosedAt) || 0;
    return Date.now() - closedAt < RACE_MENU_SETTLE_MS;
  }

  // The player's race, sex and 3D, read a few times a second (three natives) and kept as plain values
  private readSelf(now: number): boolean {
    if (now - this.selfReadAt < SELF_READ_MS) return true;
    this.selfReadAt = now;
    try {
      const player = Game.getPlayer();
      if (!player) return false;
      this.guardedSelf = isGuardedActor(player);
      const base = ActorBase.from(player.getBaseObject());
      this.femaleSelf = !!base && base.getSex() === 1;
      this.loadedSelf = player.is3DLoaded();
      return true;
    } catch (e) {
      return false;
    }
  }

  private onUpdate(): void {
    const now = Date.now();
    if (!this.spawnAt) return;
    if (this.raceMenuSettling()) return;
    if (!this.available()) return;
    if (!this.readSelf(now)) return;

    // Once a spawn has settled: our own extras and the index of everyone else's
    if (!this.askedSelf && now - this.spawnAt >= SPAWN_APPLY_AFTER_MS && this.loadedSelf) {
      this.askedSelf = true;
      sendCustomPacket(this.controller, { customPacketType: PACKET_GET, self: true, index: true });
    }

    this.maybeCapture(now);

    // Put the server's copy of our extras back on the player
    if (this.selfApplied && this.presetStamp(PLAYER_ID) > this.selfAppliedAt) this.selfApplied = false;
    if (!this.selfApplied && this.askedSelf && this.gotSelf && !this.guardedSelf && this.loadedSelf && !this.capturing && !this.runner.has(PLAYER_ID)) {
      this.selfApplied = true;
      this.selfAppliedAt = now;
      if (this.selfExtras && !isEmpty(this.selfExtras)) {
        this.runner.put(PLAYER_ID, applyJob(this.femaleSelf, this.selfExtras, { player: true }));
        this.note(`own extras applied: ${this.selfExtras.ov.length} overlay values, ${this.selfExtras.tr.length} scales, ${this.selfExtras.mo.length} morphs`);
      }
    }

    if (now - this.lastScan >= SCAN_MS) {
      this.lastScan = now;
      this.scan(now);
    }

    if (this.runner.size) {
      this.runner.run(this.call, (id) => this.resolveTarget(id), now, CALL_BUDGET, (job: Job, e: unknown) => {
        const key = job.label;
        if (this.errorsSeen.has(key)) return;
        this.errorsSeen.add(key);
        this.note(`${key} step failed: ${String(e).slice(0, 160)}`);
      });
    }
  }

  // The Actor for an id, this frame only
  private resolve(id: number): Actor | null {
    try {
      if (id === PLAYER_ID) return Game.getPlayer();
      return Actor.from(Game.getFormEx(id));
    } catch (e) {
      return null;
    }
  }

  // The same, refused when its race turned guarded (a beast form): a job stops at its next step
  private resolveTarget(id: number): Actor | null {
    const actor = this.resolve(id);
    if (!actor || isGuardedActor(actor)) {
      if (id === PLAYER_ID) this.guardedSelf = true;
      return null;
    }
    return actor;
  }

  // 3 s after RaceMenu closed, once our own kept extras are back on the player (a capture before that would replace
  // what the server holds with a body it never painted)
  private maybeCapture(now: number): void {
    const closedAt = Number((globalThis as any).__dboRaceMenuClosedAt) || 0;
    if (!closedAt || closedAt === this.capturedFor || now - closedAt < CAPTURE_AFTER_CLOSE_MS) return;
    if (!this.gotSelf || !this.selfApplied || !this.loadedSelf || this.capturing || this.runner.has(PLAYER_ID)) return;
    this.capturedFor = closedAt;
    if (this.guardedSelf) return;
    const female = this.femaleSelf;
    this.capturing = true;
    // An unfinished apply to the player would be read half done
    this.runner.drop(PLAYER_ID);
    this.runner.put(PLAYER_ID, captureJob(female, (x: Extras) => {
      this.capturing = false;
      this.selfApplied = true;
      this.selfAppliedAt = Date.now();
      if (this.lastSent && sameExtras(this.lastSent, x)) return;
      if (!this.lastSent && this.selfExtras && sameExtras(this.selfExtras, x)) return;
      this.lastSent = x;
      this.selfExtras = x;
      sendCustomPacket(this.controller, { customPacketType: PACKET_SET, f: x.f, ov: x.ov, tr: x.tr, mo: x.mo });
      this.note(`own extras sent: ${x.ov.length} overlay values, ${x.tr.length} scales, ${x.mo.length} morphs`);
    }));
  }

  private presetStamp(localId: number): number {
    try {
      const m = (globalThis as any).__dboRaceMenuPresetAppliedAt;
      return m ? Number(m[localId]) || 0 : 0;
    } catch (e) {
      return 0;
    }
  }

  // Every player copy this client holds
  private scan(now: number): void {
    const worldModel = this.controller.lookupListener(RemoteServer).getWorldModel();
    if (!worldModel || !Array.isArray(worldModel.forms)) return;
    const copies: CopyInfo[] = [];
    for (let i = 0; i < worldModel.forms.length; i++) {
      if (i === worldModel.playerCharacterFormIdx) continue;
      const form = worldModel.forms[i];
      if (!form || typeof form.refrId !== "number" || form.refrId < 0xff000000 || !form.appearance) continue;
      const local = remoteIdToLocalId(form.refrId) >>> 0;
      if (!local || local < 0xff000000) continue;
      let loaded = false;
      let guarded = true;
      try {
        const actor = Actor.from(Game.getFormEx(local));
        if (!actor) continue;
        loaded = actor.is3DLoaded();
        guarded = isGuardedRace(Number(form.appearance.raceId) >>> 0) || isGuardedActor(actor);
      } catch (e) { continue; }
      copies.push({
        remote: form.refrId >>> 0, local, loaded, guarded,
        female: !!form.appearance.isFemale, presetAt: this.presetStamp(local),
      });
    }
    // An id that may still carry a deleted copy's data, now held by any actor (an NPC copy too): clear it first
    if (this.tracker.dirty.size) {
      for (let i = 0; i < worldModel.forms.length; i++) {
        const form = worldModel.forms[i];
        if (!form || typeof form.refrId !== "number" || form.refrId < 0xff000000 || form.appearance) continue;
        const local = remoteIdToLocalId(form.refrId) >>> 0;
        if (!local || !this.tracker.dirty.has(local)) continue;
        const ref = this.resolve(local);
        if (!ref) continue;
        this.tracker.dirty.delete(local);
        clearRef(this.call, ref);
      }
    }
    const plan = this.tracker.plan(copies, now);
    for (const local of plan.clears) {
      this.runner.drop(local);
      const ref = this.resolve(local);
      if (ref) clearRef(this.call, ref);
      else this.tracker.dirty.add(local);
    }
    for (const a of plan.applies) {
      this.runner.put(a.local, applyJob(a.female, a.extras, { player: false, prev: a.prev }));
    }
    if (plan.requests.length) sendCustomPacket(this.controller, { customPacketType: PACKET_GET, ids: plan.requests });
  }

  private forget(localId: number): void {
    if (!localId || localId < 0xff000000) return;
    this.runner.drop(localId);
    if (!this.tracker.forget(localId)) return;
    if (!this.available()) return;
    const ref = this.resolve(localId);
    if (ref) clearRef(this.call, ref);
    else this.tracker.dirty.add(localId);
  }

  private runner = new JobRunner();
  private tracker = new RemoteTracker();
  private skee: boolean | undefined = undefined;
  private spawnAt = 0;
  private askedSelf = false;
  private gotSelf = false;
  private selfExtras: Extras | null = null;
  private selfApplied = false;
  private selfAppliedAt = 0;
  private lastSent: Extras | null = null;
  private capturedFor = 0;
  private capturing = false;
  private selfReadAt = 0;
  private guardedSelf = true;
  private femaleSelf = false;
  private loadedSelf = false;
  private lastScan = 0;
  private diagLines = 0;
  private errorsSeen = new Set<string>();
}
