import { ButtonEvent, InputDeviceType } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";

// Server -> Client: { customPacketType: "dboMeal", state: "start" | "done" | "cancelled", seconds, drink }
// Client -> Server: { customPacketType: "dbo", event: "mealCancel", args: [reason] }
// Eating takes time (Nate, 2026-09-27): the server counts a meal's hunger when it is finished (gamemode.js meals). While
// it lasts the owner walks at half speed; a sprint, an attack or drawing a weapon ends it and the server counts none of
// it. A weapon already out when the meal starts does not end it, so food eaten by accident in a fight is lost only to
// an attack. The eat or drink idle itself is ConsumeAnimationService's.
const SLOW = -50;
const ATTACK_EVENTS = ["Left Attack/Block", "Right Attack/Block"];
// The server always answers; this is only for a lost packet
const GRACE_MS = 3000;

export class MealService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboMeal") return;
    const state = content["state"];
    if (state === "start") {
      const seconds = Math.max(0, Math.min(120, Number(content["seconds"]) || 0));
      this.controller.once("update", () => this.start(seconds));
    } else if (state === "done" || state === "cancelled") {
      this.controller.once("update", () => this.end());
    }
  }

  private start(seconds: number): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    // More food during a meal only moves its end
    if (!this.active) {
      this.setSpeed(SLOW);
      this.weaponWasDrawn = player.isWeaponDrawn();
    }
    this.active = true;
    this.until = Date.now() + seconds * 1000 + GRACE_MS;
    logTrace(this, "Meal started,", seconds, "s");
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!this.active || !e.isDown || e.device === InputDeviceType.Gamepad) return;
    if (ATTACK_EVENTS.indexOf(e.userEventName) !== -1) this.cancel("attack");
  }

  private onUpdate(): void {
    if (!this.active) return;
    if (Date.now() > this.until) { this.end(); return; }
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    if (player.isSprinting()) { this.cancel("sprint"); return; }
    const drawn = player.isWeaponDrawn();
    if (drawn && !this.weaponWasDrawn) { this.cancel("weapon"); return; }
    this.weaponWasDrawn = drawn;
  }

  private cancel(reason: string): void {
    if (!this.active) return;
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "mealCancel", args: [reason] });
    logTrace(this, "Meal cancelled:", reason);
    this.end();
  }

  private end(): void {
    if (!this.active) return;
    this.active = false;
    this.setSpeed(-SLOW);
  }

  // The engine re-reads movement speed only after a carry weight change, hence the nudge (as ParalysisService does)
  private setSpeed(delta: number): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    try {
      player.modActorValue("SpeedMult", delta);
      player.modActorValue("CarryWeight", 0.1);
      player.modActorValue("CarryWeight", -0.1);
    } catch { /* player not ready */ }
  }

  private active = false;
  private until = 0;
  private weaponWasDrawn = false;
}
