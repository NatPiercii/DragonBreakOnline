import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 25;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  choose: 'mastery:choose',
  drop: 'mastery:drop',
  lock: 'mastery:lock',
  takeUp: 'mastery:takeUp',
  close: 'mastery:close',
};

interface Profession {
  id: string;
  label: string;
  title: string;
}

// The server's masteryMenu reply, mirrored into the widget.
interface MasteryInfo {
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  professions: Profession[];
  // DragonBreak skills: three groups, up to maxChosen skills, five tiers
  maxChosen: number;
  tierNames: string[];
  tierHours: number[];
  categories: unknown[];
  skills: unknown[];
  chosen: unknown[];
  respec: unknown;
  points: unknown;     // the point system's pool, caps and held skills, null while it is off
}

// Module-level so the browser-side widget setter can read it (runtime injection).
let info: MasteryInfo = { profession: null, rank: 0, hours: 0, rankHours: [], professions: [], maxChosen: 3, tierNames: [], tierHours: [], categories: [], skills: [], chosen: [], respec: null, points: null };

/**
 * Mastery menu (default K). Shows the eight professions, the one this
 * character has taken up, and how far its rank has come. Rank is earned by
 * time played, so there is nothing to spend here - the only action is the
 * one-time choice of a profession.
 *
 * Protocol - all messages are MsgType.CustomPacket with a JSON dump.
 *
 *   Client -> Server: { "customPacketType": "masteryInfoRequest" }
 *   Server -> Client: { "customPacketType": "masteryMenu", "profession", "rank",
 *                       "hours", "rankHours", "professions" }
 *   Client -> Server: { "customPacketType": "masteryChoose", "profession" }
 *   Server -> Client: { "customPacketType": "masteryNotice", "text" }
 */
export class MasteryService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // A front reload drops the widget without a close message.
    this.controller.emitter.on("browserWindowLoaded", () => { this.menuOpen = false; });
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });

    this.menuKey = readMenuKeyCode(this.sp, "masteryMenuKeyCode", DxScanCode.K);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // Gamepad idCodes are bitmasks that alias onto keyboard scancodes
    if (e.device !== InputDeviceType.Keyboard) return;
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) return;
    if (isMenuHotkeyBlocked(this.sp, this.controller)) return;

    logTrace(this, `Requesting mastery info`);
    this.awaitingOpen = true;
    sendCustomPacket(this.controller, { customPacketType: "masteryInfoRequest" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "masteryMenu": {
        const professions = Array.isArray(content["professions"]) ? content["professions"] : [];
        const rankHours = Array.isArray(content["rankHours"]) ? content["rankHours"] : [];
        info = {
          profession: typeof content["profession"] === "string" ? content["profession"] as string : null,
          rank: Number(content["rank"]) || 0,
          hours: Number(content["hours"]) || 0,
          rankHours: rankHours as number[],
          professions: professions as Profession[],
          maxChosen: Number(content["maxChosen"]) || 3,
          tierNames: Array.isArray(content["tierNames"]) ? content["tierNames"] as string[] : [],
          tierHours: Array.isArray(content["tierHours"]) ? content["tierHours"] as number[] : [],
          categories: Array.isArray(content["categories"]) ? content["categories"] as unknown[] : [],
          skills: Array.isArray(content["skills"]) ? content["skills"] as unknown[] : [],
          chosen: Array.isArray(content["chosen"]) ? content["chosen"] as unknown[] : [],
          respec: content["respec"] ?? null,
          points: content["points"] ?? null,
        };
        // A reply we did not ask for (a refresh after choosing) updates the
        // open menu but must never force a closed one open.
        if (this.awaitingOpen || this.menuOpen) {
          this.awaitingOpen = false;
          this.openMenu();
        }
        break;
      }
      case "masteryNotice":
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
    if (typeof key !== "string" || !key.startsWith("mastery:") || !this.menuOpen) return;

    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.choose || key === events.drop) {
      const profession = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      if (profession) {
        sendCustomPacket(this.controller, { customPacketType: key === events.choose ? "masteryChoose" : "masteryDrop", profession });
      }
      return;
    }
    if (key === events.lock) {
      const skill = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      const lock = typeof e.arguments[2] === "string" ? (e.arguments[2] as string) : "";
      if (skill && lock) sendCustomPacket(this.controller, { customPacketType: "masteryLock", skill, lock });
      return;
    }
    // Accepting a combat skill the server has offered: it banked the work already done and pays it back.
    if (key === events.takeUp) {
      const skill = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      if (skill) sendCustomPacket(this.controller, { customPacketType: "masteryTakeUp", skill });
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.awaitingOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "mastery",
      id: WIDGET_ID,
      profession: info.profession,
      rank: info.rank,
      hours: info.hours,
      rankHours: info.rankHours,
      professions: info.professions,
      maxChosen: info.maxChosen,
      tierNames: info.tierNames,
      tierHours: info.tierHours,
      categories: info.categories,
      skills: info.skills,
      chosen: info.chosen,
      respec: info.respec,
      points: info.points,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.K;
  private menuOpen = false;
  private awaitingOpen = false;
}
