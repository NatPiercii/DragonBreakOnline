import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { readInputDiagRequest } from "./inputDiagRequest";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { ButtonEvent, DxScanCode, InputDeviceType, Menu } from "skyrimPlatform";

// Diagnostic for "can't walk after logging in until you alt-tab" (2026-09-27: the mouse looks and draws the weapon,
// the keyboard does nothing). For the first minutes after our own actor appears, reports what the engine sees to the
// server log (dbo npcDrift, kind "input") whenever it changes, and when movement keys are pressed but we do not move.
//   held: every key the engine counts as down (Input.getNthKeyPressed); a stuck key shows here
//   wasd: W A S D as the engine reads them; kb/mv: keyboard and movement button events since the last report
//   ctl: movement fighting camSwitch looking sneaking menu activate journal controls, 1 = enabled
// The server can open the same window again (dboInputDiag, inputDiagRequest.ts): downed.js does when a player falls,
// to see whether a movement key held at death stays "down" after the panel has had the keyboard. Each report carries
// the reason its window opened for.
const WINDOW_MS = 180000;
const POLL_MS = 500;
const HEARTBEAT_MS = 15000;
const STUCK_REPORT_MS = 2000;
const MAX_REPORTS = 80;
const MENUS: Menu[] = [Menu.Cursor, Menu.Loading, Menu.Fader, Menu.Main, Menu.Mist, Menu.Console, Menu.Tween,
  Menu.MessageBox, Menu.RaceSex, Menu.Dialogue, Menu.Journal, Menu.Inventory, Menu.Map, Menu.Top];
const WASD = [DxScanCode.W, DxScanCode.A, DxScanCode.S, DxScanCode.D];
const MOVE_EVENTS = ["Forward", "Back", "Strafe Left", "Strafe Right"];

export class InputDiagService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActor(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCreateActor(e: ConnectionMessage<CreateActorMessage>) {
    if (!e.message.isMe) return;
    this.open(WINDOW_MS, "login");
  }

  private onCustomPacketMessage(e: ConnectionMessage<CustomPacketMessage>) {
    const req = readInputDiagRequest(parseCustomPacket(e));
    if (req) this.open(req.ms, req.reason);
  }

  private open(ms: number, reason: string) {
    this.windowMs = ms;
    this.reason = reason;
    this.startedAt = Date.now();
    this.lastPoll = 0;
    this.lastSent = 0;
    this.lastStuck = 0;
    this.lastState = "";
    this.reports = 0;
    this.kb = 0;
    this.mv = 0;
    this.lastPos = null;
  }

  private onButtonEvent(e: ButtonEvent) {
    if (!this.startedAt || e.device !== InputDeviceType.Keyboard || !e.isDown) return;
    this.kb++;
    this.lastKey = e.code;
    if (MOVE_EVENTS.includes(e.userEventName)) this.mv++;
  }

  private onUpdate() {
    if (!this.startedAt) return;
    const now = Date.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    const t = now - this.startedAt;
    if (t > this.windowMs || this.reports >= MAX_REPORTS) {
      this.send({ t, end: true, reports: this.reports });
      this.startedAt = 0;
      return;
    }
    try {
      this.poll(now, t);
    } catch (err) {
      this.send({ t, error: String(err).slice(0, 200) });
      this.startedAt = 0;
    }
  }

  private poll(now: number, t: number) {
    const sp = this.sp;
    const player = sp.Game.getPlayer();
    if (!player) return;
    const held: number[] = [];
    const count = Math.min(sp.Input.getNumKeysPressed(), 16);
    for (let i = 0; i < count; i++) held.push(sp.Input.getNthKeyPressed(i));
    const flags = [sp.Game.isMovementControlsEnabled(), sp.Game.isFightingControlsEnabled(),
      sp.Game.isCamSwitchControlsEnabled(), sp.Game.isLookingControlsEnabled(), sp.Game.isSneakingControlsEnabled(),
      sp.Game.isMenuControlsEnabled(), sp.Game.isActivateControlsEnabled(), sp.Game.isJournalControlsEnabled()];
    const state = {
      bf: sp.browser.isFocused(),
      bv: sp.browser.isVisible(),
      mm: sp.Utility.isInMenuMode(),
      menus: MENUS.filter((m) => sp.Ui.isMenuOpen(m)),
      ctl: flags.map((f) => (f ? "1" : "0")).join(""),
      held,
      sit: player.getSitState(),
      cam: sp.Game.getCameraState(),
    };
    const x = player.getPositionX(), y = player.getPositionY();
    const moved = this.lastPos ? Math.round(Math.hypot(x - this.lastPos[0], y - this.lastPos[1])) : 0;
    const key = JSON.stringify(state);
    const changed = key !== this.lastState;
    const stuck = this.mv > 0 && moved < 5 && now - this.lastStuck >= STUCK_REPORT_MS;
    if (!changed && !stuck && now - this.lastSent < HEARTBEAT_MS) return;
    if (stuck) this.lastStuck = now;
    this.lastState = key;
    this.lastPos = [x, y];
    this.send({
      t, ...state, why: changed ? "changed" : stuck ? "stuck" : "heartbeat",
      wasd: WASD.map((k) => (sp.Input.isKeyPressed(k) ? "1" : "0")).join(""),
      kb: this.kb, mv: this.mv, lastKey: this.lastKey, moved,
      spd: Math.round(player.getActorValue("SpeedMult")), enc: player.isOverEncumbered(), drawn: player.isWeaponDrawn(),
    });
    this.kb = 0;
    this.mv = 0;
  }

  private send(report: Record<string, unknown>) {
    this.reports++;
    this.lastSent = Date.now();
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "npcDrift", args: [{ kind: "input", reason: this.reason, ...report }] });
  }

  private startedAt = 0;
  private windowMs = WINDOW_MS;
  private reason = "login";
  private lastPoll = 0;
  private lastSent = 0;
  private lastStuck = 0;
  private lastState = "";
  private reports = 0;
  private kb = 0;
  private mv = 0;
  private lastKey = 0;
  private lastPos: [number, number] | null = null;
}
