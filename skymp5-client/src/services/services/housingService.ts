import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuKeyPressBlocked } from "./widgetMenuUtil";
import { buttonKeyCode } from "./mouseKeys";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 8;

// A hand-over waits for one more housing-key press; it must not wait forever.
const PENDING_RECIPIENT_MS = 30000;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  claim: 'housing:claim',
  abandon: 'housing:abandon',
  revoke: 'housing:revoke',
  lock: 'housing:lock',
  unlock: 'housing:unlock',
  transfer: 'housing:transfer',
  rename: 'housing:rename',
  createKey: 'housing:createkey',
  revokeKeys: 'housing:revokekeys',
  grantContainer: 'housing:grantcontainer',
  // Rooms and chests of a place (the server's placeMenu): the second argument is the room's ref
  assign: 'housing:assign',
  unassign: 'housing:unassign',
  share: 'housing:share',
  unshare: 'housing:unshare',
  cancel: 'housing:cancel',
};

// One inner door or chest of a place, as the server lists it for its owner
interface PlaceRoom {
  ref: number;
  label: string;
  kind: 'door' | 'chest';
  assigned: string | null;
  shared: boolean;
  other: string | null;
}

interface PlaceInfo {
  root: number;
  name: string | null;
  here: number;
  rooms: PlaceRoom[];
  more: number;
}

const MAX_ROOMS = 48;

// The place part of a propertyMenu, checked field by field: it goes on into the browser
const readPlace = (raw: unknown): PlaceInfo | null => {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const rooms: PlaceRoom[] = (Array.isArray(p["rooms"]) ? p["rooms"] as unknown[] : []).slice(0, MAX_ROOMS).map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return {
      ref: Number(o["ref"]) >>> 0,
      label: text(o["label"], 48) || 'Room',
      kind: o["kind"] === 'chest' ? 'chest' : 'door',
      assigned: text(o["assigned"], 48),
      shared: o["shared"] === true,
      other: text(o["other"], 48),
    } as PlaceRoom;
  }).filter((r) => r.ref);
  return { root: Number(p["root"]) >>> 0, name: text(p["name"], 48), here: Number(p["here"]) >>> 0, rooms, more: Math.max(0, Number(p["more"]) || 0) };
};

// The server's propertyMenu reply that drives which menu we render.
interface PropertyMenuInfo {
  target: number;
  view: 'owner' | 'manager' | 'keyholder' | 'claimable' | 'denied';
  owned: boolean;
  name: string | null;
  locked: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
  place: PlaceInfo | null;
  placeName: string | null;
  assignedToYou: boolean;
}

// Module-level state shared with the browser-side widget setter via runtime injection
let info: PropertyMenuInfo = {
  target: 0, view: 'denied', owned: false, name: null, locked: false,
  hasKeys: false, canGrantContainers: false, ownerName: null,
  place: null, placeName: null, assignedToYou: false,
};
let targetLabel = '';

/**
 * Property menu on the housing key (default H). Aim at a door or container and
 * press the key: the client asks the server what it may do there and renders
 * the matching menu.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "propertyInfoRequest", "target": <id> }
 *   Server -> Client: { "customPacketType": "propertyMenu", "target", "view",
 *                       "name", "locked", "hasKeys", "canGrantContainers", "ownerName" }
 *   Client -> Server: { "customPacketType": "propertyRequest", "action", "target",
 *                       "recipient"?, "name"? }
 *   Server -> Client: { "customPacketType": "propertyNotice", "text" }
 *
 * Views: 'denied' shows only "You don't own this"; 'claimable' adds a claim
 * button; 'owner' offers rename/keys/lock/transfer/abandon; 'manager'
 * (steward, jarl, regent, or the surrounding house's owner) offers
 * grant/revoke/lock/rename; 'keyholder' offers lock/unlock. Transfer and
 * grant-container are two-step: pick the action, then look at the recipient
 * and press the housing key again.
 *
 * A place (a house with all its doors and chests, server housingSystem.ts with
 * housingPlaceMigration "apply") adds "place" to the menu for its owner and the
 * managers: its Rooms and chests, each assigned to a person (two-step, like a
 * hand-over), taken back, or for a chest shared with the household.
 */
