import { Actor, Debug, Form, Game, Input, ObjectReference, Utility } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent } from "skyrimPlatform";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { WorldCleanerService } from "./worldCleanerService";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { noteCopyPlaced, safeDelete } from "../../view/npcLifetimeRuntime";
import { logError, logTrace } from "../../logging";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

/**
 * The F7 Place tab's placement mode. A local copy of the chosen NPC or object floats in front of the GM; keys move it,
 * and Enter asks the server (placement.js) to place the real one. The copy exists on this machine only and is deleted
 * on exit. Three modes:
 *   place   a catalog pick: each Enter places one
 *   edit    a placement chosen in the tab or with the select tool: the copy starts where it stands, Enter moves it there
 *   select  no copy: Enter on something placed edits it, Delete removes it
 * In every mode End takes back the GM's last place, move or remove (server side, per GM) and Backspace stops.
 *
 * The mode switches to first person and back on exit: SkyrimPlatform has no camera position, and in first person the
 * player's heading and pitch are the camera's, so "ahead" is where the GM looks. With aim on (Home), the copy sits where
 * the look ray meets the floor at the GM's feet level (a flat floor; there is no raycast to find the real ground).
 *
 * Enter is also a chat key; BrowserService leaves it alone while isActive(), or the chat took the keyboard from the game
 * and no placement was ever sent (2026-09-28). While the chat is open anyway (T, F6) the mode waits. A readout at the
 * bottom of the screen shows the mode, the pose and the keys.
 *
 *   Browser -> here:  admin::place <JSON {desc, kind, name, hostile}>, admin::placeedit <JSON {id, base, kind, name,
 *                     hostile, pos, rot}>, admin::placeselect (and the older admin::placedelete) for the select tool
 *   Server -> here:   placeEdit {id, base, name, kind, hostile, pos, rot}, the answer to placeSelect
 *   Client -> Server: dbo placeObject [desc, kind, [x,y,z], rotZ, hostile, [pitch, roll]], dbo placeMove [id, pos, rot],
 *                     dbo placeSelect [remoteIdHex], dbo placeDelete [remoteIdHex], dbo placeUndo []
 */
const KEY = {
  left: 0xcb, right: 0xcd, up: 0xc8, down: 0xd0, pageUp: 0xc9, pageDown: 0xd1, enter: 0x1c, numEnter: 0x9c, back: 0x0e,
  del: 0xd3, home: 0xc7, end: 0xcf, lBracket: 0x1a, rBracket: 0x1b, lShift: 0x2a, rShift: 0x36,
};
const TICK_MS = 40;
const DISTANCE = { start: 300, min: 64, max: 2000 };
// Per 40 ms tick at step 1: 12 units nearer/further, 4 units up/down, 4 degrees of turn, pitch or roll
const BASE = { move: 12, height: 4, angle: 4 };
const STEPS = [0.25, 1, 4];
const STEP_NAMES = ["fine", "normal", "coarse"];
const UNITS_PER_METRE = 70;
const FLASH_MS = 2000;
// First-person eye height above the feet, for aim; the look ray meets the feet's level this far ahead
const EYE_HEIGHT = 120;
// Aim needs the view this far below level; flatter than that, the copy stays at its distance
const AIM_MIN_PITCH = 3;
// Game.getCameraState(): 0 is first person, as SkyMP's own sweetCameraEnforcementService ("1-st person") and this
// client's fovService and lipSyncService use it. Only used to put the view back afterwards.
const FIRST_PERSON = 0;
// Player.getAngleX() grows when looking down: NOT verified. Neither the typings nor the SkyMP source say, and the CK
// wiki could not be reached (2026-09-28). Aim stays off until Home turns it on, and with aim on the readout shows the
// raw pitch, so the first look at the floor in game settles the sign; flip this if looking down reads negative.
const PITCH_DOWN_SIGN = 1;

