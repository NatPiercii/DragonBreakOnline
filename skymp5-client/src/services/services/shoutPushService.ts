import { Actor, Debug, Game, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";
import { MsgType } from "../../messages";
import { SpellCastMsgData } from "../messages/spellCastMessage";

// A shout that knocks people back (Unrelenting Force) only pushed its target on the shouter's screen: the push is
// physics, and the victim's own game never ran it (Nate, 2026-09-28: shouts, a draugr's included, did nothing).
// The server tells the victim's client, which pushes its own player away from the shouter's local copy.
//
// Server -> client: { customPacketType: "dboPush", from: <server actor id>, force }  force 0 = a stagger only
//                   { customPacketType: "dboShoutFx", data: <SpellCastMsgData> }   another player's shout to show
// A shout's wave, breath or projectile never reached anyone else: the server does not relay a player's shout word as
// a cast (review A4-1). The gamemode now checks it against the shout gate and sends it here, and it is replayed through
// the very path a relayed cast takes (RemoteServer.onSpellCastMessage: castSpellImmediate on the shouter's clone, with
// CloneSpellGuardService keeping its effects off this player; the server alone lands the shout's hits).
export class ShoutPushService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content && content["customPacketType"] === "dboShoutFx") { this.onShoutFx(content); return; }
    if (!content || content["customPacketType"] !== "dboPush") return;
    const from = Number(content["from"]) >>> 0;
    const force = Math.max(0, Math.min(20, Number(content["force"]) || 0));
    this.controller.once("update", () => {
      const player = Game.getPlayer();
      if (!player || player.isDead()) return;
      if (force <= 0) {
        Debug.sendAnimationEvent(player, "staggerStart");
        return;
      }
      let source: ObjectReference | null = null;
      try { source = ObjectReference.from(Game.getFormEx(remoteIdToLocalId(from))); } catch { source = null; }
      // Without the shouter loaded here there is no direction to push from: stagger instead
      if (!source || !Actor.from(source)?.is3DLoaded()) {
        Debug.sendAnimationEvent(player, "staggerStart");
        return;
      }
      source.pushActorAway(player, force);
      logTrace(this, `pushed by ${from.toString(16)} with force ${force}`);
    });
  }

  private onShoutFx(content: Record<string, unknown>): void {
    const data = content["data"] as SpellCastMsgData | undefined;
    if (!data || typeof data !== "object" || !data.spell || !data.caster) return;
    this.controller.emitter.emit("spellCastMessage", { message: { t: MsgType.SpellCast, data } });
    logTrace(this, `replaying shout ${Number(data.spell).toString(16)} of ${Number(data.caster).toString(16)}`);
  }
}