export class HousingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });

    this.menuKey = readMenuKeyCode(this.sp, "housingMenuKeyCode", DxScanCode.X); // DragonBreak Online: X is the shared interact key
  }

  private onButtonEvent(e: ButtonEvent): void {
    // The key's scan code, or 256 + the button for a bindable mouse button (mouseKeys.ts); gamepad idCodes alias onto
    // keyboard scancodes and are never a key here
    const code = buttonKeyCode(e);
    if (code === null) return;
    // Escape closes an open menu.
    if (code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (code !== this.menuKey || !e.isDown) {
      return;
    }
    if (isMenuKeyPressBlocked(this.sp, this.controller, e)) {
      return;
    }

    // Second step of transfer / grant-container: this press picks the player.
    if (this.pendingRecipient !== null) {
      const pending = this.pendingRecipient;
      this.pendingRecipient = null;
      if (Date.now() > pending.expiresAt) {
        notifyNextUpdate(this.controller, this.sp, "That hand-over expired.");
        return;
      }
      const ref = this.sp.Game.getCurrentCrosshairRef();
      const recipient = ref && Actor.from(ref) ? ref : null;
      if (!recipient || recipient.getFormID() === 0x14) {
        notifyNextUpdate(this.controller, this.sp, "Cancelled - that is not a person.");
        return;
      }
      sendCustomPacket(this.controller, {
        customPacketType: "propertyRequest",
        action: pending.action,
        target: pending.target,
        ...(pending.ref ? { ref: pending.ref } : {}),
        recipient: localIdToRemoteId(recipient.getFormID()),
      });
      return;
    }

    if (this.menuOpen) {
      return;
    }

    const ref = this.sp.Game.getCurrentCrosshairRef();
    // A player under the crosshair belongs to the interaction menu (same X key): stay silent.
    if (ref && Actor.from(ref)) {
      return;
    }
    if (!ref) {
      notifyNextUpdate(this.controller, this.sp, "Look at a door or container.");
      return;
    }
    this.target = localIdToRemoteId(ref.getFormID());
    if (!this.target) {
      notifyNextUpdate(this.controller, this.sp, "That cannot be claimed.");
      return;
    }
    targetLabel = (ref.getName() || "Property").trim() || "Property";
    logTrace(this, `Requesting property info for`, targetLabel, `(${this.target})`);
    sendCustomPacket(this.controller, { customPacketType: "propertyInfoRequest", target: this.target });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "propertyMenu": {
        const view = content["view"];
        info = {
          target: Number(content["target"]) || this.target,
          view: view === 'owner' || view === 'manager' || view === 'keyholder' || view === 'claimable' ? view : 'denied',
          owned: content["owned"] === true,
          name: typeof content["name"] === "string" ? content["name"] as string : null,
          locked: content["locked"] === true,
          hasKeys: content["hasKeys"] === true,
          canGrantContainers: content["canGrantContainers"] === true,
          ownerName: typeof content["ownerName"] === "string" ? content["ownerName"] as string : null,
          place: readPlace(content["place"]),
          placeName: typeof content["placeName"] === "string" ? (content["placeName"] as string).slice(0, 48) : null,
          assignedToYou: content["assignedToYou"] === true,
        };
        // A pending recipient pick owns the screen; a late reply must not reopen.
        if (this.pendingRecipient === null) this.openMenu();
        break;
      }
      case "propertyNotice":
        if (typeof content["text"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["text"]);
        }
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("housing:") || !this.menuOpen) {
      return;
    }
    const target = info.target || this.target;

    switch (key) {
      // State-changing actions leave the menu open; the server re-sends
      // propertyMenu on success so the new state shows in place.
      case events.claim:
      case events.abandon:
      case events.revoke:
      case events.lock:
      case events.unlock:
      case events.createKey:
      case events.revokeKeys: {
        const action = key.slice("housing:".length);
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action, target });
        break;
      }
      case events.rename: {
        const name = typeof e.arguments[1] === "string" ? (e.arguments[1] as string).trim() : "";
        if (name) {
          sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action: "rename", target, name });
        }
        break;
      }
      case events.transfer:
      case events.grantContainer: {
        this.pendingRecipient = {
          action: key === events.transfer ? "transfer" : "grantcontainer",
          target,
          ref: 0,
          expiresAt: Date.now() + PENDING_RECIPIENT_MS,
        };
        this.closeMenu();
        notifyNextUpdate(this.controller, this.sp, "Look at the recipient and press the housing key.");
        break;
      }
      // Rooms and chests: assigning picks the person the same way as a hand-over; the rest go at once
      case events.assign:
      case events.unassign:
      case events.share:
      case events.unshare: {
        const ref = Number(e.arguments[1]) >>> 0;
        if (!ref || !info.place || !info.place.rooms.some((r) => r.ref === ref)) break;
        const action = key.slice("housing:".length);
        if (key === events.assign) {
          this.pendingRecipient = { action, target, ref, expiresAt: Date.now() + PENDING_RECIPIENT_MS };
          this.closeMenu();
          notifyNextUpdate(this.controller, this.sp, "Look at the person to give it to and press the housing key.");
          break;
        }
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action, target, ref });
        break;
      }
      case events.cancel:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, targetLabel, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "housing",
      id: WIDGET_ID,
      targetLabel: targetLabel,
      view: info.view,
      owned: info.owned,
      name: info.name,
      locked: info.locked,
      hasKeys: info.hasKeys,
      canGrantContainers: info.canGrantContainers,
      ownerName: info.ownerName,
      place: info.place,
      placeName: info.placeName,
      assignedToYou: info.assignedToYou,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.X;
  private menuOpen = false;
  private target = 0;
  private pendingRecipient: { action: string; target: number; ref: number; expiresAt: number } | null = null;
}