// A plain overlay beside the front's own widgets: the F7 panel is closed while placing, and this needs no front build.
// null removes it. The text goes in as textContent, never as markup.
const hudScript = (text: string | null): string =>
  `(function(t){var d=document.getElementById('dbo-place-hud');if(t===null){if(d)d.remove();return;}` +
  `if(!d){d=document.createElement('div');d.id='dbo-place-hud';d.style.cssText='position:fixed;left:50%;bottom:13%;` +
  `transform:translateX(-50%);z-index:2147483000;pointer-events:none;padding:10px 18px;border-radius:4px;` +
  `background:rgba(10,9,7,0.8);border:1px solid rgba(232,214,160,0.55);color:#e8d6a0;` +
  `font:15px/1.5 "Futura Condensed","Roboto Condensed",sans-serif;text-align:center;white-space:pre;` +
  `text-shadow:0 1px 2px #000';document.body.appendChild(d);}d.textContent=t;})(${JSON.stringify(text)})`;

const norm = (deg: number): number => ((deg % 360) + 360) % 360;
// Below these the preview is left where it is (units, degrees)
const GHOST_MOVE_EPS = 2;
const GHOST_TURN_EPS = 0.5;

// -180..180, for showing a tilt
const signed = (deg: number): number => { const d = norm(deg); return d > 180 ? d - 360 : d; };

interface Pick { desc: string; kind: "npc" | "object"; name: string; hostile: boolean }
interface EditTarget { id: string; pos: number[]; rot: number[] }

