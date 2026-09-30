import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";
import { MoveSample, MOVING_SPEED, DECAY_RATIO, isMinigameWidget, shouldClearAutoMove, stillPlausible } from "./autoMoveClear";

// Auto-move (auto-run) keeps the player walking with no key held. When a mini-game widget takes the keyboard the
// player cannot stop, so they drift through the round and often out of range of the station. This switches it off
// with the player's own Auto-Move key when such a widget opens focused. autoMoveClear.ts holds the decision and
// says why two samples are needed; this only gathers them and taps.
const SAMPLE_GAP_MS = 250;
// Three, not the two the rule needs: a player arrives at these games mid-stop, and a third reading over 500 ms gives a
// slow decay room to show itself (Worker D's review, 2026-09-30)
const SAMPLES = 3;
const LOG_NAME = "dbo-diag";
// Movement controls as controlmap.txt names them, so a player who remapped WASD is read by their own keys
const MOVE_CONTROLS = ["Forward", "Back", "Strafe Left", "Strafe Right"];

export class AutoMoveService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
  }

  // Called by dboRelayService when a widget opens with focus
  public onFocusedWidget(widgetType: unknown): void {
    if (this.busy || !isMinigameWidget(widgetType)) return;
    this.busy = true;
    this.samples = [];
    this.take(String(widgetType));
  }

  private take(widgetType: string): void {
    const s = this.sample();
    if (!s) { this.busy = false; return; }
    this.samples.push(s);
    // The moment the run cannot end in a tap, stop: no need to wait on a player standing still, holding a key or slowing
    if (!stillPlausible(this.samples)) { this.finish(widgetType, false); return; }
    if (this.samples.length >= SAMPLES) {
      this.finish(widgetType, shouldClearAutoMove(widgetType, this.samples));
      return;
    }
    this.wait(Date.now() + SAMPLE_GAP_MS, () => this.take(widgetType));
  }

  private finish(widgetType: string, tap: boolean): void {
    if (tap) this.tap();
    this.report(widgetType, tap ? "tapped Auto-Move" : "no tap");
    this.busy = false;
  }

  private wait(until: number, then: () => void): void {
    this.controller.once("update", () => {
      if (Date.now() >= until) { then(); return; }
      this.wait(until, then);
    });
  }

  private sample(): MoveSample | null {
    try {
      const pc = this.sp.Game.getPlayer();
      if (!pc) return null;
      return {
        speed: Number(pc.getAnimationVariableFloat("SpeedSampled")) || 0,
        movementKeyHeld: this.anyMoveKeyHeld(),
        airborne: pc.getAnimationVariableBool("bInJumpState") === true,
      };
    } catch (e) {
      logTrace(this, `reading the player failed: ${e}`);
      return null;
    }
  }

  private anyMoveKeyHeld(): boolean {
    for (const control of MOVE_CONTROLS) {
      try {
        const code = this.sp.Input.getMappedKey(control, 0);
        if (code > 0 && this.sp.Input.isKeyPressed(code)) return true;
      } catch (e) { /* an unmapped control is not a held key */ }
    }
    return false;
  }

  private tap(): void {
    try {
      const code = this.sp.Input.getMappedKey("Auto-Move", 0);
      if (code > 0) this.sp.Input.tapKey(code);
      else logTrace(this, "Auto-Move is not mapped, nothing to tap");
    } catch (e) {
      logTrace(this, `tapping Auto-Move failed: ${e}`);
    }
  }

  // Every decision is logged, tap or not, so the in-game check can tell a working clear from one that never fired
  private report(widgetType: string, what: string): void {
    const seen = this.samples
      .map((s) => `[spd ${Math.round(s.speed)} key ${s.movementKeyHeld ? "Y" : "n"} air ${s.airborne ? "Y" : "n"}]`)
      .join(" ");
    const line = `autoMove ${widgetType}: ${what} (over ${MOVING_SPEED}, holding ${DECAY_RATIO}) ${seen}`;
    logTrace(this, line);
    try {
      (this.sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, line);
    } catch (e) {
      // An older SkyrimPlatform without writeLogs: the console still has it
    }
  }

  private busy = false;
  private samples: MoveSample[] = [];
}
