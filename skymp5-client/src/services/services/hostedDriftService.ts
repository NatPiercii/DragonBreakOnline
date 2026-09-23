import { Actor, Game, NetImmerse, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { setRefrCollision } from "../../sync/animation";

const POLL_MS = 500;
const HEARTBEAT_MS = 30000;
const REPAIR_COOLDOWN_MS = 10000;
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
        const ref = [ac.getPositionX(), ac.getPositionY(), ac.getPositionZ()];
        const bone = [
          NetImmerse.getNodeWorldPositionX(ac, nodeName, false),
          NetImmerse.getNodeWorldPositionY(ac, nodeName, false),
          NetImmerse.getNodeWorldPositionZ(ac, nodeName, false),
        ];
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
          fromPlayer: Math.round(this.fromPlayer(ref)),
        });
        ac.stopTranslation();
        setRefrCollision(ac.getFormID(), true);
        ac.setPosition(ref[0], ref[1], ref[2]);
      } catch (e) {
        this.reportOnce(`err:${remoteId}`, { kind: "error", remoteId: remoteId.toString(16), error: String(e) });
      }
    }

    if (now >= this.nextHeartbeat) {
      this.nextHeartbeat = now + HEARTBEAT_MS;
      this.send({ kind: "heartbeat", hosted: ids.length, checked, split });
    }
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
}
