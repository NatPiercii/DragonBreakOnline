import { Actor, Debug, Form, Game, Input, ObjectReference, Utility } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent } from "skyrimPlatform";
import { sendCustomPacket } from "./customPacketUtil";
import { WorldCleanerService } from "./worldCleanerService";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logError, logTrace } from "../../logging";

/**
 * The F7 Place tab's placement mode. A local copy of the chosen NPC or object floats in front of the GM, following
 * where they face; keys move it, each Enter asks the server to place the real one (server placement.js), and Delete
 * removes a placed thing under the crosshair. The copy exists on this machine only and is deleted on exit.
 *
 * Enter is also a chat key; BrowserService leaves it alone while isActive(), or the chat took the keyboard from the game
 * and no placement was ever sent (2026-09-28). While the chat is open anyway (T, F6) the mode waits. A readout at the
 * bottom of the screen shows what is being placed, where, and the keys, for as long as the mode is on.
 *
 *   Browser -> here:  admin::place <JSON {desc, kind, name, hostile}>,  admin::placedelete (delete tool, no preview)
 *   Client -> Server: dbo placeObject [desc, kind, [x,y,z], rotZ, hostile],  dbo placeDelete [remoteIdHex]
 */
const KEY = { left: 0xcb, right: 0xcd, up: 0xc8, down: 0xd0, pageUp: 0xc9, pageDown: 0xd1, enter: 0x1c, numEnter: 0x9c, back: 0x0e, del: 0xd3 };
const TICK_MS = 40;
const DISTANCE = { start: 300, min: 64, max: 2000, step: 12 };
const ROTATE_STEP = 4;
const HEIGHT_STEP = 4;
const HELP = "Arrows: turn / nearer-further. PgUp/PgDn: height. Enter: place. Delete: remove aimed. Backspace: stop.";
const KEYS_LINE = "\u2190 \u2192 turn   \u2191 \u2193 nearer / further   PgUp PgDn height   Enter place   Delete remove aimed   Backspace stop";
const UNITS_PER_METRE = 70;
const FLASH_MS = 2000;

// A plain overlay beside the front's own widgets: the F7 panel is closed while placing, and this needs no front build.
// null removes it. The text goes in as textContent, never as markup.
const hudScript = (text: string | null): string =>
  `(function(t){var d=document.getElementById('dbo-place-hud');if(t===null){if(d)d.remove();return;}` +
  `if(!d){d=document.createElement('div');d.id='dbo-place-hud';d.style.cssText='position:fixed;left:50%;bottom:13%;` +
  `transform:translateX(-50%);z-index:2147483000;pointer-events:none;padding:10px 18px;border-radius:4px;` +
  `background:rgba(10,9,7,0.8);border:1px solid rgba(232,214,160,0.55);color:#e8d6a0;` +
  `font:15px/1.5 "Futura Condensed","Roboto Condensed",sans-serif;text-align:center;white-space:pre;` +
  `text-shadow:0 1px 2px #000';document.body.appendChild(d);}d.textContent=t;})(${JSON.stringify(text)})`;

interface Pick { desc: string; kind: "npc" | "object"; name: string; hostile: boolean }

