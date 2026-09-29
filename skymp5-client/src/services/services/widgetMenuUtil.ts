import { CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";
import { BrowserService } from "./browserService";
import { FunctionInfo } from "../../lib/functionInfo";
import { Menu } from "skyrimPlatform";

// Shared helpers for CEF form-widget menus; widget setters stay per-service (browser-side, injected vars).

// Removes one widget id from the CEF widget list.
export function closeWidget(sp: Sp, widgetId: number): void {
  sp.browser.executeJavaScript(
    '(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==' +
    widgetId + ';});window.skyrimPlatform.widgets.set(ws);})();'
  );
}

// Injects the setter into CEF and gives it focus; a hidden interface comes back first.
// A panel opened while a vanilla menu owns the keyboard must not take it away. openFormMenu used to call
// setFocused(true) unconditionally, and twelve services call it, so anything the server opened - a trade invite, a
// notice - while the player stood in RaceMenu, their inventory or a container took the keyboard from that menu and
// did not give it back: the "keyboard dead in RaceMenu until you alt-tab" report. Alt-tabbing recovered it because
// the focus change did what nothing else would.
//
// Instead the panel is drawn and shown, focus is left with the game, and the wish for it is remembered. The moment
// the last blocking menu closes, browserService calls takeDeferredFocus and the panel gets the cursor then - so the
// panel is still usable without a key press, and the vanilla menu was never interfered with.
// Deciding this on the recorded set would be a worse bug than the one being fixed: before this change openFormMenu
// forced focus, so a stale entry in badMenusOpen never mattered, and now it decides. liveBlockingMenus asks the
// engine which of them are really open and prunes the rest, and Main Menu is never counted - with a blank
// startmenu.swf the main menu sits open underneath our own screen, and character select would defer to it for ever.
let focusWanted = false;

/**
 * @param alwaysFocus for a panel that IS the screen - character select - which must never wait for anything.
 */
export function openFormMenu(sp: Sp, setter: () => void, args: Record<string, unknown>, controller: CombinedController,
                             alwaysFocus = false): void {
  showUi(controller);
  sp.browser.executeJavaScript(new FunctionInfo(setter).getText(args));
  sp.browser.setVisible(true);

  let blocking: string[] = [];
  if (!alwaysFocus) {
    try {
      blocking = controller.lookupListener(BrowserService).liveBlockingMenus();
    } catch (e) {
      blocking = [];   // too early for the service: behave as before and take focus
    }
  }
  if (blocking.length > 0) {
    focusWanted = true;
    logTrace("widgetMenuUtil", `panel deferring focus, still open: ${blocking.join(", ")}`);
    return;
  }
  focusWanted = false;
  sp.browser.setFocused(true);
}

/** Called when the last live blocking menu closes. Gives a panel opened behind it the cursor it asked for. */
export function takeDeferredFocus(sp: Sp, closed?: string): void {
  if (!focusWanted) return;
  focusWanted = false;
  logTrace("widgetMenuUtil", `panel taking deferred focus after ${closed || "a menu"} closed`);
  try {
    sp.browser.setVisible(true);
    sp.browser.setFocused(true);
  } catch (e) { /* the panel may have closed meanwhile */ }
}

/** A panel that closes stops wanting focus, so a menu closing later does not hand it to nothing. */
export function forgetDeferredFocus(): void {
  focusWanted = false;
}

// Data-only re-push for an already open menu; never touches visibility or focus
export function refreshFormMenu(sp: Sp, setter: () => void, args: Record<string, unknown>): void {
  sp.browser.executeJavaScript(new FunctionInfo(setter).getText(args));
}

export function closeFormMenu(sp: Sp, widgetId: number): void {
  forgetDeferredFocus();
  closeWidget(sp, widgetId);
  sp.browser.setFocused(false);
}

// Clears the hide UI toggle before a server-initiated screen is shown.
export function showUi(controller: CombinedController): void {
  try {
    controller.lookupListener(BrowserService).setUiHidden(false);
  } catch {
    // no browser service registered
  }
}

export function isUiHidden(controller: CombinedController): boolean {
  try {
    return controller.lookupListener(BrowserService).isUiHidden();
  } catch {
    return false;
  }
}

// True while chat has focus or a menu that swallows gameplay input is open (console, inventory, map).
export function isGameInputBlocked(sp: Sp, controller: CombinedController): boolean {
  if (sp.browser.isFocused()) return true;
  if (isConsoleOpen(sp)) return true;
  try {
    return controller.lookupListener(BrowserService).isBlockingMenuOpen();
  } catch {
    return false;
  }
}

// Menu hotkeys are also inert while the interface is hidden.
export function isMenuHotkeyBlocked(sp: Sp, controller: CombinedController): boolean {
  return isUiHidden(controller) || isGameInputBlocked(sp, controller);
}

// Live query: the console can swallow input without a tracked menuOpen event
export function isConsoleOpen(sp: Sp): boolean {
  try {
    return sp.Ui.isMenuOpen(Menu.Console) || sp.Ui.isMenuOpen(Menu.ConsoleNativeUI);
  } catch {
    return false;
  }
}

// Reads the UI language from the skymp5-client settings block.
export function readMenuLanguage(sp: Sp): string {
  try {
    const settings = sp.settings["skymp5-client"] as any;
    const lang = settings && settings["language"];
    return typeof lang === "string" ? lang : "";
  } catch {
    return "";
  }
}

// Reads a DxScanCode key binding from the skymp5-client settings block.
export function readMenuKeyCode(sp: Sp, settingName: string, fallback: number): number {
  try {
    const settings = sp.settings["skymp5-client"] as any;
    if (settings && typeof settings[settingName] === "number") {
      return settings[settingName];
    }
  } catch {
    // fall through to the default
  }
  return fallback;
}
