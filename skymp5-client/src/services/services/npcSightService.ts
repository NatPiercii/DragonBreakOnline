import { Actor, Game } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { remoteIdToLocalId } from "../../view/worldViewMisc";

// NPC system v2 (server NPC_SYSTEM_V2.md), phase 2: the server picks which client drives each NPC. Once a second
// this client tells it which NPCs it has loaded here and how far away they are; server/npcdirector.js chooses the
// nearest player who has an NPC loaded as its host. Players (forms with an appearance) and the player's own clone are
// left out, and only the nearest REPORT_MAX are sent.
//
//   Client -> Server: dbo npcSight [[remoteIdHex, distance], ...]
const REPORT_MS = 1000;
const REPORT_MAX = 64;

export class NpcSightService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextReport) return;
    this.nextReport = now + REPORT_MS;
    const player = Game.getPlayer();
    if (!player) return;
    const world = this.controller.lookupListener(RemoteServer).getWorldModel();
    const seen: Array<[string, number]> = [];
    for (const form of world.forms) {
      if (!form || form.appearance || form.isMyClone || typeof form.refrId !== "number") continue;
      const remoteId = form.refrId >>> 0;
      if (remoteId < 0xff000000 && !form.baseId) continue;
      try {
        const localId = remoteIdToLocalId(remoteId);
        if (!localId) continue;
        const ac = Actor.from(Game.getFormEx(localId));
        if (!ac || !ac.is3DLoaded() || ac.isDead()) continue;
        seen.push([remoteId.toString(16), Math.round(player.getDistance(ac))]);
      } catch { /* unloading */ }
    }
    seen.sort((a, b) => a[1] - b[1]);
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "npcSight", args: [seen.slice(0, REPORT_MAX)] });
  }

  private nextReport = 0;
}
