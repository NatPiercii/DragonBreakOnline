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
// Server -> Client: { customPacketType: "dboDispelSelf", spell: <form id> }
// The other half: a shrine blessing that ends before the spell's own duration does (the faiths' 4 h blessing over an
// 8 h altar spell, a turn to another god, a staff reset) is taken off the player here, with Actor.DispelSpell, as
// beastFormService ends a beast power. Anything that is not a spell is ignored, and a spell with no active effect on
// the player is nothing to dispel. Clients before this ignored the packet and let the effect run out by itself.
const DISPEL_SELF = "dboDispelSelf";
// The engine reports such a cast as the player's own; magicSyncService does not relay the one the server asked for.
// Each request covers one cast of that spell within the window, so the player's own casts of it still go through.
const SERVER_CAST_MS = 3000;
const serverCasts = new Map<number, number>(); // spell form id -> relay suppressed until

export const consumeServerCast = (spellId: number): boolean => {
  const until = serverCasts.get(spellId);
  if (until === undefined) return false;
  serverCasts.delete(spellId);
  return Date.now() <= until;
};

export class CastSelfService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    const type = content["customPacketType"];
    if (type !== CAST_SELF && type !== DISPEL_SELF) return;
    const spellId = Number(content["spell"]) >>> 0;
    if (!spellId) return;
    // Both wait for the next update, in the order they came: a dispel and then a cast of the same spell (a blessing
    // given again) end the old effect before the new one starts
    if (type === DISPEL_SELF) {
      this.controller.once("update", () => this.dispel(spellId));
      return;
    }
    const text = typeof content["text"] === "string" ? content["text"] : "";
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

  private dispel(spellId: number): void {
    const player = this.sp.Game.getPlayer();
    const spell = this.sp.Spell.from(this.sp.Game.getFormEx(spellId));
    if (!player || !spell) {
      logTrace(this, "No dispel of", spellId.toString(16), !spell ? "(not a spell here)" : "(no player)");
      return;
    }
    let ended = false;
    try {
      ended = player.dispelSpell(spell);
    } catch (e) {
      logError(this, "Dispel on self failed", spellId.toString(16), e);
      return;
    }
    logTrace(this, "Dispel", spellId.toString(16), "on self:", ended ? "ended" : "was not active");
  }
}
