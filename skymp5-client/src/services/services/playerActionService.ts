import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate, parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, isMenuHotkeyBlocked, readMenuKeyCode } from "./widgetMenuUtil";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { isRemotePlayerCharacter, localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { isOwnCompanion } from "./companionService";
import { isTradeInviteWaiting } from "./tradeService";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;
const MASK_TOGGLE_COOLDOWN_MS = 1500;

interface PlayerAction {
  id: string;
  label: string;
}

// Actions the server systems handle from this client's own packet (they check who may use them);
// every other entry (introduce, inspect, party) goes to the gamemode as a dbo "playerAction" event.
const PACKET_ACTIONS: Record<string, string> = {
  search: 'searchRequest',
  capture: 'captureRequest',
  carry: 'carryRequest',
  putdown: 'putdownRequest',
  release: 'releaseRequest',
};

const events = {
  action: 'pa:action',
  close: 'pa:close',
  trade: 'pa:trade',
};

// Module-level so the browser-side widget setter can read it (runtime injection).
let targetName = '';
let menuActions: PlayerAction[] = [];
let menuLines: string[] = [];
let menuMode = 'menu';

/**
 * Look-at-target interaction menu on the X key (DragonBreak Online): every
 * button event carries the user event name the live control map gives it, so
 * a rebind (Settings > Controls or the launcher's Game Hotkeys) applies at
 * once, default E. Activating a player character opens the player-action /
 * hold-appointment menu; the InteractionPromptService blocks the clone's
 * engine activation so no dialogue fires underneath. Everything that is not
 * a player character passes through to normal activation. Doors and
 * containers are managed by the housing key (HousingService). Drives the
 * gamemode through its existing contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    // Interact follows the housing key unless set on its own: both are "X, the shared interact key" by default
    this.interactKey = readMenuKeyCode(sp, "playerActionKeyCode", readMenuKeyCode(sp, "housingMenuKeyCode", DxScanCode.X));
    this.maskKey = readMenuKeyCode(sp, "maskToggleKeyCode", DxScanCode.H);
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onMenuPacket(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
  }

  private interactKey: number = DxScanCode.X;
  private maskKey: number = DxScanCode.H;

  private onButtonEvent(e: ButtonEvent): void {
    if (!e.isDown) return;
    // Escape closes an open menu; gamepad idCodes alias onto keyboard scancodes, so only the keyboard counts here
    if (e.device === InputDeviceType.Keyboard && e.code === DxScanCode.Escape && this.menuOpen) {
      this.closeMenu();
      return;
    }
    // The engine stamps the live control map's event name on every device, so a rebind applies at once
    // DragonBreak Online: the interaction menu lives on the X key (keyboard only), not on Activate.
    const xPressed = e.device === InputDeviceType.Keyboard && e.code === this.interactKey;
    // H pulls a mask up or down; the gamemode dresses the character and swaps the shown name
    const hPressed = e.device === InputDeviceType.Keyboard && e.code === this.maskKey;
    if ((!xPressed && !hPressed) || this.menuOpen) {
      return;
    }
    // A waiting trade request takes the interact key (TradeService gives it the cursor)
    if (xPressed && isTradeInviteWaiting()) {
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) {
      return;
    }
    if (hPressed) {
      const now = Date.now();
      if (now - this.lastMaskToggle < MASK_TOGGLE_COOLDOWN_MS) return;
      this.lastMaskToggle = now;
      sendCustomPacket(this.controller, { customPacketType: "dbo", event: "maskToggle", args: [] });
      return;
    }

    // The activate key fires on everything; only player characters are ours,
    // the rest passes through to normal activation without a word.
    const ref = this.sp.Game.getCurrentCrosshairRef();
    if (!ref || ref.getFormID() === 0x14) return;
    const actor = Actor.from(ref);
    if (!actor) return;
    const remoteId = localIdToRemoteId(ref.getFormID());
    if (!remoteId || remoteId < 0xff000000) return;
    // Your own summon or companion takes orders from the same menu
    if (isOwnCompanion(remoteId) && !actor.isDead()) {
      this.playerTarget = remoteId;
      targetName = (ref.getDisplayName() || "Companion").trim();
      menuMode = "menu";
      menuLines = [];
      menuActions = [
        { id: "c:follow", label: "Follow me" },
        { id: "c:stay", label: "Stay here" },
        { id: "c:dismiss", label: "Dismiss" },
      ];
      this.openMenu();
      return;
    }
    // Server-spawned creatures and NPCs share the id space and get no menu
    if (!isRemotePlayerCharacter(remoteId)) return;

    // Belt and braces next to the prompt service's block: no clone dialogue.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    // Bodies skip the menu and open their inventory through the server search
    if (actor.isDead()) {
      sendCustomPacket(this.controller, { customPacketType: PACKET_ACTIONS.search, target: remoteId });
      return;
    }
    // The gamemode decides the entries (guard and official actions, restraint state) and answers with dboPlayerMenu
    this.playerTarget = remoteId;
    logTrace(this, `Asking for the player menu on`, remoteId.toString(16));
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "playerMenu", args: [remoteId] });
  }

  private onMenuPacket(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboPlayerMenu") return;
    const target = Number(content["target"]) >>> 0;
    if (!target || target !== this.playerTarget) return;
    const raw = typeof content["name"] === "string" ? (content["name"] as string).trim() : "";
    targetName = raw || "Stranger";
    menuMode = content["mode"] === "inspect" ? "inspect" : "menu";
    menuActions = Array.isArray(content["entries"])
      ? (content["entries"] as Array<Record<string, unknown>>)
        .filter((x) => x && typeof x["id"] === "string" && typeof x["label"] === "string")
        .map((x) => ({ id: x["id"] as string, label: x["label"] as string }))
      : [];
    menuLines = Array.isArray(content["lines"]) ? (content["lines"] as unknown[]).map((x) => String(x)) : [];
    if (this.menuOpen) this.closeMenu();
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("pa:") || !this.menuOpen) {
      return;
    }
    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.trade) {
      if (this.playerTarget) {
        sendCustomPacket(this.controller, { customPacketType: "tradeRequest", recipient: this.playerTarget });
      }
      this.closeMenu();
      return;
    }
    if (key === events.action) {
      const actionId = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      this.closeMenu();
      if (!this.playerTarget) {
        notifyNextUpdate(this.controller, this.sp, "Look at a player first.");
        return;
      }
      if (actionId.startsWith("c:")) {
        sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: actionId.slice(2), companionId: this.playerTarget });
        return;
      }
      if (actionId === "trade") {
        sendCustomPacket(this.controller, { customPacketType: "tradeRequest", recipient: this.playerTarget });
        return;
      }
      const packetType = PACKET_ACTIONS[actionId];
      if (packetType) {
        sendCustomPacket(this.controller, { customPacketType: packetType, target: this.playerTarget });
      } else if (actionId) {
        sendCustomPacket(this.controller, { customPacketType: "dbo", event: "playerAction", args: [actionId, this.playerTarget] });
      }
      return;
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.playerWidgetSetter, { menuActions, menuLines, menuMode, targetName, events, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private playerWidgetSetter = () => {
    const widget = {
      type: "contextMenu",
      id: WIDGET_ID,
      targetName: targetName,
      actions: menuActions,
      lines: menuLines,
      mode: menuMode,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private playerTarget = 0;
  private lastMaskToggle = 0;
}
