import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, closeWidget, refreshFormMenu } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { TimersService } from "./timersService";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";

const HUD_WIDGET_ID = 29;
const PARTY_WIDGET_ID = 32;
const PASSIVE_TICK_MS = 1000;
const FADE_SAFETY_MS = 25000;
// The vanilla meters fade themselves back in with timeline animations that rewrite _alpha, so they are
// also scaled to nothing and parked below the screen; the animations never touch scale or position.
const VANILLA_METERS = ["Health", "Magica", "Stamina"];
const VANILLA_METER_HIDE: Array<[string, number]> = [["_alpha", 0], ["_xscale", 0], ["_yscale", 0], ["_y", 5000]];

// for the browser-side widget setter (executed inside the CEF browser); `widget` and `id`
// are the names injected by FunctionInfo.getText, declared here for the type checker only.
declare const window: any;
declare const widget: any;
declare const id: number;

/**
 * Generic bridge between the server gamemode and the CEF front, so a new menu
 * or mini-game needs only a front widget and gamemode.js code, no client build.
 *
 *   Server -> Client: { customPacketType: "dboWidget", widget: {type, id, ...}, focus?: boolean }
 *                     opens (or refreshes) that widget; focus true grabs the mouse like a menu.
 *   Server -> Client: { customPacketType: "dboWidget", close: <id> }   removes it.
 *   Server -> Client: { customPacketType: "dboNotice", text }          on-screen notification.
 *   Browser -> Server: window.skyrimPlatform.sendMessage("dbo:<event>", ...args) is forwarded as
 *                     { customPacketType: "dbo", event: "<event>", args: [...], widget: <open id> }.
 *
 * Escape (in game or inside the browser) closes the focused widget and tells the server.
 */
