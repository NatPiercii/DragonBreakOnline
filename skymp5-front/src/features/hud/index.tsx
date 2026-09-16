import React, { useEffect, useState } from 'react';

import './styles.scss';

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
}

const clampPct = (v: unknown): number => Math.max(0, Math.min(100, Number(v) || 0));

// The hourglass art is bundled through the stylesheet (src/img/dbo-watermark.png), so this is
// only the positioned box it paints into.
const Watermark = ({ on }: { on: boolean }) => (on ? <div className="dboWatermark" /> : null);

// Three etched bars in the Lorkhan idiom: a notched aetherial frame, a rune cap per vital, quarter
// ticks like the marks of a broken calendar, and a slow sheen across the fill.
const Vitals = ({ data }: { data: HudData }) => {
  if (data.vitalsOn === false) return null;
  const rows: Array<[string, string, number]> = [
    ['health', 'Health', clampPct(data.health)],
    ['magicka', 'Magicka', clampPct(data.magicka)],
    ['stamina', 'Stamina', clampPct(data.stamina)],
  ];
  return (
    <div className="dboVitals">
      {rows.map(([key, label, pct]) => (
        <div className={`dboVitals__row dboVitals__row--${key}`} key={key} title={`${label} ${Math.round(pct)}%`}>
          <span className={`dboVitals__rune dboVitals__rune--${key}`} />
          <div className="dboVitals__bar">
            <div className={`dboVitals__fill dboVitals__fill--${key}`} style={{ width: `${pct}%` }}>
              <span className="dboVitals__sheen" />
            </div>
            <span className="dboVitals__ticks" />
            <span className="dboVitals__gloss" />
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

const Hud = ({ data }: { data: HudData }) => {
  const { mode: voice, talking } = useVoice();
  if (!data) return null;
  const hunger = clampPct(data.hunger);
  const fullness = 100 - hunger; // the meter shows how fed you are
  const stage = (data.stage || '').toLowerCase();
  return (
    <>
      <Watermark on={data.watermarkOn !== false} />
      <div className="dboCorner">
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
      <Vitals data={data} />
    </>
  );
};

export default Hud;
