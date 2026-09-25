import { FunctionInfo } from "../../lib/functionInfo";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { openFormMenu, readMenuLanguage } from "./widgetMenuUtil";
import { BrowserMessageEvent, Menu, MenuCloseEvent, MenuOpenEvent } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";
import { NetworkingService } from "./networkingService";
import { SinglePlayerService } from "./singlePlayerService";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

// A character slot from the server; null/absent means empty and Play creates a new character there.
interface CharacterSlot {
  name?: string;
  // Optional one-line summary, e.g. "Nord . 6d 19h played".
  info?: string;
  // Second line, e.g. "No masteries yet . 11 items worn".
  detail?: string;
  race?: string;
  // Permanently dead: shown crossed out and greyed, only Delete is allowed.
  dead?: boolean;
}

const WIDGET_ID = 7;
const SAW_GAMEPLAY_KEY = "dboCharSelectSawGameplay";
const MENU_REQUEST_RETRY_MS = 4000;
const MENU_REQUEST_GIVE_UP_MS = 90000;
const MENU_RECONNECT_RETRY_MS = 12000;
// Leaving to the main menu stops "update" while "tick" goes on; a blocking save stops both, so ticks are counted too
const MAIN_MENU_SILENCE_MS = 2500;
const MAIN_MENU_SILENT_TICKS = 30;
// The journal must have been open this close to the last update, so a load screen from a door never counts
const JOURNAL_QUIT_WINDOW_MS = 500;

// Event keys exchanged with the browser; namespaced to avoid collisions with other "browserMessage" listeners.
const events = {
  select: 'characterSelect:select',         // arg: pick a slot
  play: 'characterSelect:play',             // confirm the selected slot
  edit: 'characterSelect:edit',             // arg: no-op for now
  delete: 'characterSelect:delete',         // arg: ask to delete
  confirmDelete: 'characterSelect:confirmDelete', // arg: delete check
  cancelDelete: 'characterSelect:cancelDelete',
  quit: 'characterSelect:quit',
};

