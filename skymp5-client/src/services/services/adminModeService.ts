import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { showSystemNotification } from "./systemNotification";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { GHOST_ALPHA, GHOST_SHADER_ID } from "../../lib/ghostLook";

const INVIS_REAPPLY_MS = 2000;
const LOCAL_MODES = ["god", "noclip", "ghost", "invis"];

/**
 * Applies admin mode toggles pushed by the server's AdminSystem:
 *   { customPacketType: "adminMode", mode, on }
 * god/noclip/ghost/invis map to local natives; smite/healhit are fully
 * server-side; freecam has no SkyrimPlatform native (tfc stays a console
 * command for admins, who already hold consoleCommandsAllowed).
 * God also holds server-side (AdminSystem refuses hit damage); FormView hides remote invis admins via ff_adminModes, and shows them to admins as ghosts.
 * Ghost looks like one: the ethereal shader and half alpha here, and to everyone else through the same mirror.
 */
export class AdminModeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("connectionAccepted", () => this.controller.once("update", () => this.resetLocalModes()));
  }

  // A new session starts with every mode off; the server re-sends the active ones after login
  private resetLocalModes(): void {
    for (const mode of Array.from(this.localModes)) this.apply(mode, false);
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content && content["customPacketType"] === "dboTeachShouts") {
      const shouts = Array.isArray(content["shouts"]) ? content["shouts"] as Array<{ shout: string; words: string[] }> : [];
      this.controller.once("update", () => this.teachShouts(shouts));
      return;
    }
    if (!content || content["customPacketType"] !== "adminMode") return;
    const mode = String(content["mode"] ?? "");
    const on = !!content["on"];
    // Natives throw in the packet-handler context; defer to update
    this.controller.once("update", () => this.apply(mode, on));
  }

  // Admin panel "all shouts": the server has no shout storage, so it sends the list at the grant and at every login.
  // desc is "hex:Plugin.esm"; every word is learned and unlocked, then the shout is added.
  private teachShouts(shouts: Array<{ shout: string; words: string[] }>): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    const formOf = (desc: string) => {
      const i = String(desc).indexOf(":");
      if (i < 0) return null;
      try { return this.sp.Game.getFormFromFile(parseInt(desc.slice(0, i), 16), desc.slice(i + 1)); } catch { return null; }
    };
    let taught = 0;
    for (const entry of shouts) {
      for (const w of entry.words || []) {
        const word = this.sp.WordOfPower.from(formOf(w));
        if (!word) continue;
        try { this.sp.Game.teachWord(word); this.sp.Game.unlockWord(word); } catch { /* not a word in this load order */ }
      }
      const shout = this.sp.Shout.from(formOf(entry.shout));
      if (shout) { try { player.addShout(shout); taught++; } catch { /* already known */ } }
    }
    showSystemNotification(this.sp, `You know ${taught} shouts.`);
  }

  private apply(mode: string, on: boolean): void {
    const player = this.sp.Game.getPlayer();
    if (LOCAL_MODES.includes(mode)) {
      if (on) this.localModes.add(mode);
      else this.localModes.delete(mode);
    }
    switch (mode) {
      case "god":
        this.sp.Debug.setGodMode(on);
        break;
      case "noclip":
        // toggleCollisions is a toggle; track local state so repeated packets stay in sync
        if (this.collisionsDisabled !== on) {
          this.sp.Debug.toggleCollisions();
          this.collisionsDisabled = on;
        }
        break;
      case "ghost": {
        player?.setGhost(on);
        this.ghostly = on;
        const shader = this.sp.EffectShader.from(this.sp.Game.getFormEx(GHOST_SHADER_ID));
        if (player) { shader?.stop(player); if (on) shader?.play(player, -1); }
        this.applyAlpha(true);
        break;
      }
      case "invis":
        this.invisible = on;
        this.applyAlpha(true);
        break;
      case "freecam":
        showSystemNotification(this.sp, on
          ? "Freecam has no hotkey: open the console (~) and type tfc"
          : "Freecam off; if the camera is still free, type tfc in the console (~) again");
        break;
      case "smite":
        showSystemNotification(this.sp, on ? "Smite enabled" : "Smite disabled");
        break;
      case "healhit":
        showSystemNotification(this.sp, on ? "Heal-on-hit enabled" : "Heal-on-hit disabled");
        break;
      default:
        break;
    }
  }

  // Invisible wins over Ghost; with neither, the player is fully visible again
  private applyAlpha(fade: boolean): void {
    this.lastInvisApply = Date.now();
    this.sp.Game.getPlayer()?.setAlpha(this.invisible ? 0 : this.ghostly ? GHOST_ALPHA : 1, fade);
  }

  // Respawn and 3D reloads reset the player's alpha
  private onUpdate(): void {
    if ((!this.invisible && !this.ghostly) || Date.now() - this.lastInvisApply < INVIS_REAPPLY_MS) return;
    this.applyAlpha(false);
  }

  private collisionsDisabled = false;
  private invisible = false;
  private ghostly = false;
  private lastInvisApply = 0;
  private localModes = new Set<string>();
}
