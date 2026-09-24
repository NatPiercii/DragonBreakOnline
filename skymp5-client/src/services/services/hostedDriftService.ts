import { Actor, Game, Keyword, NetImmerse, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { RemoteServer } from "./remoteServer";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { FormModel } from "../../view/model";
import { setRefrCollision } from "../../sync/animation";
import { applyDriftConfig, driftConfig, driftConfigEcho } from "../../sync/driftConfig";
import { getApplyState } from "../../sync/movementApply";
import { getMovement } from "../../sync/movementGet";
import { SpawnProcess } from "../../view/spawnProcess";

const POLL_MS = 500;
const HEARTBEAT_MS = 30000;
const REPAIR_COOLDOWN_MS = 10000;
const REPAIR_CHECK_MS = 1000;
// A repair that joined is looked at again this long after it ran, to catch a body that keeps sinking
const REPAIR_LATE_MS = 5000;
// A body that moves this far in one poll without our repair is a visible jump
const JUMP_UNITS = 384;
// Bone height reversals of at least this much, with the reference holding still, are a hop
const HOP_UNITS = 40;
const HOP_SAMPLES = 8;
// A hosted body that goes A to B and back to A within this window, each leg at least this long, bounced
const BOUNCE_MS = 2000;
const BOUNCE_UNITS = 128;
// A sink is only reported when the body sits straight under the reference
const SINK_MAX_DXY = 64;
// The first hosted move this long by a creature base is reported once with its locomotion variables
const LOCOMOTION_UNITS = 100;
const REPORT_EVERY_MS = 30000;
// Node limit of the root nodes; COM (450) sits above the feet and gives no body height
const ROOT_LIMIT = 250;
const FAR_UNITS = 4096;
const HEARTBEAT_IDS = 40;
const ANIM_RING = 8;
// Copies another client hosts: report thresholds
const REMOTE_ERR = 160;
const REMOTE_ERR_Z = 48;
const REMOTE_BODY_DZ = 96;
const REMOTE_SNAP = 256;
const REMOTE_EVENT = 512;
const REMOTE_BOUNCE_LEG = 64;
const REMOTE_BOUNCES = 3;
const REMOTE_GAP_MS = 1500;
const REMOTE_OVERSHOOT_MS = 2000;
const REMOTE_CAP = 20;
// A translateTo target older than this no longer describes where the copy is headed
const TARGET_FRESH_MS = 1000;
// gamemode.js logs the first 900 characters of a report
const REPORT_MAX_CHARS = 880;
const REPAIR_MODES = ["setPosition", "none", "moveTo", "disableEnable"] as const;
type RepairMode = typeof REPAIR_MODES[number];
type Vec = number[];
const NODES: Array<[string, number]> = [
  ["NPC Root [Root]", 250],
  ["NPC COM [COM ]", 450],
  ["BoneRoot", 250],
  ["Root", 250],
  ["Bip01", 250],
];

interface Pending { due: number; mode: RepairMode; node: string; limit: number; ref: Vec; bone: Vec; late: boolean }
interface HostTrack { ref: Vec; bone: Vec; refZ: number[]; boneZ: number[]; hist: Array<[Vec, number, Vec]>; reportedAt: number }
interface RemoteTrack {
  form: FormModel; ref: Vec; srv: Vec; leg: Vec; at: number; runMode: string;
  since: number; tripped: string; reportedAt: number;
  errMax: number; errZMax: number; bodyDzMax: number; snaps: number; bounces: number; gapMax: number;
  standDrift: number; overshoot: number; stopAt: Vec | null; stopDir: Vec | null; stopUntil: number;
}

/**
 * Floating spawned creatures (2026-09-16): the host reports an NPC at ground height while its model hangs
 * in the air and its attacks never land. This compares every NPC we host with its skeleton root; when the
 * two split it tells the gamemode (logged to server.log) and re-seats the reference so havok takes the body
 * back. It also samples the nearest copies another client hosts, and a heartbeat every 30 s shows it runs.
 *
 *   Client -> Server: { customPacketType: "dbo", event: "npcDrift", args: [report] }
 */
export class HostedDriftService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => this.noteAnim(ctx.selfId, ctx.animEventName, ctx.animationSucceeded),
    }, 0xff000000, 0xffffffff);
  }

  // The gamemode picks the repair and the switches, so each can be measured without a client build
  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "npcDriftConfig") return;
    const mode = REPAIR_MODES.find((m) => m === content["repair"]);
    if (mode) this.repairMode = mode;
    const spawn = content["spawn"];
    if (spawn === "moveTo" || spawn === "setPosition") SpawnProcess.placeMode = spawn;
    applyDriftConfig(content);
    this.send({ kind: "config", repair: this.repairMode, spawn: SpawnProcess.placeMode, ...driftConfigEcho() });
  }

  private onUpdate(): void {
    const now = Date.now();
    this.trackPacketGaps();
    if (now < this.nextPoll) return;
    this.nextPoll = now + POLL_MS;
    this.pollHosted(now);
    this.pollRemote(now);
  }

  private pollHosted(now: number): void {
    const hosted = storage["hosted"];
    const ids = Array.isArray(hosted) ? (hosted as number[]) : [];
    const live = new Set(ids.map((raw) => Number(raw) % 0x100000000));
    this.hostedSince.forEach((_, id) => { if (!live.has(id)) this.hostedSince.delete(id); });
    this.loadedSince.forEach((_, id) => { if (!live.has(id)) this.loadedSince.delete(id); });
    this.tracks.forEach((_, id) => { if (!live.has(id)) this.tracks.delete(id); });
    this.checkRepairs(now);
    const pc = Game.getPlayer();
    const pcPos = pc ? [pc.getPositionX(), pc.getPositionY(), pc.getPositionZ()] : null;
    const hostedLocal = new Set<number>();
    const pairs: Array<[number, number]> = [];
    let checked = 0;
    let split = 0;
    let resolved = 0;
    let loaded = 0;
    let far = 0;
    for (const raw of ids) {
      const remoteId = Number(raw) % 0x100000000;
      if (!this.hostedSince.has(remoteId)) this.hostedSince.set(remoteId, now);
      try {
        const localId = remoteIdToLocalId(remoteId);
        const ac = localId ? Actor.from(Game.getFormEx(localId)) : null;
        if (!ac || !ac.is3DLoaded()) this.loadedSince.delete(remoteId);
        else if (!this.loadedSince.has(remoteId)) this.loadedSince.set(remoteId, now);
        if (!ac || ac.getFormID() === 0x14) {
          pairs.push([remoteId, -1]);
          continue;
        }
        resolved++;
        hostedLocal.add(ac.getFormID());
        const fromPc = pcPos ? this.dist([ac.getPositionX(), ac.getPositionY(), ac.getPositionZ()], pcPos) : -1;
        pairs.push([remoteId, fromPc]);
        if (fromPc > FAR_UNITS) far++;
        if (ac.is3DLoaded()) loaded++;
        if (ac.isDead() || !ac.is3DLoaded()) continue;
        const node = NODES.find(([name]) => NetImmerse.hasNode(ac, name, false));
        if (!node) {
          this.reportOnce(`noroot:${ac.getBaseObject()?.getFormID()}`, { kind: "noRootNode", remoteId: remoteId.toString(16), base: this.baseName(ac) });
          continue;
        }
        checked++;
        const [nodeName, limit] = node;
        const [ref, bone] = this.sample(ac, nodeName);
        this.watchMotion(ac, remoteId, ref, bone, now);
        const dxy = Math.hypot(bone[0] - ref[0], bone[1] - ref[1]);
        const dz = bone[2] - ref[2];
        if (dxy <= limit && Math.abs(dz) <= limit) {
          this.splitSince.delete(remoteId);
          // COM sits above the feet, so only root nodes (limit 250) give a sink depth comparable across bases
          if (limit <= ROOT_LIMIT && dxy < SINK_MAX_DXY && dz < -driftConfig.sinkReport) this.reportSink(ac, remoteId, nodeName, ref, bone, now);
          continue;
        }
        split++;
        const since = this.splitSince.get(remoteId) ?? now;
        this.splitSince.set(remoteId, since);
        const lastRepair = this.repairedAt.get(remoteId) ?? 0;
        const repair = now - lastRepair >= REPAIR_COOLDOWN_MS;
        const attempts = (this.attempts.get(remoteId) ?? 0) + (repair ? 1 : 0);
        if (!repair) continue;
        this.repairedAt.set(remoteId, now);
        this.attempts.set(remoteId, attempts);
        this.send({
          kind: "split", remoteId: remoteId.toString(16), base: this.baseName(ac), node: nodeName,
          ref: ref.map(Math.round), bone: bone.map(Math.round), dxy: Math.round(dxy), dz: Math.round(dz),
          splitForMs: now - since, attempt: attempts, inCombat: ac.isInCombat(), weaponDrawn: ac.isWeaponDrawn(),
          hostedForMs: now - (this.hostedSince.get(remoteId) ?? now), loadedForMs: now - (this.loadedSince.get(remoteId) ?? now),
          fromPlayer: Math.round(this.fromPlayer(ref)), repair: this.repairMode, ...this.context(ac, now),
        });
        this.repair(ac, remoteId, nodeName, limit, ref, bone, now);
      } catch (e) {
        this.reportOnce(`err:${remoteId}`, { kind: "error", remoteId: remoteId.toString(16), error: String(e) });
      }
    }
    this.hostedLocal = hostedLocal;
    this.anims.forEach((_, id) => { if (!hostedLocal.has(id)) this.anims.delete(id); });

    if (now >= this.nextHeartbeat) {
      this.nextHeartbeat = now + HEARTBEAT_MS;
      const report: Record<string, unknown> = {
        kind: "heartbeat", hosted: ids.length, checked, split, live: resolved, loaded, far,
        remote: { on: driftConfig.remote, tracked: this.remote.size, sent: this.remoteSent, capped: this.remoteCapped },
      };
      this.remoteSent = 0;
      this.remoteCapped = 0;
      report.ids = this.fitIds(report, pairs);
      this.send(report);
    }
  }

  // "id:distance" pairs, nearest first, as many as fit the logged length; -1 is an id that no longer resolves
  private fitIds(report: Record<string, unknown>, pairs: Array<[number, number]>): string {
    const budget = REPORT_MAX_CHARS - JSON.stringify(report).length - 12;
    const sorted = pairs.slice().sort((x, y) => (x[1] < 0 ? Infinity : x[1]) - (y[1] < 0 ? Infinity : y[1]));
    let out = "";
    for (const [id, d] of sorted.slice(0, HEARTBEAT_IDS)) {
      const item = `${id.toString(16)}:${Math.round(d)}`;
      if (out.length + item.length + 1 > budget) break;
      out = out ? `${out},${item}` : item;
    }
    return out;
  }

  // Body straight under its reference by less than the repair limit: reported, never repaired
  private reportSink(ac: Actor, remoteId: number, node: string, ref: Vec, bone: Vec, now: number): void {
    if (now - (this.sinkAt.get(remoteId) ?? 0) < REPORT_EVERY_MS) return;
    this.sinkAt.set(remoteId, now);
    this.send({
      kind: "sink", remoteId: remoteId.toString(16), base: this.baseName(ac), node,
      ref: ref.map(Math.round), bone: bone.map(Math.round), dz: Math.round(bone[2] - ref[2]), inCombat: ac.isInCombat(),
      hostedForMs: now - (this.hostedSince.get(remoteId) ?? now), loadedForMs: now - (this.loadedSince.get(remoteId) ?? now),
      fromPlayer: Math.round(this.fromPlayer(ref)), ...this.context(ac, now),
    });
  }

  private context(ac: Actor, now: number): Record<string, unknown> {
    const ring = this.anims.get(ac.getFormID()) ?? [];
    return {
      speed: Math.round(ac.getAnimationVariableFloat("SpeedSampled")), v10: Math.round(ac.getActorValue("Variable10")),
      sit: ac.getSitState(), bleed: ac.isBleedingOut(),
      // Per-echo settles in the last 2 s that stopped a running translation or cleared a keep-offset
      settles2s: getApplyState(ac.getFormID()).settles2s,
      anims: ring.map(([name, at]) => `${name}@${now - at}`),
    };
  }

  private noteAnim(localId: number, name: string, succeeded: boolean): void {
    if (!this.hostedLocal.has(localId)) return;
    let ring = this.anims.get(localId);
    if (!ring) this.anims.set(localId, ring = []);
    ring.push([succeeded ? name : `${name}!`, Date.now()]);
    if (ring.length > ANIM_RING) ring.shift();
  }

  private repair(ac: Actor, remoteId: number, node: string, limit: number, ref: Vec, bone: Vec, now: number): void {
    const mode = this.repairMode;
    if (mode !== "none") {
      ac.stopTranslation();
      setRefrCollision(ac.getFormID(), true);
    }
    if (mode === "setPosition") ac.setPosition(ref[0], ref[1], ref[2]);
    else if (mode === "moveTo") ac.moveTo(ac, 0, 0, 0, true);
    else if (mode === "disableEnable") ac.disable(false).then(() => ac.enable(false));
    this.pending.set(remoteId, { due: now + REPAIR_CHECK_MS, mode, node, limit, ref, bone, late: false });
  }

  // Whether the repair joined body and reference, swapped them or left them apart; a join is checked again later
  private checkRepairs(now: number): void {
    this.pending.forEach((p, remoteId) => {
      if (now < p.due) return;
      this.pending.delete(remoteId);
      const kind = p.late ? "repairLate" : "repairResult";
      try {
        const localId = remoteIdToLocalId(remoteId);
        const ac = localId ? Actor.from(Game.getFormEx(localId)) : null;
        if (!ac || !ac.is3DLoaded()) return this.send({ kind, remoteId: remoteId.toString(16), mode: p.mode, result: "unloaded" });
        const [ref, bone] = this.sample(ac, p.node);
        const apart = Math.hypot(bone[0] - ref[0], bone[1] - ref[1], bone[2] - ref[2]);
        let result: string;
        const extra: Record<string, unknown> = {};
        if (p.late) {
          // Sinking is the body under its own reference again; the reference's own drop (walking downhill) is only a number
          const dz = bone[2] - ref[2];
          const dxy = Math.hypot(bone[0] - ref[0], bone[1] - ref[1]);
          result = apart > p.limit ? "apart" : p.limit <= ROOT_LIMIT && dz < -driftConfig.sinkReport && dxy < SINK_MAX_DXY ? "sinking" : "joined";
          extra.dz = Math.round(dz);
          extra.refDrop = Math.round(p.ref[2] - ref[2]);
        } else {
          const swapped = this.dist(ref, p.bone) < 64 && this.dist(bone, p.ref) < 64;
          result = apart <= p.limit ? "joined" : swapped ? "swapped" : "apart";
        }
        this.send({
          kind, remoteId: remoteId.toString(16), base: this.baseName(ac), mode: p.mode, result, ...extra,
          before: { ref: p.ref.map(Math.round), bone: p.bone.map(Math.round) },
          after: { ref: ref.map(Math.round), bone: bone.map(Math.round) },
        });
        if (!p.late && result === "joined") {
          this.pending.set(remoteId, { ...p, due: now + REPAIR_LATE_MS - REPAIR_CHECK_MS, ref, bone, late: true });
        }
      } catch (e) {
        this.send({ kind, remoteId: remoteId.toString(16), mode: p.mode, result: "error", error: String(e) });
      }
    });
  }

  // Jumps, hops and bounces the player sees on an actor we host, measured on the body, not the reference
  private watchMotion(ac: Actor, remoteId: number, ref: Vec, bone: Vec, now: number): void {
    let t = this.tracks.get(remoteId);
    if (!t) {
      this.tracks.set(remoteId, t = { ref, bone, refZ: [], boneZ: [], hist: [], reportedAt: 0 });
    }
    const boneMoved = this.dist(bone, t.bone);
    const refMoved = this.dist(ref, t.ref);
    const repairedLately = now - (this.repairedAt.get(remoteId) ?? 0) < REPAIR_CHECK_MS * 2;
    t.refZ.push(Math.round(ref[2]));
    t.boneZ.push(Math.round(bone[2]));
    if (t.boneZ.length > HOP_SAMPLES) { t.refZ.shift(); t.boneZ.shift(); }
    t.hist.push([bone, now, ref]);
    while (now - t.hist[0][1] > BOUNCE_MS) t.hist.shift();
    const canReport = now - t.reportedAt >= REPORT_EVERY_MS && !repairedLately;
    const common = () => ({
      remoteId: remoteId.toString(16), base: this.baseName(ac), inCombat: ac.isInCombat(),
      hostedForMs: now - (this.hostedSince.get(remoteId) ?? now), fromPlayer: Math.round(this.fromPlayer(ref)),
    });
    const legs = canReport ? this.bounceLegs(t.hist) : null;
    if (canReport && boneMoved >= JUMP_UNITS) {
      t.reportedAt = now;
      this.send({
        kind: "jump", ...common(), spawn: SpawnProcess.placeMode, boneMoved: Math.round(boneMoved), refMoved: Math.round(refMoved),
        from: { ref: t.ref.map(Math.round), bone: t.bone.map(Math.round) }, to: { ref: ref.map(Math.round), bone: bone.map(Math.round) },
      });
    } else if (canReport && t.boneZ.length === HOP_SAMPLES && this.reversals(t.boneZ) >= 2
      && Math.max(...t.refZ) - Math.min(...t.refZ) < HOP_UNITS) {
      t.reportedAt = now;
      this.send({ kind: "hop", ...common(), boneZ: t.boneZ, refZ: t.refZ });
    } else if (legs) {
      t.reportedAt = now;
      this.send({
        kind: "bounce", ...common(), legs, path: t.hist.map(([p, at]) => [...p.map(Math.round), now - at]),
        refPath: t.hist.map(([, , r]) => r.map(Math.round)), ...this.context(ac, now),
      });
    }
    if (refMoved >= LOCOMOTION_UNITS && refMoved < JUMP_UNITS) this.reportLocomotion(ac, remoteId, refMoved);
    t.ref = ref;
    t.bone = bone;
  }

  // Leg lengths of the newest A to B to A in the window, or null
  private bounceLegs(hist: Array<[Vec, number, Vec]>): number[] | null {
    const c = hist[hist.length - 1][0];
    for (let j = hist.length - 2; j >= 1; j--) {
      const b = hist[j][0];
      const leg2 = this.dist(b, c);
      if (leg2 < BOUNCE_UNITS) continue;
      for (let i = j - 1; i >= 0; i--) {
        const a = hist[i][0];
        const leg1 = this.dist(a, b);
        if (leg1 >= BOUNCE_UNITS && this.dist(a, c) <= Math.min(leg1, leg2) / 2) return [Math.round(leg1), Math.round(leg2)];
      }
    }
    return null;
  }

  // Once per creature base: whether its graph reports a run mode other than Standing while it moves
  private reportLocomotion(ac: Actor, remoteId: number, moved: number): void {
    const baseId = ac.getBaseObject()?.getFormID() ?? 0;
    if (this.locomotionBases.has(baseId)) return;
    this.locomotionBases.add(baseId);
    if (!this.npcKeyword) this.npcKeyword = Keyword.getKeyword("ActorTypeNPC");
    if (!this.npcKeyword || ac.hasKeyword(this.npcKeyword)) return;
    const m = getMovement(ac);
    this.send({
      kind: "locomotion", remoteId: remoteId.toString(16), base: this.baseName(ac), moved: Math.round(moved),
      speed: Math.round(ac.getAnimationVariableFloat("SpeedSampled")), direction: Math.round(ac.getAnimationVariableFloat("Direction") * 100) / 100,
      runMode: m.runMode, sentSpeed: Math.round(m.speed || 0), inCombat: ac.isInCombat(),
    });
  }

  // Copies another client hosts: the nearest few, compared with the latest position the server sent for them
  private pollRemote(now: number): void {
    if (!driftConfig.remote || driftConfig.remoteMax <= 0) {
      this.remote.clear();
      return;
    }
    const pc = Game.getPlayer();
    if (!pc) return;
    const pcPos = [pc.getPositionX(), pc.getPositionY(), pc.getPositionZ()];
    const near: Array<[number, FormModel]> = [];
    for (const form of this.controller.lookupListener(RemoteServer).getWorldModel().forms) {
      if (!form || !form.isHostedByOther || form.isMyClone || form.appearance || form.isDead || !form.movement) continue;
      if (!form.refrId || form.refrId < 0xff000000) continue;
      const d = this.dist(form.movement.pos, pcPos);
      if (d <= driftConfig.remoteRadius) near.push([d, form]);
    }
    near.sort((x, y) => x[0] - y[0]);
    const seen = new Set<number>();
    for (const [, form] of near) {
      if (seen.size >= driftConfig.remoteMax) break;
      const remoteId = Number(form.refrId) % 0x100000000;
      try {
        const localId = remoteIdToLocalId(remoteId);
        const ac = localId ? Actor.from(Game.getFormEx(localId)) : null;
        if (!ac || !ac.is3DLoaded() || ac.isDead()) continue;
        seen.add(remoteId);
        this.sampleRemote(ac, remoteId, form, pcPos, now);
      } catch (e) {
        this.reportOnce(`remoteErr:${remoteId}`, { kind: "error", remoteId: remoteId.toString(16), remote: true, error: String(e) });
      }
    }
    this.remote.forEach((_, id) => { if (!seen.has(id)) this.remote.delete(id); });
  }

  private sampleRemote(ac: Actor, remoteId: number, form: FormModel, pcPos: Vec, now: number): void {
    const m = form.movement!;
    const node = NODES.find(([name]) => NetImmerse.hasNode(ac, name, false));
    const [ref, bone] = node ? this.sample(ac, node[0]) : [this.refPos(ac), this.refPos(ac)];
    const srv = [m.pos[0], m.pos[1], m.pos[2]];
    const err = Math.hypot(ref[0] - srv[0], ref[1] - srv[1]);
    const errZ = ref[2] - srv[2];
    // COM sits above the feet, so only root nodes give a body height against the reference
    const bodyDz = node && node[1] <= ROOT_LIMIT ? bone[2] - ref[2] : 0;
    const age = form.movementAt ? now - form.movementAt : -1;
    let t = this.remote.get(remoteId);
    if (!t) {
      this.remote.set(remoteId, this.newRemoteTrack(form, ref, srv, m.runMode, now));
      return;
    }
    t.form = form;
    const leg = [ref[0] - t.ref[0], ref[1] - t.ref[1], ref[2] - t.ref[2]];
    const step = Math.hypot(leg[0], leg[1], leg[2]);
    const legBefore = Math.hypot(t.leg[0], t.leg[1], t.leg[2]);
    const apply = getApplyState(ac.getFormID());
    const [errT, errTZ] = this.expectedError(ref, srv, apply, m.runMode);
    const target = apply.target ? apply.target.map(Math.round) : null;
    const grade = Math.round(apply.grade * 100) / 100;
    if (step >= REMOTE_EVENT) {
      this.sendRemote(now, {
        kind: "remoteEvent", remoteId: remoteId.toString(16), base: this.baseName(ac), step: Math.round(step),
        from: t.ref.map(Math.round), to: ref.map(Math.round), srv: srv.map(Math.round), target, grade, age, runMode: m.runMode,
        translating: apply.translating, offset: apply.offset, targetAgeMs: apply.targetAgeMs, fromPlayer: Math.round(this.dist(ref, pcPos)),
        rehostClock: driftConfig.rehostClock,
      });
    }
    if (step >= REMOTE_SNAP) t.snaps++;
    if (step >= REMOTE_BOUNCE_LEG && legBefore >= REMOTE_BOUNCE_LEG
      && leg[0] * t.leg[0] + leg[1] * t.leg[1] + leg[2] * t.leg[2] < 0) t.bounces++;
    if (m.runMode === "Standing" && this.dist(srv, t.srv) < 8) t.standDrift += step;
    if (m.runMode === "Standing" && t.runMode !== "Standing") {
      const dx = srv[0] - t.srv[0];
      const dy = srv[1] - t.srv[1];
      const len = Math.hypot(dx, dy);
      t.stopAt = srv;
      t.stopDir = len > 1 ? [dx / len, dy / len] : null;
      t.stopUntil = now + REMOTE_OVERSHOOT_MS;
    }
    if (t.stopAt && t.stopDir && now <= t.stopUntil) {
      t.overshoot = Math.max(t.overshoot, (ref[0] - t.stopAt[0]) * t.stopDir[0] + (ref[1] - t.stopAt[1]) * t.stopDir[1]);
    }
    t.errMax = Math.max(t.errMax, errT);
    if (Math.abs(errTZ) > Math.abs(t.errZMax)) t.errZMax = errTZ;
    if (Math.abs(bodyDz) > Math.abs(t.bodyDzMax)) t.bodyDzMax = bodyDz;
    t.ref = ref;
    t.srv = srv;
    t.leg = leg;
    t.runMode = m.runMode;

    // Every check that tripped in the window, measured against the spot this client meant the copy to be at
    const why: Array<[boolean, string]> = [
      [errT > REMOTE_ERR, "err"], [Math.abs(errTZ) > REMOTE_ERR_Z, "errZ"], [Math.abs(bodyDz) > REMOTE_BODY_DZ, "bodyDz"],
      [step >= REMOTE_SNAP, "snap"], [t.bounces >= REMOTE_BOUNCES, "bounces"], [Math.max(t.gapMax, age) > REMOTE_GAP_MS, "gap"],
    ];
    for (const [hit, name] of why) {
      if (hit && !t.tripped.split(",").includes(name)) t.tripped = t.tripped ? `${t.tripped},${name}` : name;
    }
    if (!t.tripped) {
      if (now - t.since >= REPORT_EVERY_MS) {
        this.remote.set(remoteId, { ...this.newRemoteTrack(form, ref, srv, m.runMode, now), leg, at: t.at, reportedAt: t.reportedAt });
      }
      return;
    }
    if (now - t.reportedAt < REPORT_EVERY_MS) return;
    const sent = this.sendRemote(now, {
      kind: "remote", remoteId: remoteId.toString(16), base: this.baseName(ac), why: t.tripped, node: node ? node[0] : "",
      err: Math.round(err), errZ: Math.round(errZ), errT: Math.round(errT), errTZ: Math.round(errTZ), bodyDz: node && node[1] <= ROOT_LIMIT ? Math.round(bodyDz) : null,
      max: { errT: Math.round(t.errMax), errTZ: Math.round(t.errZMax), bodyDz: Math.round(t.bodyDzMax) }, target, grade,
      rehostClock: driftConfig.rehostClock,
      snaps: t.snaps, bounces: t.bounces, gapMax: t.gapMax, age, standDrift: Math.round(t.standDrift), overshoot: Math.round(t.overshoot),
      windowMs: now - t.since, runMode: m.runMode, speed: Math.round(m.speed || 0), translating: apply.translating, offset: apply.offset,
      targetAgeMs: apply.targetAgeMs, inCombat: ac.isInCombat(), aggression: ac.getActorValue("Aggression"),
      v10: Math.round(ac.getActorValue("Variable10")), fromPlayer: Math.round(this.dist(ref, pcPos)),
      ref: ref.map(Math.round), srv: srv.map(Math.round),
    });
    if (sent) this.remote.set(remoteId, { ...this.newRemoteTrack(form, ref, srv, m.runMode, now), leg, at: t.at, reportedAt: now });
  }

  // XY and Z error against the nearest point of the srv-to-target line while a moving copy translates, else against srv
  private expectedError(ref: Vec, srv: Vec, apply: ReturnType<typeof getApplyState>, runMode: string): [number, number] {
    const target = apply.target;
    let e = srv;
    if (target && apply.translating && runMode !== "Standing" && apply.targetAgeMs >= 0 && apply.targetAgeMs <= TARGET_FRESH_MS) {
      const dx = target[0] - srv[0];
      const dy = target[1] - srv[1];
      const len2 = dx * dx + dy * dy;
      const k = len2 > 1 ? Math.max(0, Math.min(1, ((ref[0] - srv[0]) * dx + (ref[1] - srv[1]) * dy) / len2)) : 0;
      e = [srv[0] + k * dx, srv[1] + k * dy, srv[2] + k * (target[2] - srv[2])];
    }
    return [Math.hypot(ref[0] - e[0], ref[1] - e[1]), ref[2] - e[2]];
  }

  private newRemoteTrack(form: FormModel, ref: Vec, srv: Vec, runMode: string, now: number): RemoteTrack {
    return {
      form, ref, srv, leg: [0, 0, 0], at: form.movementAt ?? 0, runMode, since: now, tripped: "", reportedAt: 0,
      errMax: 0, errZMax: 0, bodyDzMax: 0, snaps: 0, bounces: 0, gapMax: 0, standDrift: 0, overshoot: 0,
      stopAt: null, stopDir: null, stopUntil: 0,
    };
  }

  // Longest silence between movement packets, measured every frame for the sampled copies
  private trackPacketGaps(): void {
    this.remote.forEach((t) => {
      const at = t.form.movementAt;
      if (!at || at === t.at) return;
      if (t.at) t.gapMax = Math.max(t.gapMax, at - t.at);
      t.at = at;
    });
  }

  // At most REMOTE_CAP non-host reports per 30 s from this client
  private sendRemote(now: number, report: Record<string, unknown>): boolean {
    while (this.remoteTimes.length && now - this.remoteTimes[0] >= REPORT_EVERY_MS) this.remoteTimes.shift();
    if (this.remoteTimes.length >= REMOTE_CAP) {
      this.remoteCapped++;
      return false;
    }
    this.remoteTimes.push(now);
    this.remoteSent++;
    this.send(report);
    return true;
  }

  private reversals(z: number[]): number {
    let count = 0;
    let dir = 0;
    let pivot = z[0];
    for (const v of z) {
      const d = v - pivot;
      if (Math.abs(d) < HOP_UNITS) continue;
      const nd = Math.sign(d);
      if (dir !== 0 && nd !== dir) count++;
      dir = nd;
      pivot = v;
    }
    return count;
  }

  private refPos(ac: Actor): Vec {
    return [ac.getPositionX(), ac.getPositionY(), ac.getPositionZ()];
  }

  private sample(ac: Actor, node: string): [Vec, Vec] {
    return [
      this.refPos(ac),
      [
        NetImmerse.getNodeWorldPositionX(ac, node, false),
        NetImmerse.getNodeWorldPositionY(ac, node, false),
        NetImmerse.getNodeWorldPositionZ(ac, node, false),
      ],
    ];
  }

  private dist(a: Vec, b: Vec): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  private fromPlayer(pos: number[]): number {
    const p = Game.getPlayer();
    return p ? Math.hypot(p.getPositionX() - pos[0], p.getPositionY() - pos[1], p.getPositionZ() - pos[2]) : -1;
  }

  private baseName(ac: Actor): string {
    const base = ac.getBaseObject();
    return `${base?.getName() || "?"} ${(base?.getFormID() ?? 0).toString(16)}`;
  }

  private reportOnce(key: string, report: Record<string, unknown>): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.send(report);
  }

  // Drops the animation list first when a report would be cut in the log
  private send(report: Record<string, unknown>): void {
    if (report.anims && JSON.stringify(report).length > REPORT_MAX_CHARS) delete report.anims;
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "npcDrift", args: [report] });
  }

  private nextPoll = 0;
  private nextHeartbeat = 0;
  private splitSince = new Map<number, number>();
  private repairedAt = new Map<number, number>();
  private attempts = new Map<number, number>();
  private hostedSince = new Map<number, number>();
  private loadedSince = new Map<number, number>();
  private sinkAt = new Map<number, number>();
  private reported = new Set<string>();
  private repairMode: RepairMode = "setPosition";
  private pending = new Map<number, Pending>();
  private tracks = new Map<number, HostTrack>();
  private hostedLocal = new Set<number>();
  private anims = new Map<number, Array<[string, number]>>();
  private locomotionBases = new Set<number>();
  private npcKeyword: Keyword | null = null;
  private remote = new Map<number, RemoteTrack>();
  private remoteTimes: number[] = [];
  private remoteSent = 0;
  private remoteCapped = 0;
}
