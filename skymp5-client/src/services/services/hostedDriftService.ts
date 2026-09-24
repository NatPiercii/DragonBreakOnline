import { Actor, Game, NetImmerse, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { setRefrCollision } from "../../sync/animation";

const POLL_MS = 500;
const HEARTBEAT_MS = 30000;
const REPAIR_COOLDOWN_MS = 10000;
const REPAIR_CHECK_MS = 1000;
// A body that moves this far in one poll without our repair is a visible jump
const JUMP_UNITS = 384;
// Bone height reversals of at least this much, with the reference holding still, are a hop
const HOP_UNITS = 40;
const HOP_SAMPLES = 8;
const REPORT_EVERY_MS = 30000;
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

/**
 * Floating spawned creatures (2026-09-16): the host reports an NPC at ground height while its model hangs
 * in the air and its attacks never land. This compares every NPC we host with its skeleton root; when the
 * two split it tells the gamemode (logged to server.log) and re-seats the reference so havok takes the body
 * back. A heartbeat every 30 s shows the check is running.
 *
 *   Client -> Server: { customPacketType: "dbo", event: "npcDrift", args: [report] }
 */
export class HostedDriftService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  // The gamemode picks how a split is repaired, so each method can be measured without a client build
  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "npcDriftConfig") return;
    const mode = REPAIR_MODES.find((m) => m === content["repair"]);
    if (mode) this.repairMode = mode;
    this.send({ kind: "config", repair: this.repairMode });
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextPoll) return;
    this.nextPoll = now + POLL_MS;

    const hosted = storage["hosted"];
    const ids = Array.isArray(hosted) ? (hosted as number[]) : [];
    const live = new Set(ids.map((raw) => Number(raw) % 0x100000000));
    this.hostedSince.forEach((_, id) => { if (!live.has(id)) this.hostedSince.delete(id); });
    this.loadedSince.forEach((_, id) => { if (!live.has(id)) this.loadedSince.delete(id); });
    this.tracks.forEach((_, id) => { if (!live.has(id)) this.tracks.delete(id); });
    this.checkRepairs(now);
    let checked = 0;
    let split = 0;
    for (const raw of ids) {
      const remoteId = Number(raw) % 0x100000000;
      if (!this.hostedSince.has(remoteId)) this.hostedSince.set(remoteId, now);
      try {
        const localId = remoteIdToLocalId(remoteId);
        const ac = localId ? Actor.from(Game.getFormEx(localId)) : null;
        if (!ac || !ac.is3DLoaded()) this.loadedSince.delete(remoteId);
        else if (!this.loadedSince.has(remoteId)) this.loadedSince.set(remoteId, now);
        if (!ac || ac.getFormID() === 0x14 || ac.isDead() || !ac.is3DLoaded()) continue;
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
          fromPlayer: Math.round(this.fromPlayer(ref)), repair: this.repairMode,
        });
        this.repair(ac, remoteId, nodeName, limit, ref, bone, now);
      } catch (e) {
        this.reportOnce(`err:${remoteId}`, { kind: "error", remoteId: remoteId.toString(16), error: String(e) });
      }
    }

    if (now >= this.nextHeartbeat) {
      this.nextHeartbeat = now + HEARTBEAT_MS;
      this.send({ kind: "heartbeat", hosted: ids.length, checked, split });
    }
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
    this.pending.set(remoteId, { due: now + REPAIR_CHECK_MS, mode, node, limit, ref, bone });
  }

  // Whether the repair joined body and reference, swapped them or left them apart
  private checkRepairs(now: number): void {
    this.pending.forEach((p, remoteId) => {
      if (now < p.due) return;
      this.pending.delete(remoteId);
      try {
        const localId = remoteIdToLocalId(remoteId);
        const ac = localId ? Actor.from(Game.getFormEx(localId)) : null;
        if (!ac || !ac.is3DLoaded()) return this.send({ kind: "repairResult", remoteId: remoteId.toString(16), mode: p.mode, result: "unloaded" });
        const [ref, bone] = this.sample(ac, p.node);
        const apart = Math.hypot(bone[0] - ref[0], bone[1] - ref[1], bone[2] - ref[2]);
        const swapped = this.dist(ref, p.bone) < 64 && this.dist(bone, p.ref) < 64;
        const result = apart <= p.limit ? "joined" : swapped ? "swapped" : "apart";
        this.send({
          kind: "repairResult", remoteId: remoteId.toString(16), base: this.baseName(ac), mode: p.mode, result,
          before: { ref: p.ref.map(Math.round), bone: p.bone.map(Math.round) },
          after: { ref: ref.map(Math.round), bone: bone.map(Math.round) },
        });
      } catch (e) {
        this.send({ kind: "repairResult", remoteId: remoteId.toString(16), mode: p.mode, result: "error", error: String(e) });
      }
    });
  }

  // Jumps and hops the player sees on an actor we host, measured on the body, not the reference
  private watchMotion(ac: Actor, remoteId: number, ref: Vec, bone: Vec, now: number): void {
    let t = this.tracks.get(remoteId);
    if (!t) {
      this.tracks.set(remoteId, t = { ref, bone, refZ: [], boneZ: [], reportedAt: 0 });
    }
    const boneMoved = this.dist(bone, t.bone);
    const refMoved = this.dist(ref, t.ref);
    const repairedLately = now - (this.repairedAt.get(remoteId) ?? 0) < REPAIR_CHECK_MS * 2;
    t.refZ.push(Math.round(ref[2]));
    t.boneZ.push(Math.round(bone[2]));
    if (t.boneZ.length > HOP_SAMPLES) { t.refZ.shift(); t.boneZ.shift(); }
    const canReport = now - t.reportedAt >= REPORT_EVERY_MS && !repairedLately;
    const common = () => ({
      remoteId: remoteId.toString(16), base: this.baseName(ac), inCombat: ac.isInCombat(),
      hostedForMs: now - (this.hostedSince.get(remoteId) ?? now), fromPlayer: Math.round(this.fromPlayer(ref)),
    });
    if (canReport && boneMoved >= JUMP_UNITS) {
      t.reportedAt = now;
      this.send({
        kind: "jump", ...common(), boneMoved: Math.round(boneMoved), refMoved: Math.round(refMoved),
        from: { ref: t.ref.map(Math.round), bone: t.bone.map(Math.round) }, to: { ref: ref.map(Math.round), bone: bone.map(Math.round) },
      });
    } else if (canReport && t.boneZ.length === HOP_SAMPLES && this.reversals(t.boneZ) >= 2
      && Math.max(...t.refZ) - Math.min(...t.refZ) < HOP_UNITS) {
      t.reportedAt = now;
      this.send({ kind: "hop", ...common(), boneZ: t.boneZ, refZ: t.refZ });
    }
    t.ref = ref;
    t.bone = bone;
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

  private sample(ac: Actor, node: string): [Vec, Vec] {
    return [
      [ac.getPositionX(), ac.getPositionY(), ac.getPositionZ()],
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

  private send(report: Record<string, unknown>): void {
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "npcDrift", args: [report] });
  }

  private nextPoll = 0;
  private nextHeartbeat = 0;
  private splitSince = new Map<number, number>();
  private repairedAt = new Map<number, number>();
  private attempts = new Map<number, number>();
  private hostedSince = new Map<number, number>();
  private loadedSince = new Map<number, number>();
  private reported = new Set<string>();
  private repairMode: RepairMode = "setPosition";
  private pending = new Map<number, { due: number; mode: RepairMode; node: string; limit: number; ref: Vec; bone: Vec }>();
  private tracks = new Map<number, { ref: Vec; bone: Vec; refZ: number[]; boneZ: number[]; reportedAt: number }>();
}
