import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';
import { journalCaps } from '../journal/tabs';
import { UiSettings, useUiSettings } from '../../utils/uiSettings';

// For tests/hud-settings-harness.js: the settings store the HUD and the chat read
export { getUiSettings, setUiSettings, UI_DEFAULTS, BEFORE_FILE } from '../../utils/uiSettings';
import '../journal/sections';

// The widget object pushed through window.skyrimPlatform.widgets by the
// gamemode's ff_hud property (owner-side code in gamemode.js). Passive, never
// focused. Bottom-left is the status panel (hunger state, voice mode),
// bottom-right the vitals bars, top-right the DragonBreak hourglass watermark.
export interface HudData {
  hunger?: number;      // 0 sated .. 100 starving
  stage?: string;       // Sated / Peckish / Hungry / Starving
  hungerOn?: boolean;
  // Vitals in percent, read on the client from the player's actor values
  health?: number;
  magicka?: number;
  stamina?: number;
  vitalsOn?: boolean;
  watermarkOn?: boolean;
  // The server's own count. Gold it moves (pay, rent, sales, the bank) reaches the engine as a SetInventory, which
  // the client cannot apply while the player is looking at their own inventory, so the figure in the menu can sit
  // still while this one is right.
  gold?: number;
  goldOn?: boolean;
}

const clampPct = (v: unknown): number => Math.max(0, Math.min(100, Number(v) || 0));

// The hourglass art is bundled through the stylesheet (src/img/dbo-watermark.png), so this is
// only the positioned box it paints into.
const Watermark = ({ on }: { on: boolean }) => (on ? <div className="dboWatermark" /> : null);

// Three etched bars in the Lorkhan idiom: a notched aetherial frame, a rune cap per vital, quarter
// ticks like the marks of a broken calendar, and a slow sheen across the fill. F3, Settings, Interface (uiSettings.ts):
// Always, Fade when full (gone once all three are full and still for vitalsFadeSeconds, back at once on any drop) or
// Hidden; Classic or Quiet (thin muted bars, no sheen, gloss or glow).
export const vitalsShown = (ui: UiSettings, full: boolean, sinceChangeMs: number): boolean =>
  ui.vitals === 'always' || (ui.vitals === 'fade' && (!full || sinceChangeMs < ui.vitalsFadeSeconds * 1000));

const Vitals = ({ data, ui }: { data: HudData; ui: UiSettings }) => {
  const h = clampPct(data.health), m = clampPct(data.magicka), s = clampPct(data.stamina);
  const full = h >= 100 && m >= 100 && s >= 100;
  const key = `${h}|${m}|${s}`;
  const changedAt = useRef(Date.now());
  const lastKey = useRef(key);
  if (lastKey.current !== key) { lastKey.current = key; changedAt.current = Date.now(); }
  const [, tick] = useState(0);
  const shown = vitalsShown(ui, full, Date.now() - changedAt.current);
  // One redraw when the fade is due, since nothing else moves while the bars are full and still
  useEffect(() => {
    if (ui.vitals !== 'fade' || !full || !shown) return undefined;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(50, ui.vitalsFadeSeconds * 1000 - (Date.now() - changedAt.current) + 20));
    return () => clearTimeout(t);
  }, [key, ui.vitals, ui.vitalsFadeSeconds, full, shown]);
  if (data.vitalsOn === false || ui.vitals === 'hidden') return null;
  const rows: Array<[string, string, number]> = [['health', 'Health', h], ['magicka', 'Magicka', m], ['stamina', 'Stamina', s]];
  const quiet = ui.vitalsStyle === 'quiet';
  return (
    <div className={'dboVitals' + (quiet ? ' dboVitals--quiet' : '') + (shown ? '' : ' dboVitals--faded')}>
      {rows.map(([k, label, pct]) => (
        <div className={`dboVitals__row dboVitals__row--${k}`} key={k} title={`${label} ${Math.round(pct)}%`}>
          <span className={`dboVitals__rune dboVitals__rune--${k}`} />
          <div className="dboVitals__bar">
            <div className={`dboVitals__fill dboVitals__fill--${k}`} style={{ width: `${pct}%` }}>
              {quiet ? null : <span className="dboVitals__sheen" />}
            </div>
            {quiet ? null : <span className="dboVitals__ticks" />}
            {quiet ? null : <span className="dboVitals__gloss" />}
          </div>
        </div>
      ))}
    </div>
  );
};

const STAGE_LABEL: Record<string, string> = { sated: 'Well fed', peckish: 'Peckish', hungry: 'Hungry', starving: 'Starving' };
const VOICE_MODES: Array<[string, string]> = [['whisper', 'Whisper'], ['talk', 'Normal'], ['shout', 'Yell']];

