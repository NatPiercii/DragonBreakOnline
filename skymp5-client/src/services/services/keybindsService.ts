import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, DxScanCode } from "skyrimPlatform";
import { logTrace } from "../../logging";
import { KeybindOverride, keybindOverride, launcherKeyValue, readKeybindFile, readMenuKeyCode, writeKeybindFile } from "./widgetMenuUtil";

// F3, Settings, General: the menu keys, rebound in game (specs/f3-hub-design.md 3.7, piece H4).
//   Browser -> client: cef::keybinds:get; cef::keybinds:save <json { keys: { <settingName>: code | null } }> (null: back
//   to the launcher's key). Client -> browser: window.__dboKeybinds = { live, next } and the dbo:keybinds event.
// live is what this session uses (read at launch); next is what the next launch will use. The file is keybinds-no-load
// (widgetMenuUtil), each key stored with the launcher's value of the moment.

// Every menu key the page may rebind, with the key the services fall back to
export const MENU_KEYS: Record<string, number> = {
  chatKeyCode: DxScanCode.T, freeCursorKeyCode: DxScanCode.F8, housingMenuKeyCode: DxScanCode.X, playerActionKeyCode: DxScanCode.X,
  personalMenuKeyCode: DxScanCode.U, factionMenuKeyCode: DxScanCode.F3, masteryMenuKeyCode: DxScanCode.K, emoteWheelKeyCode: DxScanCode.B,
  nametagKeyCode: DxScanCode.F1, hideUiKeyCode: DxScanCode.F2, voicePushToTalkKeyCode: DxScanCode.V, voiceModeKeyCode: DxScanCode.LeftAlt,
  maskToggleKeyCode: DxScanCode.H, adminMenuKeyCode: DxScanCode.F7, hideChatKeyCode: 0,
};

const RESERVED_KEYS: number[] = [DxScanCode.Escape, DxScanCode.Backspace, DxScanCode.Enter];
const OPTIONAL_KEYS = new Set(["hideChatKeyCode"]);

export class KeybindsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    // What this session reads, taken now: every service read its key in its constructor
    for (const name of Object.keys(MENU_KEYS)) this.live[name] = this.keyOf(name, false);
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (key === "cef::keybinds:get") { this.tellPage(); return; }
    if (key !== "cef::keybinds:save") return;
    try {
      const parsed = JSON.parse(String(e.arguments[1] ?? ""));
      const keys = parsed && typeof parsed.keys === "object" && parsed.keys ? parsed.keys : {};
      const file = readKeybindFile(this.sp);
      for (const name of Object.keys(keys)) {
        if (!(name in MENU_KEYS)) continue;
        const code = keys[name];
        if (code === null) { delete file[name]; continue; }
        if (typeof code !== "number" || code < 0 || code > 255 || Math.floor(code) !== code) continue;
        // Escape, Backspace and Enter close panels, clear and open the chat; only an optional key may be none
        if (RESERVED_KEYS.indexOf(code) !== -1 || (code === 0 && !OPTIONAL_KEYS.has(name))) continue;
        file[name] = { code, launcher: launcherKeyValue(this.sp, name) } as KeybindOverride;
      }
      writeKeybindFile(this.sp, file);
    } catch (err) {
      logTrace(this, `keybinds not saved: ${err}`);
    }
    this.tellPage();
  }

  // fresh: from the file as it is now (the next launch); otherwise this session's
  private keyOf(name: string, fresh: boolean): number {
    if (fresh) {
      const o = readKeybindFile(this.sp)[name];
      return o && o.launcher === launcherKeyValue(this.sp, name) ? o.code : this.launcherKey(name);
    }
    if (name === "chatKeyCode") { const o = keybindOverride(this.sp, name); return o !== null ? o : this.launcherChatKey(); }
    if (name === "playerActionKeyCode") return readMenuKeyCode(this.sp, name, readMenuKeyCode(this.sp, "housingMenuKeyCode", DxScanCode.X));
    return readMenuKeyCode(this.sp, name, MENU_KEYS[name]);
  }

  private launcherKey(name: string): number {
    if (name === "chatKeyCode") return this.launcherChatKey();
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && typeof settings[name] === "number") return settings[name];
      if (name === "playerActionKeyCode" && settings && typeof settings["housingMenuKeyCode"] === "number") return settings["housingMenuKeyCode"];
    } catch { /* the default */ }
    return MENU_KEYS[name];
  }

  // The launcher's chat keys are a list (Enter, T, F6 by default); the one besides Enter and F6 is the chat key
  private launcherChatKey(): number {
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      const list = settings && Array.isArray(settings["chatFocusKeyCodes"]) ? settings["chatFocusKeyCodes"] as number[] : null;
      const own = list ? list.find((c) => c !== DxScanCode.Enter && c !== DxScanCode.F6) : undefined;
      if (typeof own === "number") return own;
    } catch { /* the default */ }
    return DxScanCode.T;
  }

  private tellPage(): void {
    const next: Record<string, number> = {};
    for (const name of Object.keys(MENU_KEYS)) next[name] = this.keyOf(name, true);
    const state = JSON.stringify({ live: this.live, next });
    this.sp.browser.executeJavaScript(`window.__dboKeybinds = ${state}; window.dispatchEvent(new CustomEvent('dbo:keybinds'));`);
  }

  private live: Record<string, number> = {};
}