export class PlacementService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const kind = e.arguments[0];
    if (kind === "admin::place") {
      let pick: Pick | null = null;
      try {
        const raw = JSON.parse(String(e.arguments[1] ?? "{}"));
        pick = { desc: String(raw.desc || ""), kind: raw.kind === "npc" ? "npc" : "object", name: String(raw.name || "it"), hostile: raw.hostile === true };
      } catch { pick = null; }
      if (pick && pick.desc) this.start(pick);
    } else if (kind === "admin::placedelete") {
      this.start(null);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  private start(pick: Pick | null): void {
    this.stop(false);
    this.active = true;
    this.pick = pick;
    // The id, not the Form: a native object is only valid in the frame it came from, and the Form kept here made
    // placeAtMe throw on every later frame, so no preview ever appeared (playtest 2026-09-25)
    const form = pick ? this.formOf(pick.desc) : null;
    this.formId = form ? form.getFormID() : 0;
    if (pick && !this.formId) {
      Debug.notification(`${pick.name} is not in your load order.`);
      this.active = false;
      return;
    }
    this.distance = DISTANCE.start;
    this.height = 0;
    this.turn = 0;
    this.held.clear();
    Debug.notification(pick ? `Placing ${pick.name}. ${HELP}` : "Delete tool: aim at something you placed and press Delete. Backspace: stop.");
    logTrace(this, "placement mode on:", pick ? `${pick.kind} ${pick.desc} (${pick.name})${pick.hostile ? " hostile" : ""}` : "delete tool");
  }

  private stop(announce: boolean): void {
    if (this.ghostId) {
      const id = this.ghostId;
      this.ghostId = 0;
      this.controller.lookupListener(WorldCleanerService).modWcProtection(id, -1);
      ObjectReference.from(Game.getFormEx(id))?.delete();
    }
    if (announce && this.active) Debug.notification("Placement mode off.");
    if (this.hudText !== null) {
      this.hudText = null;
      this.sp.browser.executeJavaScript(hudScript(null));
    }
    this.active = false;
    this.pick = null;
    this.formId = 0;
  }

  // "hex:Plugin.esm" as the catalog writes it
  private formOf(desc: string): Form | null {
    const at = desc.indexOf(":");
    if (at <= 0) return null;
    return Game.getFormFromFile(parseInt(desc.slice(0, at), 16), desc.slice(at + 1));
  }

  private onUpdate(): void {
    if (!this.active) return;
    const now = Date.now();
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    const player = Game.getPlayer();
    // The chat (T, F6) or any menu has the keyboard: wait. The one-shot keys count as held until let go, or the Enter
    // that sends a chat line would place something the moment the game has the keyboard back
    if (!player || Utility.isInMenuMode() || this.sp.browser.isFocused()) {
      for (const key of [KEY.enter, KEY.numEnter, KEY.del, KEY.back]) this.held.add(key);
      return;
    }

    if (this.pressed(KEY.back)) return this.stop(true);
    if (this.pressed(KEY.del)) this.deleteAimed();
    if (Input.isKeyPressed(KEY.left)) this.turn -= ROTATE_STEP;
    if (Input.isKeyPressed(KEY.right)) this.turn += ROTATE_STEP;
    if (Input.isKeyPressed(KEY.up)) this.distance = Math.min(DISTANCE.max, this.distance + DISTANCE.step);
    if (Input.isKeyPressed(KEY.down)) this.distance = Math.max(DISTANCE.min, this.distance - DISTANCE.step);
    if (Input.isKeyPressed(KEY.pageUp)) this.height += HEIGHT_STEP;
    if (Input.isKeyPressed(KEY.pageDown)) this.height -= HEIGHT_STEP;
    if (!this.pick || !this.formId) {
      this.showHud();
      return;
    }

    // Skyrim's heading: 0 is north (+Y), growing clockwise; the copy faces back toward the GM
    const yaw = player.getAngleZ();
    const rad = (yaw / 180) * Math.PI;
    const pos = [
      player.getPositionX() + Math.sin(rad) * this.distance,
      player.getPositionY() + Math.cos(rad) * this.distance,
      player.getPositionZ() + this.height,
    ];
    const rotZ = (((yaw + 180 + this.turn) % 360) + 360) % 360;
    this.showGhost(player, pos, rotZ);
    if (this.pressed(KEY.enter) || this.pressed(KEY.numEnter)) {
      sendCustomPacket(this.controller, { customPacketType: "dbo", event: "placeObject", args: [this.pick.desc, this.pick.kind, pos, rotZ, this.pick.hostile] });
      logTrace(this, "placeObject sent:", this.pick.desc, this.pick.kind, pos.map((n) => Math.round(n)).join(","), Math.round(rotZ));
      this.flash(`Placing ${this.pick.name}...`);
    }
    this.showHud();
  }

  private flash(text: string): void {
    this.flashText = text;
    this.flashUntil = Date.now() + FLASH_MS;
  }

  // Only re-sent to the browser when the text changes
  private showHud(): void {
    const lines: string[] = [];
    if (this.pick) {
      lines.push(`PLACING  ${this.pick.name}${this.pick.kind === "npc" ? (this.pick.hostile ? "  (hostile)" : "  (friendly)") : ""}`);
      const m = (units: number) => (units / UNITS_PER_METRE).toFixed(1);
      lines.push(`${m(this.distance)} m ahead   height ${this.height >= 0 ? "+" : ""}${m(this.height)} m   turned ${((this.turn % 360) + 360) % 360}\u00b0`);
      lines.push(KEYS_LINE);
    } else {
      lines.push("DELETE TOOL  aim at something you placed");
      lines.push("Delete remove aimed   Backspace stop");
    }
    if (Date.now() < this.flashUntil) lines.push(this.flashText);
    const text = lines.join("\n");
    if (text === this.hudText) return;
    this.hudText = text;
    this.sp.browser.executeJavaScript(hudScript(text));
  }

  private showGhost(player: Actor, pos: number[], rotZ: number): void {
    let ghost = this.ghostId ? ObjectReference.from(Game.getFormEx(this.ghostId)) : null;
    if (!ghost) {
      ghost = player.placeAtMe(Game.getFormEx(this.formId), 1, false, false);
      if (!ghost) {
        logError(this, "placeAtMe returned null for", this.pick?.desc);
        return this.stop(true);
      }
      this.ghostId = ghost.getFormID();
      this.controller.lookupListener(WorldCleanerService).modWcProtection(this.ghostId, 1);
      const ac = Actor.from(ghost);
      if (ac) {
        ac.enableAI(false);
        ac.setDontMove(true);
        ac.setAlpha(0.45, false);
      }
    }
    ghost.setPosition(pos[0], pos[1], pos[2]);
    ghost.setAngle(0, 0, rotZ);
  }

  private deleteAimed(): void {
    const ref = Game.getCurrentCrosshairRef();
    if (!ref || ref.getFormID() === this.ghostId) {
      Debug.notification("Aim at something you placed first.");
      return;
    }
    const remote = localIdToRemoteId(ref.getFormID());
    if (!remote) {
      Debug.notification("That is not a server object.");
      return;
    }
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "placeDelete", args: [remote.toString(16)] });
    logTrace(this, "placeDelete sent:", remote.toString(16));
    this.flash("Removing...");
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
  private formId = 0;
  private ghostId = 0;
  private distance = DISTANCE.start;
  private height = 0;
  private turn = 0;
  private lastTick = 0;
  private held = new Set<number>();
  private hudText: string | null = null;
  private flashText = "";
  private flashUntil = 0;
}
