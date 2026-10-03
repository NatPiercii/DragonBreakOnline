import { useEffect, useState } from 'react';

// Interface settings the player changes in F3, Settings (specs/f3-hub-design.md 3.7). They belong to the player's PC:
// stored as the `ui` block of the chat-settings file (chatService writes any JSON the page sends as
// cef::chat:saveSettings and injects it back as window.__alduinakChatSettings). The chat's own values (text size,
// transparency, highlights, nametags) stay at the top level of that file; the chat owns them and is told of a change
// by the dbo:chatSettings event.

export type VitalsMode = 'always' | 'fade' | 'hidden';
export type VitalsStyle = 'classic' | 'quiet';
export type ChatMode = 'always' | 'fade' | 'hidden';
export type ChatLettering = 'book' | 'plain';

export interface UiSettings {
  vitals: VitalsMode;
  vitalsStyle: VitalsStyle;
  // Seconds the bars stay after the last change once all three are full ("Fade when full")
  vitalsFadeSeconds: number;
  chat: ChatMode;
  chatLettering: ChatLettering;
}

// Nate, 3 Oct (F3 Q6): a new player's vitals fade when full in the Quiet style and the chat fades when idle; Hidden until
// T is offered only. Nate, 3 Oct, later: anyone who has played before keeps today's look (bars always shown in today's
// style, chat always shown, plain lettering) until they change it.
export const UI_DEFAULTS: UiSettings = { vitals: 'fade', vitalsStyle: 'quiet', vitalsFadeSeconds: 5, chat: 'fade', chatLettering: 'book' };
export const EXISTING_DEFAULTS: UiSettings = { vitals: 'always', vitalsStyle: 'classic', vitalsFadeSeconds: 5, chat: 'always', chatLettering: 'plain' };
// ui.profile in the file says which defaults a player has: 'new' or 'existing', stamped once (settleUiProfile). Without
// one (before the chat has mounted with the file, or a file written before this) the existing player's look holds.
export const defaultsOf = (profile: unknown): UiSettings => (profile === 'new' ? UI_DEFAULTS : EXISTING_DEFAULTS);

const ONE_OF: { [K in keyof UiSettings]?: string[] } = {
  vitals: ['always', 'fade', 'hidden'], vitalsStyle: ['classic', 'quiet'], chat: ['always', 'fade', 'hidden'], chatLettering: ['book', 'plain'],
};
export const VITALS_FADE_CHOICES = [3, 5, 10];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = (): any => (typeof window !== 'undefined' ? window : {});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const chatSettingsFile = (): Record<string, any> => {
  try { const s = win().__alduinakChatSettings; return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; }
};

export const getUiSettings = (): UiSettings => {
  const raw = chatSettingsFile().ui;
  const base = defaultsOf(raw && typeof raw === 'object' ? raw.profile : undefined);
  const out: UiSettings = Object.assign({}, base);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(UI_DEFAULTS) as Array<keyof UiSettings>) {
      const v = raw[k];
      const allowed = ONE_OF[k];
      if (allowed ? allowed.includes(v) : typeof v === typeof UI_DEFAULTS[k]) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  if (!VITALS_FADE_CHOICES.includes(out.vitalsFadeSeconds)) out.vitalsFadeSeconds = base.vitalsFadeSeconds;
  return out;
};

// Before the chat has mounted with the saved file there is nothing to merge into: writing then would replace the file
const save = (next: Record<string, unknown>): void => {
  try {
    if (win().__alduinakChatSettings === undefined) return;
    win().__alduinakChatSettings = next;
    const sp = win().skyrimPlatform;
    if (sp && sp.sendMessage) sp.sendMessage('cef::chat:saveSettings', JSON.stringify(next));
  } catch (e) { /* not saved: still applied for this session */ }
};

export const UI_EVENT = 'dbo:uiSettings';
export const announceUiSettings = (): void => { try { win().dispatchEvent(new CustomEvent(UI_EVENT)); } catch (e) { /* no window */ } };

