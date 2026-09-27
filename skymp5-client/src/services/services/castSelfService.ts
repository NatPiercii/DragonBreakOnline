import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace, logError } from "../../logging";

// Server -> Client: { customPacketType: "dboCastSelf", spell: <form id>, text?: string }
// The server cannot apply a spell's effects to a player (Papyrus natives reach the player only as snippets, and a
// Spell has no Cast there), so it asks the player's own client: an Ayleid well's Boon of the Ayleids, later the rank
// howls of the Great Hunt. Spell.Cast is instant and plays no animation (CK wiki Cast - Spell), and needs the spell
// only as a form, not in the player's list.
const CAST_SELF = "dboCastSelf";
// The engine reports such a cast as the player's own; magicSyncService does not relay one the server asked for
const SERVER_CAST_MS = 3000;
const serverCasts = new Map<number, number>(); // spell form id -> relay suppressed until

export const isServerCast = (spellId: number): boolean => {
  const until = serverCasts.get(spellId);
  if (until === undefined) return false;
  if (Date.now() > until) {
    serverCasts.delete(spellId);
    return false;
  }
  return true;
};

export class CastSelfService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== CAST_SELF) return;
    const spellId = Number(content["spell"]) >>> 0;
    const text = typeof content["text"] === "string" ? content["text"] : "";
    if (!spellId) return;
    this.controller.once("update", () => this.cast(spellId, text));
  }

  private cast(spellId: number, text: string): void {
    const player = this.sp.Game.getPlayer();
    const spell = this.sp.Spell.from(this.sp.Game.getFormEx(spellId));
    if (!player || !spell || player.isDead()) {
      logTrace(this, "No cast of", spellId.toString(16), !spell ? "(not a spell here)" : "(no living player)");
      return;
    }
    // Magicka is logged around the cast until an in-game test says whether Cast charges it
    const before = player.getActorValue("Magicka");
    serverCasts.set(spellId, Date.now() + SERVER_CAST_MS);
    spell.cast(player, player)
      .then(() => {
        this.controller.once("update", () => {
          const p = this.sp.Game.getPlayer();
          logTrace(this, "Cast", spellId.toString(16), "on self; magicka", before, "->", p ? p.getActorValue("Magicka") : "?");
        });
      })
      .catch((e) => logError(this, "Cast on self failed", spellId.toString(16), e));
    if (text) {
      try { this.sp.Debug.notification(text); } catch { /* no hud */ }
    }
  }
}
