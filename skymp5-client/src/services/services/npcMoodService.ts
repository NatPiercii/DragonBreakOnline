import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, FormType } from "skyrimPlatform";
import { isRemoteHostedByMe, remoteIdToLocalId } from "../../view/worldViewMisc";
import { MoodSet, MoodWorld, readMoodPacket } from "./npcMoodPlan";

const POLL_MS = 250;
const TARGET_RADIUS = 2048;
const MAX_REFS = 256;
const RANDOM_TRIES = 4;
const NOTE_BUDGET = 200;

/**
 * Harmony and Mayhem (server npcmood.js): an NPC this game hosts is calmed or frenzied for a few seconds. Papyrus calls
 * from the server never reach an NPC, so its host does it here; the plan is npcMoodPlan.ts.
 *
 *   Server -> Client: { customPacketType: "dboNpcMood", refId: <server form id>, mode: "calm" | "frenzy", seconds }
 *
 * Actors are looked up again on every poll (a native object is only valid in the frame it came from).
 */
export class NpcMoodService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboNpcMood") return;
    const packet = readMoodPacket(content);
    if (packet) this.moods.receive(packet, Date.now());
  }

  private onUpdate(): void {
    if (!this.moods.entries.size) return;
    const now = Date.now();
    if (now < this.nextPoll) return;
    this.nextPoll = now + POLL_MS;
    try {
      this.moods.tick(this.world(now));
    } catch (e) {
      this.note({ kind: "npcMood", step: "error", error: String(e).slice(0, 200) });
    }
  }

  private world(now: number): MoodWorld<Actor> {
    return {
      now,
      actorOf: (id) => {
        const local = id >= 0xff000000 ? remoteIdToLocalId(id) : id;
        const actor = local ? Actor.from(this.sp.Game.getFormEx(local)) : null;
        return actor && !actor.isDeleted() ? actor : null;
      },
      loaded: (actor) => actor.is3DLoaded() && !actor.isDisabled(),
      hostedByMe: (id) => isRemoteHostedByMe(id),
      nearestTarget: (actor) => this.nearestTarget(actor),
      note: (line) => this.note(line),
    };
  }

  private nearestTarget(actor: Actor): Actor | null {
    const self = actor.getFormID();
    const usable = (a: Actor | null): a is Actor =>
      !!a && a.getFormID() !== self && a.getFormID() !== 0x14 && !a.isDead() && !a.isDisabled() && a.is3DLoaded();
    let best: Actor | null = null;
    let bestDist = TARGET_RADIUS;
    const cell = actor.getParentCell();
    const n = cell ? Math.min(MAX_REFS, cell.getNumRefs(FormType.Character)) : 0;
    for (let i = 0; i < n; i++) {
      const a = Actor.from(cell ? cell.getNthRef(i, FormType.Character) : null);
      if (!usable(a)) continue;
      const d = actor.getDistance(a);
      if (d < bestDist) { best = a; bestDist = d; }
    }
    // An exterior cell holds only its own refs; the actor may stand at its edge
    for (let i = 0; !best && i < RANDOM_TRIES; i++) {
      const a = this.sp.Game.findRandomActor(actor.getPositionX(), actor.getPositionY(), actor.getPositionZ(), TARGET_RADIUS);
      if (usable(a)) best = a;
    }
    if (best) return best;
    const player = this.sp.Game.getPlayer();
    return player && !player.isDead() && actor.getDistance(player) < TARGET_RADIUS ? player : null;
  }

  private note(line: Record<string, unknown>): void {
    if (this.notesSent >= NOTE_BUDGET) return;
    this.notesSent++;
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "npcDrift", args: [line] });
  }

  private moods = new MoodSet();
  private nextPoll = 0;
  private notesSent = 0;
}
