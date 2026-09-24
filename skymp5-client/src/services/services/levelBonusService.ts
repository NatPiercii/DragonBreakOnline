import { Game } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

const VITALS = ["health", "magicka", "stamina"] as const;

/**
 * Character level-ups raise a maximum mid-session. The server already counts the bonus (private.dboAvBonus),
 * and the next login's creation message carries it, so only the gain is added here.
 *
 *   Server -> Client: { customPacketType: "dboAvGain", health?, magicka?, stamina? }
 */
export class LevelBonusService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboAvGain") return;
    this.controller.once("update", () => {
      const player = Game.getPlayer();
      if (!player) return;
      for (const av of VITALS) {
        const gain = Number(content[av]);
        if (gain > 0 && gain <= 1000) player.setActorValue(av, player.getBaseActorValue(av) + gain);
      }
    });
  }
}
