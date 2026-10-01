import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace, logError } from "../../logging";
import { CastSelfQueue, CastSelfRequest, readCastSelfRequest } from "./castSelfQueue";

// Server -> Client: { customPacketType: "dboCastSelf", spell: <form id>, text?: string } (read in castSelfQueue.ts)
// The server cannot apply a spell's effects to a player (Papyrus natives reach the player only as snippets, and a
// Spell has no Cast there), so it asks the player's own client: an Ayleid well's Boon of the Ayleids, later the rank
// howls of the Great Hunt. Spell.Cast is instant and plays no animation (CK wiki Cast - Spell), and needs the spell
// only as a form, not in the player's list.
// Server -> Client: { customPacketType: "dboDispelSelf", spell: <form id> }
// The other half: a shrine blessing that ends before the spell's own duration does (the faiths' 4 h blessing over an
// 8 h altar spell, a turn to another god, a staff reset) is taken off the player here, with Actor.DispelSpell, as
// beastFormService ends a beast power. Anything that is not a spell is ignored, and a spell with no active effect on
// the player is nothing to dispel. Clients before this ignored the packet and let the effect run out by itself.
// Both go through one queue, in the order they came (castSelfQueue.ts says why).
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
  private queue: CastSelfQueue;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.queue = new CastSelfQueue(
      (drain) => this.controller.once("update", drain),
      (request) => this.carryOut(request),
      (request, e) => logError(this, request ? `${request.kind === "cast" ? "Cast" : "Dispel"} on self failed` : "Cast on self", request ? request.spell.toString(16) : "", e),
    );
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const request = readCastSelfRequest(parseCustomPacket(event));
    if (request) this.queue.push(request);
  }

  private carryOut(request: CastSelfRequest): Promise<void> | void {
    return request.kind === "dispel" ? this.dispel(request.spell) : this.cast(request.spell, request.text);
  }

  // The Promise settles when the cast has landed; the queue holds what came after it until then
  private cast(spellId: number, text: string): Promise<void> | void {
    const player = this.sp.Game.getPlayer();
    const spell = this.sp.Spell.from(this.sp.Game.getFormEx(spellId));
    if (!player || !spell || player.isDead()) {
      logTrace(this, "No cast of", spellId.toString(16), !spell ? "(not a spell here)" : "(no living player)");
      return;
    }
    // Magicka is logged around the cast until an in-game test says whether Cast charges it
    const before = player.getActorValue("Magicka");
    serverCasts.set(spellId, Date.now() + SERVER_CAST_MS);
    const landed = spell.cast(player, player)
      .then(() => {
        this.controller.once("update", () => {
          const p = this.sp.Game.getPlayer();
          logTrace(this, "Cast", spellId.toString(16), "on self; magicka", before, "->", p ? p.getActorValue("Magicka") : "?");
        });
      });
    if (text) {
      try { this.sp.Debug.notification(text); } catch { /* no hud */ }
    }
    return landed;
  }

  private dispel(spellId: number): void {
    const player = this.sp.Game.getPlayer();
    const spell = this.sp.Spell.from(this.sp.Game.getFormEx(spellId));
    if (!player || !spell) {
      logTrace(this, "No dispel of", spellId.toString(16), !spell ? "(not a spell here)" : "(no player)");
      return;
    }
    const ended = player.dispelSpell(spell);
    logTrace(this, "Dispel", spellId.toString(16), "on self:", ended ? "ended" : "was not active");
  }
}
