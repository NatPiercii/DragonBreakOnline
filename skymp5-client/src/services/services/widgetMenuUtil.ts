import { CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";
import { BrowserService } from "./browserService";
import { FunctionInfo } from "../../lib/functionInfo";
import { Menu, once } from "skyrimPlatform";

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
//
// The handover is deferred by one frame (the menu is still tearing down inside menuClose), so by the time it runs the
// world may have moved on: the panel may have closed, another panel may have taken focus already, another blocking menu
// may have opened (Container right after Book), or the interface may have been hidden. A generation counter, bumped
// whenever the wish is cancelled or superseded, plus a re-check of the live state, means the callback can only ever
// finish the handover it was actually scheduled for.
let focusWanted = false;
let focusGeneration = 0;

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
    focusGeneration++;     // this panel's wish supersedes any older one still pending
    logTrace("widgetMenuUtil", `panel deferring focus, still open: ${blocking.join(", ")}`);
    return;
  }
  focusWanted = false;
  focusGeneration++;       // focus taken here and now: cancel a handover scheduled for an earlier panel
  sp.browser.setFocused(true);
}

/** Called when the last live blocking menu closes. Gives a panel opened behind it the cursor it asked for. */
export function takeDeferredFocus(sp: Sp, controller: CombinedController, closed?: string): void {
  if (!focusWanted) return;
  const mine = focusGeneration;
  focusWanted = false;
  logTrace("widgetMenuUtil", `panel taking deferred focus after ${closed || "a menu"} closed`);

  once("update", () => {
    if (focusGeneration !== mine) {
      logTrace("widgetMenuUtil", "handover cancelled (panel closed or superseded)");
      return;
    }
    let blocking: string[] = [];
    try {
      blocking = controller.lookupListener(BrowserService).liveBlockingMenus();
    } catch (e) {
      blocking = [];
    }
    if (blocking.length > 0) {
      focusWanted = true;    // same generation, so the next close finishes it
      logTrace("widgetMenuUtil", `handover cancelled (${blocking.join(", ")} opened), waiting again`);
      return;
    }
    if (isUiHidden(controller)) {
      focusWanted = true;
      logTrace("widgetMenuUtil", "handover cancelled (interface hidden), waiting again");
      return;
    }
    try {
      sp.browser.setVisible(true);
      sp.browser.setFocused(true);
    } catch (e) { /* the panel may have closed meanwhile */ }
  });
}

/** A panel that closes stops wanting focus, so a menu closing later does not hand it to nothing. */
export function forgetDeferredFocus(): void {
  focusWanted = false;
  focusGeneration++;       // cancels a handover already scheduled for this panel
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

// F3, Settings, General: menu keys rebound in game, kept in PluginsNoLoad/keybinds-no-load as
// { keys: { <settingName>: { code, launcher } } }. `launcher` is the launcher's value when the key was rebound: once
// the launcher's value differs, the player changed it there since and the launcher's wins. Read once per process, so a
// rebind takes effect at the next launch, as each service reads its key in its constructor.
export const KEYBINDS_PLUGIN = "keybinds-no-load";
export interface KeybindOverride { code: number; launcher: string }
let keybindCache: Record<string, KeybindOverride> | null = null;

// A key whose launcher setting has another name: the chat key is one of the launcher's chatFocusKeyCodes
const LAUNCHER_SETTING: Record<string, string> = { chatKeyCode: "chatFocusKeyCodes" };

export function launcherKeyValue(sp: Sp, settingName: string): string {
  try {
    const settings = sp.settings["skymp5-client"] as any;
    const v = settings ? settings[LAUNCHER_SETTING[settingName] || settingName] : undefined;
    return v === undefined || v === null ? "none" : JSON.stringify(v);
  } catch {
    return "none";
  }
}

export function readKeybindFile(sp: Sp): Record<string, KeybindOverride> {
  try {
    // @ts-expect-error (TODO: Remove in 2.10.0)
    const data = sp.getPluginSourceCode(KEYBINDS_PLUGIN, "PluginsNoLoad");
    const parsed = data ? JSON.parse(String(data).slice(2)) : null;
    const keys = parsed && typeof parsed.keys === "object" && parsed.keys ? parsed.keys : {};
    const out: Record<string, KeybindOverride> = {};
    for (const k of Object.keys(keys)) {
      const o = keys[k];
      if (o && typeof o.code === "number" && o.code >= 0 && o.code < 256 && typeof o.launcher === "string") out[k] = { code: o.code, launcher: o.launcher };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeKeybindFile(sp: Sp, keys: Record<string, KeybindOverride>): void {
  sp.writePlugin(
    KEYBINDS_PLUGIN,
    "//" + JSON.stringify({ keys }),
    // @ts-expect-error (TODO: Remove in 2.10.0)
    "PluginsNoLoad"
  );
}

// The in-game key for a setting, or null when there is none or the launcher's value changed since it was set
export function keybindOverride(sp: Sp, settingName: string): number | null {
  if (!keybindCache) keybindCache = readKeybindFile(sp);
  const o = keybindCache[settingName];
  if (!o || o.launcher !== launcherKeyValue(sp, settingName)) return null;
  return o.code;
}

// Reads a DxScanCode key binding: the in-game one (above), else the skymp5-client settings block.
export function readMenuKeyCode(sp: Sp, settingName: string, fallback: number): number {
  const own = keybindOverride(sp, settingName);
  if (own !== null) return own;
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
