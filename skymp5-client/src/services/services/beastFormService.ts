import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Race } from "skyrimPlatform";
import { logError, logTrace } from "../../logging";

// Server -> Client: { customPacketType: "dboBeast", race: <race form id>, beast: boolean }
// The server owns the transform (server\beastform.js): it swaps appearance.raceId, which other clients rebuild from,
// and asks this client to swap the player's own race, which appearance sync alone never does (setNpcRace keeps the skeleton).
export class BeastFormService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onBeastMessage(e));
  }

  private onBeastMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboBeast") return;
    const raceId = Number(content["race"]) >>> 0;
    const beast = content["beast"] === true;
    // remoteServer skips the own-appearance echo for a beast race, so the base record keeps the real race and head
    const races = ((globalThis as any).__dboBeastRaces = (globalThis as any).__dboBeastRaces || new Set<number>());
    if (beast) races.add(raceId);
    this.controller.once("update", () => {
      try {
        const player = this.sp.Game.getPlayer();
        const race = Race.from(this.sp.Game.getFormEx(raceId));
        if (!player || !race) { logError(this, "race not found", raceId.toString(16)); return; }
        if (beast) player.unequipAll();
        player.setRace(race);
        if (beast) this.sp.Game.forceThirdPerson();
        logTrace(this, beast ? "Took beast form" : "Returned to own race", raceId.toString(16));
      } catch (e) {
        logError(this, "setRace failed", e);
      }
    });
  }
}