// Voice mode comes from the client (window.__dboVoiceMode + "dbo:voiceMode"); push-to-talk state from
// the front voice manager ("dbo:voicePtt").
const useVoice = (): { mode: string; talking: boolean } => {
  const [mode, setMode] = useState<string>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { return String((window as any).__dboVoiceMode || ''); } catch { return ''; }
  });
  const [talking, setTalking] = useState(false);
  useEffect(() => {
    const onMode = (e: Event) => setMode(String((e as CustomEvent).detail || ''));
    const onPtt = (e: Event) => setTalking(!!(e as CustomEvent).detail);
    window.addEventListener('dbo:voiceMode', onMode);
    window.addEventListener('dbo:voicePtt', onPtt);
    return () => { window.removeEventListener('dbo:voiceMode', onMode); window.removeEventListener('dbo:voicePtt', onPtt); };
  }, []);
  return { mode, talking };
};

// Voice box: the three ranges as pips with the active one lit; the box glows while V is held.
// It never names who is talking: a name there gave away characters the listener had not met (Nate, 2026-09-26),
// so voices are placed by where the speaker stands and nothing else.
const Voice = ({ mode, talking }: { mode: string; talking: boolean }) => {
  const active = VOICE_MODES.some(([id]) => id === mode) ? mode : 'talk';
  return (
    <div className={'dboVoice' + (talking ? ' dboVoice--talking' : '')} title="Hold V to talk, tap Left Alt to change range">
      <span className="dboVoice__icon" />
      <div className="dboVoice__modes">
        {VOICE_MODES.map(([id, label]) => (
          <span key={id} className={'dboVoice__mode' + (id === active ? ' dboVoice__mode--on' : '')}>{label}</span>
        ))}
      </div>
      <span className="dboVoice__hint">{talking ? 'On air' : 'L-Alt'}</span>
    </div>
  );
};

// The panels this UI can draw, told to the server (dbo:uiCaps) so it opens them only for a client that has them and
// uses chat for an older one. The HUD first draws after login; the repeat covers a switch to another character.
const UI_CAPS = ['bank', 'robPrompt', 'feedPrompt', 'downed', 'businessLedger', 'playerMenu', 'spellbook', 'expeditionBoard', 'namePrompt', 'shrinePanel', 'schools', 'journal',
  // Not a panel: the client plays the server's interaction idles (EmoteService dboIdle), so the server may hold a chest
  // for the crouch before it opens (gamemode.js chestHold)
  'dboIdle',
  // Not panels: the lockpick and rite widgets can play a round and judge it on their own clock (judge 'client')
  'lockpickLocal', 'riteJudge',
  // Not a panel: the labour and skinning widgets draw a pick round (mode 'pick', "Read the stone"), no timing
  'pickRound'];
const useUiCaps = (): void => {
  useEffect(() => {
    const tell = () => {
      // The F3 hub and each tab this front draws ('journalHub', 'journalTab:<id>'; features/journal/tabs.ts)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (window as any).skyrimPlatform.sendMessage('dbo:uiCaps', ...UI_CAPS, ...journalCaps()); } catch { /* no bridge */ }
    };
    tell();
    const t = setInterval(tell, 120000);
    return () => clearInterval(t);
  }, []);
};

const Hud = ({ data }: { data: HudData }) => {
  const { mode: voice, talking } = useVoice();
  const ui = useUiSettings();
  useUiCaps();
  if (!data) return null;
  const hunger = clampPct(data.hunger);
  const fullness = 100 - hunger; // the meter shows how fed you are
  const stage = (data.stage || '').toLowerCase();
  const gold = Math.max(0, Math.round(Number(data.gold) || 0));
  return (
    <>
      <Watermark on={data.watermarkOn !== false} />
      <div className="dboCorner">
        {data.goldOn !== false && data.gold !== undefined && (
          <div className="dboStatus">
            <div className="dboStatus__row dboStatus__row--gold" title="The gold you carry">
              <span className="dboStatus__icon dboStatus__icon--gold" />
              <span className="dboStatus__label">Gold</span>
              <span className="dboStatus__value">{gold.toLocaleString('en-US')}</span>
            </div>
          </div>
        )}
        {data.hungerOn !== false && (
          <div className="dboStatus">
            <div className={`dboStatus__row dboStatus__row--${stage || 'sated'}`} title={`Hunger ${Math.round(hunger)}%`}>
              <span className="dboStatus__icon dboStatus__icon--food" />
              <span className="dboStatus__label">{STAGE_LABEL[stage] || data.stage || 'Well fed'}</span>
              <span className="dboStatus__value">{Math.round(fullness)}%</span>
              <div className="dboStatus__meter"><div className="dboStatus__fill" style={{ width: `${fullness}%` }} /></div>
            </div>
          </div>
        )}
        <Voice mode={voice} talking={talking} />
      </div>
      <Vitals data={data} ui={ui} />
    </>
  );
};

export default Hud;