export class DboRelayService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("browserWindowLoaded", () => { this.focusedId = 0; this.hudKey = ""; this.partyKey = ""; });
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.focusedId) this.closeFocused("hidden"); });
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("loadGame", () => this.onGameLoaded());
  }

  // Passive widgets the server feeds with data packets; the client adds what only it can read
  // (the player's vitals, party members' health from their loaded actors) once a second.
  //   { customPacketType: "dboHud", hunger, stage, hungerOn, vitalsOn, watermarkOn }
  //   { customPacketType: "dboParty", members: [{ id, name, leader }], self }
  private onUpdate(): void {
    this.hideVanillaMeters();
    const now = Date.now();
    if (now < this.nextPassive) return;
    this.nextPassive = now + PASSIVE_TICK_MS;
    try { this.pushHud(); } catch { /* keep the tick alive */ }
    try { this.pushParty(); } catch { /* keep the tick alive */ }
  }

  // The engine fades the vanilla meters back in on sprint, damage and casting; alpha is the member it leaves alone.
  private hideVanillaMeters(): void {
    if (!this.hudData || this.hudData["vitalsOn"] === false) return;
    for (const meter of VANILLA_METERS) {
      for (const [member, value] of VANILLA_METER_HIDE) {
        try { this.sp.Ui.setFloat("HUD Menu", `_root.HUDMovieBaseInstance.${meter}.${member}`, value); } catch { /* HUD not ready */ }
      }
    }
  }

  private pushHud(): void {
    if (!this.hudData) return;
    const p = this.sp.Game.getPlayer();
    const pct = (av: string): number => { try { return p ? Math.round(p.getActorValuePercentage(av) * 100) : 100; } catch { return 100; } };
    const w = {
      type: "hud", id: HUD_WIDGET_ID,
      hunger: Number(this.hudData["hunger"]) || 0, stage: String(this.hudData["stage"] || ""), hungerOn: this.hudData["hungerOn"] !== false,
      health: pct("Health"), magicka: pct("Magicka"), stamina: pct("Stamina"), vitalsOn: this.hudData["vitalsOn"] !== false,
      watermarkOn: this.hudData["watermarkOn"] !== false,
    };
    const key = JSON.stringify(w);
    if (key === this.hudKey && now() - this.hudSentAt < 5000) return;
    this.hudKey = key; this.hudSentAt = now();
    this.setWidget(HUD_WIDGET_ID, key);
  }

  private pushParty(): void {
    if (!this.partyData) { if (this.partyKey) { this.partyKey = ""; this.removeWidget(PARTY_WIDGET_ID); } return; }
    const members = Array.isArray(this.partyData["members"]) ? this.partyData["members"] as Array<Record<string, unknown>> : [];
    if (!members.length) { if (this.partyKey) { this.partyKey = ""; this.removeWidget(PARTY_WIDGET_ID); } return; }
    const rows = members.map((m) => {
      const row: Record<string, unknown> = { id: Number(m["id"]) || 0, name: String(m["name"] || "?"), leader: !!m["leader"], far: true };
      try {
        const a = Actor.from(this.sp.Game.getFormEx(Number(m["id"]) || 0));
        if (a && a.is3DLoaded()) { row["far"] = false; row["dead"] = a.isDead(); row["health"] = Math.round(a.getActorValuePercentage("Health") * 100); }
      } catch { /* not loaded */ }
      return row;
    });
    const w = { type: "party", id: PARTY_WIDGET_ID, members: rows, self: Number(this.partyData["self"]) || 0 };
    const key = JSON.stringify(w);
    if (key === this.partyKey && now() - this.partySentAt < 5000) return;
    this.partyKey = key; this.partySentAt = now();
    this.setWidget(PARTY_WIDGET_ID, key);
  }

  private setWidget(id: number, widgetJson: string): void {
    this.sp.browser.executeJavaScript(
      "(function(){if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(x){return x.id!==" + id + ";});ws.push(" + widgetJson + ");window.skyrimPlatform.widgets.set(ws);})();"
    );
  }

  private removeWidget(id: number): void {
    this.sp.browser.executeJavaScript(
      "(function(){if(!window.skyrimPlatform||!window.skyrimPlatform.widgets)return;window.skyrimPlatform.widgets.set((window.skyrimPlatform.widgets.get()||[]).filter(function(x){return x.id!==" + id + ";}));})();"
    );
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.device !== InputDeviceType.Keyboard) return;
    if (e.code === DxScanCode.Escape && e.isDown && this.focusedId) this.closeFocused("escape");
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    const type = content["customPacketType"];
    if (type === "dboHud") { this.hudData = content; this.hudKey = ""; this.nextPassive = 0; return; }
    if (type === "dboParty") { this.partyData = content; this.partyKey = ""; this.nextPassive = 0; return; }
    if (type === "dboNotice") {
      if (typeof content["text"] === "string") notifyNextUpdate(this.controller, this.sp, content["text"]);
      return;
    }
    if (type === "dboFade") { this.setFade(!!content["on"]); return; }
    if (type !== "dboWidget") return;
    const closeId = Number(content["close"]);
    if (Number.isFinite(closeId) && closeId > 0) {
      if (this.focusedId === closeId) { this.focusedId = 0; closeFormMenu(this.sp, closeId); }
      else closeWidget(this.sp, closeId);
      return;
    }
    const w = content["widget"];
    if (!w || typeof w !== "object") return;
    const wid = Number((w as any).id);
    if (!Number.isFinite(wid) || wid <= 0) return;
    if (content["focus"]) {
      this.focusedId = wid;
      openFormMenu(this.sp, this.browsersideWidgetSetter, { widget: w, id: wid }, this.controller);
    } else {
      refreshFormMenu(this.sp, this.browsersideWidgetSetter, { widget: w, id: wid });
    }
  }

  // A black screen held while the server carries a new character into the hub; it lifts on its own if the server never says so
  private setFade(on: boolean): void {
    const timers = this.controller.lookupListener(TimersService);
    if (this.fadeSafety !== undefined) { timers.clearTimeout(this.fadeSafety); this.fadeSafety = undefined; }
    this.fadeWanted = on;
    try { this.sp.Game.fadeOutGame(on, true, 0, on ? 0.4 : 1); } catch (e) { return; }
    if (on) this.fadeSafety = timers.setTimeout(() => this.setFade(false), FADE_SAFETY_MS);
  }

  // Loading a save clears any fade, so a black screen still wanted goes straight back on, with no fade-in to see through
  private onGameLoaded(): void {
    if (!this.fadeWanted) return;
    try { this.sp.Game.fadeOutGame(true, true, 0, 0); } catch (e) { /* the next load tries again */ }
  }

  private fadeSafety: number | undefined = undefined;
  private fadeWanted = false;

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (key === "menu:escape") { if (this.focusedId) this.closeFocused("escape"); return; }
    if (typeof key !== "string" || !key.startsWith("dbo:")) return;
    const args = Array.prototype.slice.call(e.arguments, 1);
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: key.slice(4), args, widget: this.focusedId });
  }

  private closeFocused(why: string): void {
    const id = this.focusedId;
    this.focusedId = 0;
    closeFormMenu(this.sp, id);
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "close", args: [why], widget: id });
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== id);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private focusedId = 0;
  private hudData: Record<string, unknown> | null = null;
  private partyData: Record<string, unknown> | null = null;
  private hudKey = "";
  private partyKey = "";
  private hudSentAt = 0;
  private partySentAt = 0;
  private nextPassive = 0;
}

const now = (): number => Date.now();
