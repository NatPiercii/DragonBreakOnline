import React, { useEffect, useRef, useState } from 'react';

import { Row, SettingsPartProps, registerSettingsSection } from './SettingsTab';
import { DOM_TO_DX, MOUSE_BUTTON_TO_DX, keyName } from '../../../utils/keyNames';

// F3, Settings, General: the menu keys (specs/f3-hub-design.md 3.7, piece H4). A key-capture field per row: press a key,
// Escape cancels, Backspace puts the launcher's key back (or clears an optional one). Two rows on one key are both
// marked. The client (keybindsService) keeps them in keybinds-no-load; they take effect at the next launch.
// A mouse button binds too, as 256 + the button (Middle Mouse 258, Mouse 4 259, Mouse 5 260); left and right click stay
// the page's. This page has the browser focus, and SkyrimPlatform hands it only left, right and middle, so it can take
// the middle button itself; Mouse 4 and 5 reach it only from the client (dbo:keybindMouse), which hears them while a
// window is open only with the SkyrimPlatform change that stops hiding them from the game. Until then they are set in
// the launcher.

interface KeyRow { id: string; label: string; names: string[]; group: 'menus' | 'view'; optional?: boolean; staff?: boolean; hint?: string }
export const KEY_ROWS: KeyRow[] = [
  { id: 'chat', group: 'menus', label: 'Activate chat', names: ['chatKeyCode'], hint: 'Enter always opens it too.' },
  { id: 'cursor', group: 'menus', label: 'Release mouse', names: ['freeCursorKeyCode'] },
  { id: 'interact', group: 'menus', label: 'Interact', names: ['housingMenuKeyCode', 'playerActionKeyCode'], hint: 'Doors, chests and the person in front of you.' },
  { id: 'personal', group: 'menus', label: 'Personal menu', names: ['personalMenuKeyCode'] },
  { id: 'journal', group: 'menus', label: 'Journal', names: ['factionMenuKeyCode'] },
  { id: 'skills', group: 'menus', label: 'Skills', names: ['masteryMenuKeyCode'] },
  { id: 'emotes', group: 'menus', label: 'Emote wheel', names: ['emoteWheelKeyCode'] },
  { id: 'nametags', group: 'view', label: 'Nametags', names: ['nametagKeyCode'] },
  { id: 'hideUi', group: 'view', label: 'Hide interface', names: ['hideUiKeyCode'] },
  { id: 'hideChat', group: 'view', label: 'Hide chat', names: ['hideChatKeyCode'], optional: true, hint: 'Hides the chat until pressed again; T still opens it.' },
  { id: 'ptt', group: 'view', label: 'Push to talk', names: ['voicePushToTalkKeyCode'] },
  { id: 'range', group: 'view', label: 'Voice range', names: ['voiceModeKeyCode'] },
  { id: 'mask', group: 'view', label: 'Mask', names: ['maskToggleKeyCode'] },
  { id: 'admin', group: 'menus', label: 'Admin panel', names: ['adminMenuKeyCode'], staff: true },
];
type MouseSink = (code: number) => void;
const noMouse: MouseSink = () => undefined;
// Keys the capture itself uses, or the chat always takes
const RESERVED = new Set([1, 14, 28]);

