import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket } from "./customPacketUtil";

// Server -> client: { customPacketType: "dboShake", strength: 0..1, seconds } (server supernatural.js: a forced werewolf
// change is felt coming). Anything else, or a malformed packet, is null; strength is held to 0..1 and seconds to 0..10.
export const readShake = (content: Record<string, unknown> | null | undefined): { strength: number; seconds: number } | null => {
  if (!content || content["customPacketType"] !== "dboShake") return null;
  const strength = Number(content["strength"]), seconds = Number(content["seconds"]);
  if (!Number.isFinite(strength) || !Number.isFinite(seconds) || strength <= 0 || seconds <= 0) return null;
  return { strength: Math.min(1, strength), seconds: Math.min(10, seconds) };
};

/** Shakes the player's camera when the server asks (Game.ShakeCamera from the player, so at full strength). */
export class CameraShakeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const shake = readShake(parseCustomPacket(event));
    if (!shake) return;
    this.controller.once("update", () => {
      try { this.sp.Game.shakeCamera(this.sp.Game.getPlayer(), shake.strength, shake.seconds); } catch { /* no player yet */ }
    });
  }
}
