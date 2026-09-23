import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";

// Server -> Client: { customPacketType: "dboParalyse", seconds }
//                  { customPacketType: "dboStatus", kind, seconds, speedMult, text }  (Howl of Terror)
// Paralysis the engine never applies on this client: a rune's lives on its explosion's enchantment (Ash Rune), and the
// caster's engine paralyses only its own copy of us. The server already refuses our movement, hits and casts meanwhile.
export class ParalysisService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content && content["customPacketType"] === "dboStatus") { this.onStatus(content); return; }
    if (!content || content["customPacketType"] !== "dboParalyse") return;
    const seconds = Math.max(0, Math.min(120, Number(content["seconds"]) || 0));
    if (!seconds) return;
    this.until = Math.max(this.until, Date.now() + seconds * 1000);
    this.controller.once("update", () => {
      this.hold(true);
      try { this.sp.Debug.notification(`You are held fast for ${seconds} seconds.`); } catch { /* no hud */ }
    });
    logTrace(this, "Paralysed for", seconds);
  }

  // A timed SpeedMult change; the engine only re-reads movement speed after a carry weight change, hence the nudge
  private onStatus(content: Record<string, unknown>): void {
    const seconds = Math.max(0, Math.min(60, Number(content["seconds"]) || 0));
    const speed = Math.max(-90, Math.min(0, Number(content["speedMult"]) || 0));
    if (!seconds) return;
    this.controller.once("update", () => {
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      if (!this.slowApplied && speed) { this.setSpeed(speed); this.slowApplied = speed; }
      this.slowUntil = Math.max(this.slowUntil, Date.now() + seconds * 1000);
      const text = String(content["text"] || "");
      if (text) { try { this.sp.Debug.notification(text); } catch { /* no hud */ } }
    });
  }

  private setSpeed(delta: number): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    try {
      player.modActorValue("SpeedMult", delta);
      player.modActorValue("CarryWeight", 0.1);
      player.modActorValue("CarryWeight", -0.1);
    } catch { /* player not ready */ }
  }

  private onUpdate(): void {
    if (this.slowApplied && Date.now() >= this.slowUntil) { this.setSpeed(-this.slowApplied); this.slowApplied = 0; }
    if (this.until && Date.now() >= this.until) {
      this.until = 0;
      this.hold(false);
    }
  }

  // (movement, fighting, camSwitch, looking, sneaking, menu, activate, journalTabs, disablePOVType)
  private hold(on: boolean): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    try {
      player.setDontMove(on);
      if (on) this.sp.Game.disablePlayerControls(true, true, false, false, true, false, true, false, 0);
      else this.sp.Game.enablePlayerControls(true, true, false, false, true, false, true, false, 0);
    } catch { /* player not ready */ }
  }

  private until = 0;
  private slowUntil = 0;
  private slowApplied = 0;
}
