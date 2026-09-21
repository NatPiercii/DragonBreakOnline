
import { QueryKeyCodeBindings } from "../events/queryKeyCodeBindings";

import { ClientListener, CombinedController, Sp } from "./clientListener";
import { FormView } from "../../view/formView";
import { showSystemNotification } from "./systemNotification";
import { isConsoleOpen, readMenuKeyCode } from "./widgetMenuUtil";
import { BrowserMessageEvent, DxScanCode, Menu, MenuCloseEvent, MenuOpenEvent } from "skyrimPlatform";

export const unfocusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserUnfocused', {}))`;
export const focusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:browserFocused', {}))`;
const chatKeyFocusEventString = `window.dispatchEvent(new CustomEvent('skymp5-client:chatKeyFocused', {}))`;

export class BrowserService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.sp.browser.setVisible(false);

    // Key bindings are configurable from the launcher's client settings
    // DragonBreak bindings: F1 nametags, F2 hide the HUD, F6 focus chat (also T / Enter), F8 free cursor (F7 opens the admin panel)
    this.nametagKey = readMenuKeyCode(this.sp, "nametagKeyCode", DxScanCode.F1);
    this.hideUiKey = readMenuKeyCode(this.sp, "hideUiKeyCode", DxScanCode.F2);
    this.freeCursorKey = readMenuKeyCode(this.sp, "freeCursorKeyCode", DxScanCode.F8);
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && Array.isArray(settings["chatFocusKeyCodes"])) {
        const codes = settings["chatFocusKeyCodes"].filter((c: unknown) => typeof c === "number");
        if (codes.length > 0) {
          this.chatFocusKeys = codes as DxScanCode[];
        }
      }
    } catch {
      // fall back to defaults
    }

    this.controller.emitter.on("queryKeyCodeBindings", (e) => this.onQueryKeyCodeBindings(e));
    // A front reload must never leave the player with a hidden interface
    this.controller.emitter.on("browserWindowLoaded", () => this.setUiHidden(false));
    this.controller.once("update", () => this.onceUpdate());
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    this.controller.on("menuClose", (e) => this.onMenuClose(e));
  }

  private onQueryKeyCodeBindings(e: QueryKeyCodeBindings) {
    // Same gate as the menu hotkeys: never fires from typed chat text or the console
    if (e.isDown([this.hideUiKey]) && !this.sp.browser.isFocused() && !isConsoleOpen(this.sp)) {
      this.setUiHidden(!this.uiHidden);
    }
    if (e.isDown([this.nametagKey]) && !this.sp.browser.isFocused() && !isConsoleOpen(this.sp)) {
      FormView.isDisplayingNicknames = !FormView.isDisplayingNicknames;
      showSystemNotification(this.sp, FormView.isDisplayingNicknames ? "Nametags shown" : "Nametags hidden");
    }
    // A hidden page must not take keyboard focus away from the game
    const canFocus = !this.uiHidden && this.badMenusOpen.size === 0;
    if (canFocus && e.isDown([this.freeCursorKey])) {
      const newState = !this.sp.browser.isFocused();
      this.sp.browser.setFocused(newState);
      if (newState) {
        this.sp.browser.executeJavaScript(focusEventString);
      } else {
        this.sp.browser.executeJavaScript(unfocusEventString);
      }
    }
    // Enter also confirms dialogue lines and message boxes; taking chat focus there left the keyboard locked
    if (canFocus && !this.sp.browser.isFocused() && !this.sp.Utility.isInMenuMode() &&
        this.chatFocusKeys.some((key) => e.isDown([key]))) {
      this.sp.browser.setFocused(true);
      this.sp.browser.executeJavaScript(focusEventString);
      // The dedicated chat key (default T, never Enter) also jumps to Local
      const chatKeyOnly = this.chatFocusKeys.filter((key) => key !== DxScanCode.Enter);
      if (chatKeyOnly.some((key) => e.isDown([key]))) {
        this.sp.browser.executeJavaScript(chatKeyFocusEventString);
      }
    }
    if (e.isDown([DxScanCode.Escape])) {
      this.unfocus();
    }
  }

  private onceUpdate() {
    if (!this.uiHidden) {
      this.sp.browser.setVisible(true);
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const onFrontLoadedEventKey = "front-loaded";

    if (e.arguments[0] === onFrontLoadedEventKey) {
      this.controller.emitter.emit("browserWindowLoaded", {});
    }

    // After hitting enter, unfocuses the chat
    if (e.arguments[0] === "cef::browser:unfocus") {
      this.unfocus();
    }
  }

  private onMenuOpen(e: MenuOpenEvent) {
    if (this.isBadMenu(e.name)) {
      // A hidden browser that keeps focus swallows every key with no cursor to show it
      this.unfocus();
      this.sp.browser.setVisible(false);
      this.badMenusOpen.add(e.name);
    } else if (e.name === Menu.HUD && !this.uiHidden) {
      this.sp.browser.setVisible(true);
    }
  }

  private onMenuClose(e: MenuCloseEvent) {
    if (this.badMenusOpen.delete(e.name)) {
      if (this.badMenusOpen.size === 0 && !this.uiHidden) {
        this.sp.browser.setVisible(true);
      }
    }

    if (e.name === Menu.HUD) {
      this.sp.browser.setVisible(false);
    }
  }

  private unfocus() {
    if (this.sp.browser.isFocused()) {
      this.sp.browser.setFocused(false);
      this.sp.browser.executeJavaScript(unfocusEventString);
    }
  }

  private isBadMenu(menu: string) {
    return this.badMenus.includes(menu as Menu);
  }

  isUiHidden(): boolean {
    return this.uiHidden;
  }

  // Menus close via uiHiddenChanged; showing under a blocking vanilla menu is finished by onMenuClose
  setUiHidden(hidden: boolean): void {
    if (this.uiHidden === hidden) return;
    this.uiHidden = hidden;
    if (hidden) this.unfocus();
    this.controller.emitter.emit("uiHiddenChanged", { hidden });
    if (hidden) {
      this.sp.browser.setVisible(false);
    } else if (this.badMenusOpen.size === 0) {
      this.sp.browser.setVisible(true);
    }
  }

  // Typing in the console must not reach menu hotkeys or push-to-talk
  isConsoleOpen(): boolean {
    return this.badMenusOpen.has(Menu.Console);
  }

  // Any menu that swallows gameplay input (inventory, map, console, ...)
  isBlockingMenuOpen(): boolean {
    return this.badMenusOpen.size > 0;
  }

  private badMenusOpen = new Set<string>();
  private uiHidden = false;

  private nametagKey: DxScanCode = DxScanCode.F1;
  private hideUiKey: DxScanCode = DxScanCode.F2;
  private freeCursorKey: DxScanCode = DxScanCode.F8;
  private chatFocusKeys: DxScanCode[] = [DxScanCode.Enter, DxScanCode.T, DxScanCode.F6];

  private readonly badMenus: Menu[] = [
    Menu.Barter,
    Menu.Book,
    Menu.Container,
    Menu.Crafting,
    Menu.Gift,
    Menu.Inventory,
    Menu.Journal,
    Menu.Lockpicking,
    Menu.Loading,
    Menu.Map,
    Menu.RaceSex,
    Menu.Stats,
    Menu.Tween,
    Menu.Console,
    Menu.Main,
  ];
}
