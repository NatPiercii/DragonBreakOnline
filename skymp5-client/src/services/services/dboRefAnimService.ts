import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ObjectReference } from "skyrimPlatform";

const POLL_MS = 500;
const GIVE_UP_MS = 30000;

/**
 * Plays an animation on a world object for this player alone. A ruin's stair opened before they arrived
 * (server ruinbuttons.js) is the case: the server's PlayGamebryoAnimation goes to every client in the cell at the
 * moment of the press, and a gamebryo sequence is not kept as the object's lastAnimation, so a player entering
 * later would see it closed (Beyond Skyrim's bskarpitstairs01.nif animates only by its "Open"/"Close" sequences).
 *
 *   Server -> Client: { customPacketType: "dboRefAnim", refId: <formId>, name: string, gamebryo: boolean }
 *
 * The player has usually just arrived, so the object's 3D may not be loaded yet: the play waits for it, looking the
 * object up again on every poll (a native object is only valid in the frame it came from), and gives up after 30 s.
 */
export class DboRefAnimService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboRefAnim") return;
    const refId = Number(content["refId"]) >>> 0;
    const name = content["name"];
    if (!refId || typeof name !== "string" || !name) return;
    this.pending.set(refId, { name, gamebryo: !!content["gamebryo"], until: Date.now() + GIVE_UP_MS });
  }

  private onUpdate(): void {
    if (!this.pending.size) return;
    const now = Date.now();
    if (now < this.nextPoll) return;
    this.nextPoll = now + POLL_MS;
    this.pending.forEach((p, refId) => {
      if (now > p.until) { this.pending.delete(refId); return; }
      const ref = ObjectReference.from(this.sp.Game.getFormEx(refId));
      if (!ref || ref.isDisabled() || !ref.is3DLoaded()) return;
      try {
        if (p.gamebryo) ref.playGamebryoAnimation(p.name, true, 0);
        else ref.playAnimation(p.name);
      } catch { /* tried once with its 3D loaded; nothing more to do */ }
      this.pending.delete(refId);
    });
  }

  private pending = new Map<number, { name: string; gamebryo: boolean; until: number }>();
  private nextPoll = 0;
}