interface KeyState { live: Record<string, number>; next: Record<string, number> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = (): any => window;
const readState = (): KeyState | null => { try { const s = w().__dboKeybinds; return s && s.next ? s : null; } catch (e) { return null; } };
const tell = (key: string, ...args: unknown[]): void => { try { w().skyrimPlatform.sendMessage(key, ...args); } catch (e) { /* no bridge */ } };

// Rows sharing a key (an optional row with none never clashes)
export const clashes = (rows: KeyRow[], next: Record<string, number>): Set<string> => {
  const by = new Map<number, string[]>();
  for (const r of rows) { const c = next[r.names[0]] || 0; if (!c) continue; by.set(c, (by.get(c) || []).concat([r.id])); }
  const out = new Set<string>();
  for (const ids of by.values()) if (ids.length > 1) ids.forEach((id) => out.add(id));
  return out;
};

const GeneralPart = ({ section }: SettingsPartProps) => {
  const [state, setState] = useState<KeyState | null>(readState);
  const [capturing, setCapturing] = useState('');
  const [note, setNote] = useState('');
  // The press of a mouse side button the client heard while this row waits (set below, after the rows are known)
  const onClientMouse = useRef<MouseSink>(noMouse);
  useEffect(() => {
    const on = (): void => setState(readState());
    window.addEventListener('dbo:keybinds', on);
    tell('cef::keybinds:get');
    return () => window.removeEventListener('dbo:keybinds', on);
  }, []);
  useEffect(() => {
    if (!capturing) return undefined;
    const on = (e: Event): void => { const code = Number((e as CustomEvent).detail); if (Number.isInteger(code)) onClientMouse.current(code); };
    window.addEventListener('dbo:keybindMouse', on);
    tell('cef::keybinds:capture', '1');
    return () => { window.removeEventListener('dbo:keybindMouse', on); tell('cef::keybinds:capture', '0'); };
  }, [capturing]);
  const rows = KEY_ROWS.filter((r) => !r.staff || section.staff);
  if (!state) return <p className="journal__empty">Reading your keys…</p>;
  const clash = clashes(rows, state.next);
  const pending = rows.some((r) => (state.next[r.names[0]] || 0) !== (state.live[r.names[0]] || 0));
  const save = (r: KeyRow, code: number | null): void => {
    setCapturing('');
    setNote('');
    const keys: Record<string, number | null> = {};
    for (const n of r.names) keys[n] = code;
    tell('cef::keybinds:save', JSON.stringify({ keys }));
  };
  const onKey = (r: KeyRow) => (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (capturing !== r.id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { setCapturing(''); return; }
    if (e.code === 'Backspace') { save(r, r.optional ? 0 : null); return; }
    const hit = DOM_TO_DX[e.code];
    if (!hit) { setNote('That key cannot be used here.'); return; }
    if (RESERVED.has(hit[0])) { setNote(`${hit[1]} is kept for the chat and for closing panels.`); return; }
    save(r, hit[0]);
  };
  // The middle button binds here; left and right click go on to the page (a click on the field again cancels)
  const onMouse = (r: KeyRow) => (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (capturing !== r.id) return;
    const code = MOUSE_BUTTON_TO_DX[e.button];
    if (code === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    save(r, code);
  };
  const capturingRow = rows.find((r) => r.id === capturing);
  onClientMouse.current = (code: number): void => { if (capturingRow && code >= 258 && code <= 263) save(capturingRow, code); };
  const keyRow = (r: KeyRow) => {
    const code = state.next[r.names[0]] || 0;
    const on = capturing === r.id;
    return (
      <Row key={r.id} label={r.label} hint={r.hint}>
        <span className="jset__key-row">
          <button type="button" className={'jset__key' + (on ? ' jset__key--capture' : '') + (clash.has(r.id) ? ' jset__key--clash' : '')}
            onClick={() => { setNote(''); setCapturing(on ? '' : r.id); }} onKeyDown={onKey(r)} onMouseDown={onMouse(r)}
            onAuxClick={(e) => { if (on || e.button === 1) e.preventDefault(); }} onBlur={() => { if (on) setCapturing(''); }}>
            {on ? 'Press a key or the middle mouse button' : code ? keyName(code) : 'None'}
          </button>
          {clash.has(r.id) ? <span className="jset__clash">Shared with another key</span> : null}
          {(state.live[r.names[0]] || 0) !== code ? <span className="jset__later">from your next start</span> : null}
        </span>
      </Row>
    );
  };
  return (
    <div className="jset__part">
      <section className="jset__group">
        <h2 className="journal__heading">Menus</h2>
        {rows.filter((r) => r.group === 'menus').map(keyRow)}
      </section>
      <section className="jset__group">
        <h2 className="journal__heading">View and voice</h2>
        {rows.filter((r) => r.group === 'view').map(keyRow)}
        <p className="jset__note">{note || (pending ? 'Saved. Takes effect when you next start the game.' : 'Click a key, then press the new one, or the middle mouse button. Escape cancels; Backspace puts the launcher\'s key back. Mouse 4 and Mouse 5 are set in the launcher.')}</p>
      </section>
    </div>
  );
};

registerSettingsSection('general', 'General', GeneralPart);