const translations = {
  "ru": {
    selectCharacter: 'Выбор персонажа',
    emptySlot: 'Пусто',
    unnamed: 'Безымянный',
    play: 'Играть',
    edit: 'Изменить',
    del: 'Удалить',
    confirmDelete: 'Удалить этого персонажа навсегда?',
    confirm: 'Подтвердить',
    cancel: 'Отмена',
    quit: 'Выйти',
    dead: 'Мёртв',
    slot: 'Слот',
    create: 'Создать',
    selected: 'Выбран',
    newCharacter: 'Новая жизнь',
  },
  "en": {
    selectCharacter: 'Choose your character',
    emptySlot: 'Empty slot',
    unnamed: 'Unnamed',
    play: 'Play',
    edit: 'Edit',
    del: 'Delete',
    confirmDelete: 'Delete this character forever?',
    confirm: 'Confirm',
    cancel: 'Cancel',
    quit: 'Quit',
    dead: 'Dead',
    slot: 'Slot',
    create: 'Create',
    selected: 'Selected',
    newCharacter: 'A new life',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// State read by the browser-side widget setter via FunctionInfo injection.
let strings: TranslationStrings = translations['en'];
let characters: (CharacterSlot | null)[] = [];
let maxCharacters = 3;
let selectedSlot: number | null = null;
let confirmDeleteSlot: number | null = null;

/**
 * Character-selection menu. Inert until the server opens it, so it has no effect
 * on servers that don't enable the "characterSelect" flow.
 *
 * Protocol (all messages are {@link MsgType.CustomPacket} JSON dumps):
 *
 *   Server -> Client, open the menu:
 *     { "customPacketType": "characterSelectMenu",
 *       "maxCharacters": 3,
 *       "characters": [ { "name": "Lydia", "info": "..." }, null, null ] }
 *
 *   Server -> Client, close without a choice (optional):
 *     { "customPacketType": "characterSelectMenuClose" }
 *
 *   Client -> Server, the player chose:
 *     { "customPacketType": "characterSelectResult", "action": "play",   "slot": 0 }
 *     { "customPacketType": "characterSelectResult", "action": "create", "slot": 1 }
 *     { "customPacketType": "characterSelectResult", "action": "delete", "slot": 2 }
 */
export class CharacterSelectService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.on("menuClose", (e) => this.onMenuClose(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("tick", () => this.onTick());
    // "update" fires only in-game, so the first one marks the initial spawn.
    // gameLoad covers a world load the first update was missed on.
    this.controller.once("update", () => { this.sawGameplay = true; });
    this.controller.emitter.on("gameLoad", () => { this.sawGameplay = true; });
    // The hide UI key drops focus; the modal must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.menuOpen) this.sp.browser.setFocused(true); });

    const lang = readMenuLanguage(this.sp);
    if (lang in translations) {
      strings = translations[lang as keyof typeof translations];
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case 'characterSelectMenu':
        characters = Array.isArray(content["characters"]) ? content["characters"] as (CharacterSlot | null)[] : [];
        maxCharacters = typeof content["maxCharacters"] === 'number' ? content["maxCharacters"] : Math.max(characters.length, 1);
        selectedSlot = null;
        confirmDeleteSlot = null;
        this.menuOpen = true;
        this.wantMenuSince = 0;
        // remoteServer reads this: our own body being parked must not quit the game to the main menu
        (globalThis as any).__dboCharacterSelectOpen = true;
        logTrace(this, `Opening character select menu with`, maxCharacters, `slots`);
        openFormMenu(this.sp, this.browsersideWidgetSetter, this.menuArgs(), this.controller);
        break;
      case 'characterSelectMenuClose':
        if (this.menuOpen) this.closeMenu();
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const eventKey = e.arguments[0];
    if (typeof eventKey !== 'string' || !eventKey.startsWith('characterSelect:')) return;
    if (!this.menuOpen) return;

    const slot = Number(e.arguments[1]);

    switch (eventKey) {
      case events.select:
        // Dead slots can't be selected; they are only deletable.
        if (Number.isInteger(slot) && !characters[slot]?.dead) { selectedSlot = slot; this.renderMenu(); }
        break;
      case events.play:
        // Play loads the selection or starts creation if empty; dead slots refused, server is the authority.
        if (selectedSlot !== null && !characters[selectedSlot]?.dead) {
          const action = characters[selectedSlot] ? 'play' : 'create';
          this.sendResult(action, selectedSlot);
          this.closeMenu();
        }
        break;
      case events.edit:
        // Editing existing characters isn't wired up yet.
        break;
      case events.delete:
        if (Number.isInteger(slot)) { confirmDeleteSlot = slot; this.renderMenu(); }
        break;
      case events.confirmDelete:
        if (Number.isInteger(slot)) {
          this.sendResult('delete', slot);
          // Optimistic local clear; the server also re-sends the menu.
          if (slot < characters.length) characters[slot] = null;
          if (selectedSlot === slot) selectedSlot = null;
          confirmDeleteSlot = null;
          this.renderMenu();
        }
        break;
      case events.cancelDelete:
        confirmDeleteSlot = null;
        this.renderMenu();
        break;
      case events.quit:
        logTrace(this, 'quit requested from character select');
        this.sp.win32.exitProcess();
        break;
      default:
        break;
    }
  }

  // Main Menu events only arrive on "update", which the main menu never runs: a quit is "update" stopping right after the journal
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Journal) return;
    this.journalOpen = true;
    this.journalSeenAt = Date.now();
    this.sendJournalState(true);
  }

  private onMenuClose(e: MenuCloseEvent): void {
    if (e.name !== Menu.Journal) return;
    this.journalOpen = false;
    this.journalSeenAt = Date.now();
    this.sendJournalState(false);
  }

  // Every quit through the menus passes the Journal (the pause menu that holds Quit), so the server's monitor counts a
  // disconnect with it still open as a quit, and one without it as a possible crash (tooling/dbo-monitor)
  private sendJournalState(open: boolean): void {
    try { sendCustomPacket(this.controller, { customPacketType: "dbo", event: "clientState", args: [{ journal: open }] }); } catch { /* offline */ }
  }

  private onUpdate(): void {
    this.lastUpdateAt = Date.now();
    this.ticksSinceUpdate = 0;
    if (this.journalOpen) this.journalSeenAt = this.lastUpdateAt;
  }

  private leftToMainMenu(now: number): boolean {
    if (!this.lastUpdateAt || this.handledSilenceOf === this.lastUpdateAt) return false;
    if (this.ticksSinceUpdate < MAIN_MENU_SILENT_TICKS || now - this.lastUpdateAt < MAIN_MENU_SILENCE_MS) return false;
    if (!this.journalSeenAt || this.lastUpdateAt - this.journalSeenAt > JOURNAL_QUIT_WINDOW_MS) return false;
    return this.sawGameplay && !this.menuOpen && !this.controller.lookupListener(SinglePlayerService).isSinglePlayer;
  }

  // "update" never fires in the main menu; "tick" does
  private onTick(): void {
    this.ticksSinceUpdate++;
    const now = Date.now();
    if (!this.wantMenuSince && this.leftToMainMenu(now)) {
      // Once per silence, so giving up does not restart the loop while still on the main menu
      this.handledSilenceOf = this.lastUpdateAt;
      this.journalOpen = false;
      this.journalSeenAt = 0;
      this.wantMenuSince = now;
      this.lastMenuAttempt = 0;
      this.lastReconnect = now;
      logTrace(this, 'Left to the main menu from the journal, asking for character select');
    }
    if (!this.wantMenuSince) return;
    // Back in the world (a load from the journal, or the selection already played): stop asking
    if (this.menuOpen || this.lastUpdateAt > this.wantMenuSince || now - this.wantMenuSince > MENU_REQUEST_GIVE_UP_MS) {
      this.wantMenuSince = 0;
      return;
    }
    if (now - this.lastMenuAttempt < MENU_REQUEST_RETRY_MS) return;
    this.lastMenuAttempt = now;
    const networking = this.controller.lookupListener(NetworkingService);
    if (networking.isConnected()) {
      // A fresh connection gets the list on its own once authenticated; a request as well is harmless (server-side guards)
      logTrace(this, 'Main menu open after gameplay, requesting character select menu');
      sendCustomPacket(this.controller, { customPacketType: 'characterSelectMenuRequest' });
    } else if (!networking.isAutoReconnectBlocked() && now - this.lastReconnect >= MENU_RECONNECT_RETRY_MS) {
      // Spaced out so a connection attempt still in flight is not torn down and restarted
      this.lastReconnect = now;
      logTrace(this, 'Main menu open after gameplay while disconnected, reconnecting for character select');
      networking.reconnect();
    }
  }

  private sendResult(action: 'play' | 'create' | 'delete', slot: number): void {
    logTrace(this, `Sending character select result:`, action, slot);
    sendCustomPacket(this.controller, { customPacketType: 'characterSelectResult', action, slot });
  }

  private menuArgs(): Record<string, unknown> {
    return { characters, maxCharacters, selectedSlot, confirmDeleteSlot, events, strings, WIDGET_ID };
  }

  private renderMenu(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText(this.menuArgs())
    );
  }

  private closeMenu(): void {
    this.menuOpen = false;
    (globalThis as any).__dboCharacterSelectOpen = false;
    selectedSlot = null;
    confirmDeleteSlot = null;
    // Clear the title screen and any auth form; chat and other in-game widgets must survive a mid-session reopen.
    this.sp.browser.executeJavaScript(
      'window.skyrimPlatform.widgets.set((window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=="form"&&w.type!=="characterSelect";}));'
    );
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  // The screen itself is the front's "characterSelect" widget; it answers with the same events.
  private browsersideWidgetSetter = () => {
    const widget: any = {
      type: "characterSelect",
      id: WIDGET_ID,
      characters,
      maxCharacters,
      selectedSlot,
      confirmDeleteSlot,
      strings,
      events,
    };

    // Replace the auth form and any older title screen, but keep chat alive: this can render mid-session.
    const others = (window.skyrimPlatform.widgets.get() || [])
      .filter((w: any) => w && w.type !== "form" && w.type !== "characterSelect");
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  // Quitting to the main menu can reload the script context, which used to reset this
  // to false and wedge the reopen off for the rest of the session: sp.storage survives it.
  private get sawGameplay(): boolean {
    try {
      if (this.sp.storage[SAW_GAMEPLAY_KEY] === true) return true;
    } catch { /* storage unavailable, fall back to the field */ }
    return this.sawGameplayFallback;
  }

  private set sawGameplay(value: boolean) {
    this.sawGameplayFallback = value;
    try { this.sp.storage[SAW_GAMEPLAY_KEY] = value; } catch { /* storage unavailable */ }
  }

  private sawGameplayFallback = false;
  private wantMenuSince = 0;
  private lastMenuAttempt = 0;
  private lastReconnect = 0;
  private lastUpdateAt = 0;
  private ticksSinceUpdate = 0;
  private journalOpen = false;
  private journalSeenAt = 0;
  private handledSilenceOf = 0;
}