export class PlacementService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  isActive(): boolean {
    return this.active;
  }

  // Browser messages arrive in tick context, where every Papyrus native throws: start() (Game.getCameraState,
  // forceFirstPerson, getFormFromFile, Debug.notification) runs on the next frame, the JSON is read here
  private onBrowserMessage(e: BrowserMessageEvent): void {
    const kind = e.arguments[0];
    let begin: (() => void) | null = null;
    if (kind === "admin::place") {
      const raw = this.parse(e.arguments[1]);
      if (raw && raw.desc) {
        const pick: Pick = { desc: String(raw.desc), kind: raw.kind === "npc" ? "npc" : "object", name: String(raw.name || "it"), hostile: raw.hostile === true };
        begin = () => this.start(pick, null);
      }
    } else if (kind === "admin::placeedit") {
      const raw = this.parse(e.arguments[1]);
      if (raw) begin = () => this.startEdit(raw);
    } else if (kind === "admin::placeselect" || kind === "admin::placedelete") {
      begin = () => this.start(null, null);
    }
    if (!begin) return;
    const run = begin;
    this.controller.once("update", () => {
      try {
        run();
      } catch (err) {
        logError(this, `placement mode did not start: ${err}`);
      }
    });
  }

  // Natives throw in the packet-handler context: the edit is kept and started by the next update
  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content && content["customPacketType"] === "placeEdit") this.pendingEdit = content;
  }

  private parse(arg: unknown): Record<string, any> | null {
    try {
      const raw = JSON.parse(String(arg ?? "{}"));
      return raw && typeof raw === "object" ? raw : null;
    } catch {
      return null;
    }
  }

  private startEdit(raw: Record<string, any>): void {
    const pos = Array.isArray(raw.pos) ? raw.pos.map(Number) : [];
    const rot = Array.isArray(raw.rot) ? raw.rot.map(Number) : [0, 0, 0];
    if (!raw.id || !raw.base || pos.length !== 3 || pos.some((n: number) => !Number.isFinite(n))) return;
    this.start({ desc: String(raw.base), kind: raw.kind === "npc" ? "npc" : "object", name: String(raw.name || "it"), hostile: raw.hostile === true },
      { id: String(raw.id), pos, rot: [0, 1, 2].map((i) => Number(rot[i]) || 0) });
  }

  private start(pick: Pick | null, edit: EditTarget | null): void {
    const wasActive = this.active;
    this.stop(false, true);
    if (!wasActive) {
      // First person while placing, so "ahead" is where the GM looks; the view is put back on exit
      this.restoreThirdPerson = Game.getCameraState() !== FIRST_PERSON;
      if (this.restoreThirdPerson) Game.forceFirstPerson();
    }
    this.active = true;
    this.pick = pick;
    this.edit = edit;
    // The id, not the Form: a native object is only valid in the frame it came from, and the Form kept here made
    // placeAtMe throw on every later frame, so no preview ever appeared (playtest 2026-09-25)
    const form = pick ? this.formOf(pick.desc) : null;
    this.formId = form ? form.getFormID() : 0;
    if (pick && !this.formId) {
      Debug.notification(`${pick.name} is not in your load order.`);
      this.stop(true);
      return;
    }
    this.distance = DISTANCE.start;
    this.height = 0;
    this.turn = 0;
    this.pitch = 0;
    this.roll = 0;
    this.held.clear();
    if (edit) this.startEditPose(edit);
    const what = !pick ? "select tool" : edit ? `editing ${pick.name}` : `placing ${pick.name}`;
    Debug.notification(`${what[0].toUpperCase()}${what.slice(1)}. The keys are on screen; Backspace stops.`);
    logTrace(this, "placement mode on:", pick ? `${edit ? "edit " + edit.id : "place"} ${pick.kind} ${pick.desc} (${pick.name})${pick.hostile ? " hostile" : ""}` : "select tool");
  }

  // The copy starts where the placement stands: its distance, height and heading become the offsets from the GM
  private startEditPose(edit: EditTarget): void {
    const player = Game.getPlayer();
    if (!player) return;
    const dx = edit.pos[0] - player.getPositionX();
    const dy = edit.pos[1] - player.getPositionY();
    this.distance = Math.max(DISTANCE.min, Math.min(DISTANCE.max, Math.hypot(dx, dy)));
    this.height = edit.pos[2] - player.getPositionZ();
    this.turn = norm(edit.rot[2] - (player.getAngleZ() + 180));
    this.pitch = edit.rot[0];
    this.roll = edit.rot[1];
  }

  // keepView: switching from one mode to another, the camera stays as it is
  private stop(announce: boolean, keepView = false): void {
    if (this.ghostId) {
      const id = this.ghostId;
      this.ghostId = 0;
      this.ghostAt = null;
      this.controller.lookupListener(WorldCleanerService).modWcProtection(id, -1);
      const ghost = ObjectReference.from(Game.getFormEx(id));
      if (ghost) safeDelete(ghost);
    }
    if (announce && this.active) Debug.notification("Placement mode off.");
    if (this.hudText !== null) {
      this.hudText = null;
      this.sp.browser.executeJavaScript(hudScript(null));
    }
    if (this.active && !keepView && this.restoreThirdPerson) {
      this.restoreThirdPerson = false;
      Game.forceThirdPerson();
    }
    this.active = false;
    this.pick = null;
    this.edit = null;
    this.formId = 0;
  }

  // "hex:Plugin.esm" as the catalog writes it
  private formOf(desc: string): Form | null {
    const at = desc.indexOf(":");
    if (at <= 0) return null;
    return Game.getFormFromFile(parseInt(desc.slice(0, at), 16), desc.slice(at + 1));
  }

  private onUpdate(): void {
    if (this.pendingEdit) {
      const raw = this.pendingEdit;
      this.pendingEdit = null;
      this.startEdit(raw);
    }
    if (!this.active) return;
    const now = Date.now();
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    const player = Game.getPlayer();
    // The chat (T, F6) or any menu has the keyboard: wait. The one-shot keys count as held until let go, or the Enter
    // that sends a chat line would place something the moment the game has the keyboard back
    if (!player || Utility.isInMenuMode() || this.sp.browser.isFocused()) {
      for (const key of [KEY.enter, KEY.numEnter, KEY.del, KEY.back, KEY.home, KEY.end, KEY.lBracket, KEY.rBracket]) this.held.add(key);
      return;
    }

    if (this.pressed(KEY.back)) return this.stop(true);
    if (this.pressed(KEY.del)) this.deleteAimed();
    if (this.pressed(KEY.end)) this.send("placeUndo", [], "Undoing...");
    if (this.pressed(KEY.lBracket)) this.step = Math.max(0, this.step - 1);
    if (this.pressed(KEY.rBracket)) this.step = Math.min(STEPS.length - 1, this.step + 1);
    if (this.pressed(KEY.home)) this.aim = !this.aim;
    const k = STEPS[this.step];
    const shift = Input.isKeyPressed(KEY.lShift) || Input.isKeyPressed(KEY.rShift);
    const tilts = !!this.pick && this.pick.kind === "object";
    if (shift && tilts) {
      // Shift: the arrows tilt an object (roll left-right, pitch forward-back)
      if (Input.isKeyPressed(KEY.left)) this.roll -= BASE.angle * k;
      if (Input.isKeyPressed(KEY.right)) this.roll += BASE.angle * k;
      if (Input.isKeyPressed(KEY.up)) this.pitch -= BASE.angle * k;
      if (Input.isKeyPressed(KEY.down)) this.pitch += BASE.angle * k;
    } else {
      if (Input.isKeyPressed(KEY.left)) this.turn -= BASE.angle * k;
      if (Input.isKeyPressed(KEY.right)) this.turn += BASE.angle * k;
      if (Input.isKeyPressed(KEY.up)) this.distance = Math.min(DISTANCE.max, this.distance + BASE.move * k);
      if (Input.isKeyPressed(KEY.down)) this.distance = Math.max(DISTANCE.min, this.distance - BASE.move * k);
    }
    if (Input.isKeyPressed(KEY.pageUp)) this.height += BASE.height * k;
    if (Input.isKeyPressed(KEY.pageDown)) this.height -= BASE.height * k;

    if (!this.pick || !this.formId) {
      if (this.pressed(KEY.enter) || this.pressed(KEY.numEnter)) this.selectAimed();
      this.showHud(null);
      return;
    }

    // Skyrim's heading: 0 is north (+Y), growing clockwise; the copy faces back toward the GM
    const yaw = player.getAngleZ();
    const rad = (yaw / 180) * Math.PI;
    const ahead = this.aimDistance(player);
    const pos = [
      player.getPositionX() + Math.sin(rad) * ahead,
      player.getPositionY() + Math.cos(rad) * ahead,
      player.getPositionZ() + this.height,
    ];
    const rotZ = norm(yaw + 180 + this.turn);
    const rot = tilts ? [norm(this.pitch), norm(this.roll), rotZ] : [0, 0, rotZ];
    this.showGhost(player, pos, rot);
    if (this.pressed(KEY.enter) || this.pressed(KEY.numEnter)) {
      if (this.edit) {
        this.send("placeMove", [this.edit.id, pos, rot], `Moving ${this.pick.name}...`);
        // Done with this one: back to the select tool for the next
        this.start(null, null);
        return;
      }
      this.send("placeObject", [this.pick.desc, this.pick.kind, pos, rotZ, this.pick.hostile, [rot[0], rot[1]]], `Placing ${this.pick.name}...`);
    }
    this.showHud(ahead);
  }

  // With aim on and the view below level: where the look ray meets the feet's level; otherwise the set distance
  private aimDistance(player: Actor): number {
    if (!this.aim) return this.distance;
    this.rawPitch = player.getAngleX();
    const pitch = this.rawPitch * PITCH_DOWN_SIGN;
    if (pitch < AIM_MIN_PITCH) return this.distance;
    const d = EYE_HEIGHT / Math.tan((pitch / 180) * Math.PI);
    return Math.max(DISTANCE.min, Math.min(DISTANCE.max, d));
  }

  private send(event: string, args: unknown[], flash: string): void {
    sendCustomPacket(this.controller, { customPacketType: "dbo", event, args });
    logTrace(this, `${event} sent:`, JSON.stringify(args));
    this.flash(flash);
  }

  private flash(text: string): void {
    this.flashText = text;
    this.flashUntil = Date.now() + FLASH_MS;
  }

  // Only re-sent to the browser when the text changes
  private showHud(ahead: number | null): void {
    const m = (units: number) => (units / UNITS_PER_METRE).toFixed(1);
    const lines: string[] = [];
    const step = `step ${STEP_NAMES[this.step]} ([ ])`;
    if (this.pick) {
      const who = this.pick.kind === "npc" ? (this.pick.hostile ? "  (hostile)" : "  (friendly)") : "";
      lines.push(`${this.edit ? "EDITING" : "PLACING"}  ${this.pick.name}${who}`);
      const tilt = this.pick.kind === "object" ? `   pitch ${Math.round(signed(this.pitch))}° roll ${Math.round(signed(this.roll))}°` : "";
      lines.push(`${m(ahead ?? this.distance)} m ahead${this.aim ? ` (aim, look pitch ${Math.round(this.rawPitch)}\u00b0)` : ""}   height ${this.height >= 0 ? "+" : ""}${m(this.height)} m   turned ${Math.round(norm(this.turn))}°${tilt}`);
      lines.push(`← → turn   ↑ ↓ nearer / further${this.pick.kind === "object" ? "   Shift+arrows tilt" : ""}   PgUp PgDn height   Home aim ${this.aim ? "off" : "on"}   ${step}`);
      lines.push(`Enter ${this.edit ? "move it here" : "place"}   Delete remove aimed   End undo   Backspace stop`);
    } else {
      lines.push("SELECT TOOL  aim at something you placed");
      lines.push("Enter edit it   Delete remove it   End undo   Backspace stop");
    }
    if (Date.now() < this.flashUntil) lines.push(this.flashText);
    const text = lines.join("\n");
    if (text === this.hudText) return;
    this.hudText = text;
    this.sp.browser.executeJavaScript(hudScript(text));
  }

  private showGhost(player: Actor, pos: number[], rot: number[]): void {
    let ghost = this.ghostId ? ObjectReference.from(Game.getFormEx(this.ghostId)) : null;
    if (!ghost) {
      ghost = player.placeAtMe(Game.getFormEx(this.formId), 1, false, false);
      if (!ghost) {
        logError(this, "placeAtMe returned null for", this.pick?.desc);
        return this.stop(true);
      }
      this.ghostId = ghost.getFormID();
      this.ghostAt = null;
      noteCopyPlaced(this.ghostId);
      this.controller.lookupListener(WorldCleanerService).modWcProtection(this.ghostId, 1);
      const ac = Actor.from(ghost);
      if (ac) {
        ac.enableAI(false);
        ac.setDontMove(true);
        ac.setAlpha(0.45, false);
      }
    }
    // Moved only when the aim really changed: re-placing it every tick kept the copy faint (Nate, 5 Oct)
    const last = this.ghostAt;
    if (last && pos.every((v, i) => Math.abs(v - last[i]) < GHOST_MOVE_EPS) && rot.every((v, i) => Math.abs(v - last[3 + i]) < GHOST_TURN_EPS)) return;
    this.ghostAt = [...pos, ...rot];
    ghost.setPosition(pos[0], pos[1], pos[2]);
    ghost.setAngle(rot[0], rot[1], rot[2]);
  }

  // The remote id of the reference under the crosshair, or null with the reason shown
  private aimedRemote(): number | null {
    const ref = Game.getCurrentCrosshairRef();
    if (!ref || ref.getFormID() === this.ghostId) {
      Debug.notification("Aim at something you placed first.");
      return null;
    }
    const remote = localIdToRemoteId(ref.getFormID());
    if (!remote) {
      Debug.notification("That is not a server object.");
      return null;
    }
    return remote;
  }

  private deleteAimed(): void {
    const remote = this.aimedRemote();
    if (remote) this.send("placeDelete", [remote.toString(16)], "Removing...");
  }

  // The server answers with placeEdit when it is a placement this GM may change
  private selectAimed(): void {
    const remote = this.aimedRemote();
    if (remote) this.send("placeSelect", [remote.toString(16)], "Selecting...");
  }

  // True once per key press, not while it is held
  private pressed(key: number): boolean {
    const down = Input.isKeyPressed(key);
    const was = this.held.has(key);
    if (down) this.held.add(key); else this.held.delete(key);
    return down && !was;
  }

  private active = false;
  private pick: Pick | null = null;
  private edit: EditTarget | null = null;
  private pendingEdit: Record<string, any> | null = null;
  private formId = 0;
  private ghostId = 0;
  private ghostAt: number[] | null = null;
  private distance = DISTANCE.start;
  private height = 0;
  private turn = 0;
  private pitch = 0;
  private roll = 0;
  private step = 1;
  private aim = false;
  // The last getAngleX() read for aim, shown on the readout (its sign is not verified yet)
  private rawPitch = 0;
  private restoreThirdPerson = false;
  private lastTick = 0;
  private held = new Set<number>();
  private hudText: string | null = null;
  private flashText = "";
  private flashUntil = 0;
}