export const setUiSettings = (patch: Partial<UiSettings>): UiSettings => {
  const file = chatSettingsFile();
  const ui = Object.assign({}, file.ui && typeof file.ui === 'object' ? file.ui : {}, patch);
  save(Object.assign({}, file, { ui }));
  announceUiSettings();
  return getUiSettings();
};

// Other blocks kept beside the interface values in ui (the voice override, VoiceManager.js)
export const readUiExtra = (key: string): unknown => { const ui = chatSettingsFile().ui; return ui && typeof ui === 'object' ? ui[key] : undefined; };
export const writeUiExtra = (key: string, value: unknown): void => {
  const file = chatSettingsFile();
  const ui = Object.assign({}, file.ui && typeof file.ui === 'object' ? file.ui : {}, { [key]: value });
  save(Object.assign({}, file, { ui }));
};

// Anything this page has kept in localStorage before (an interface size, panel sizes, voice volumes): a player who has
// played here, even if the chat-settings file was lost
export const hasPageTraces = (): boolean => {
  try {
    const ls = win().localStorage;
    if (!ls || typeof ls.length !== 'number' || typeof ls.key !== 'function') return false;
    for (let i = 0; i < ls.length; i++) { const k = String(ls.key(i) || ''); if (/^dbo/.test(k)) return true; }
  } catch (e) { /* no storage: nothing to tell */ }
  return false;
};

// Called once by the chat as it mounts with the file the client injected, before the chat writes its own values into
// it. fileWasEmpty: the injected file had nothing in it. The chat writes its values on every mount, so any player who has
// ever had the chat up has a file; an empty one with no page traces is a new player. Stamped once: later mounts keep it.
export const settleUiProfile = (fileWasEmpty: boolean): string => {
  const file = chatSettingsFile();
  const ui = file.ui && typeof file.ui === 'object' ? file.ui : null;
  if (ui && (ui.profile === 'new' || ui.profile === 'existing')) return ui.profile;
  const profile = fileWasEmpty && !ui && !hasPageTraces() ? 'new' : 'existing';
  writeUiExtra('profile', profile);
  announceUiSettings();
  return profile;
};

// The chat's own values: the chat applies and saves them (constructorComponents/chat listens for this event)
export const CHAT_EVENT = 'dbo:chatSettings';
export const setChatSettings = (patch: Record<string, unknown>): void => {
  try { win().dispatchEvent(new CustomEvent(CHAT_EVENT, { detail: patch })); } catch (e) { /* no chat */ }
};

// Re-reads on every change, and when the chat mounts with the saved file (the HUD can draw before it)
export const useUiSettings = (): UiSettings => {
  const [s, setS] = useState<UiSettings>(getUiSettings);
  useEffect(() => {
    const on = (): void => setS(getUiSettings());
    win().addEventListener(UI_EVENT, on);
    on();
    return () => win().removeEventListener(UI_EVENT, on);
  }, []);
  return s;
};

// The in-game interface size against the launcher's (UiScale.js): an in-game choice remembers the launcher's value
// when it was made; once the launcher's value differs from that, the player changed it there since and the launcher's
// wins. Kept in localStorage, as UiScale.js keeps its own.
const SCALE_KEY = 'dboUiScaleInGame';
export interface InGameScale { value: number; launcher: number }
export const readInGameScale = (): InGameScale | null => {
  try { const v = JSON.parse(win().localStorage.getItem(SCALE_KEY)); return v && Number(v.value) >= 0 ? { value: Number(v.value), launcher: Number(v.launcher) || 0 } : null; } catch (e) { return null; }
};
export const writeInGameScale = (v: InGameScale | null): void => {
  try { if (v) win().localStorage.setItem(SCALE_KEY, JSON.stringify(v)); else win().localStorage.removeItem(SCALE_KEY); } catch (e) { /* this session only */ }
};
