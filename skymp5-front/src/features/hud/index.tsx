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

// Oblivion-style stacked bars: health, magicka, fatigue (stamina), bottom-right
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
        <div className="dboVitals__row" key={key} title={`${label} ${Math.round(pct)}%`}>
          <div className="dboVitals__bar">
            <div className={`dboVitals__fill dboVitals__fill--${key}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
};

const STAGE_LABEL: Record<string, string> = { sated: 'Well fed', peckish: 'Peckish', hungry: 'Hungry', starving: 'Starving' };
const VOICE_LABEL: Record<string, string> = { whisper: 'Whisper', talk: 'Normal', shout: 'Yell' };

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

const Hud = ({ data }: { data: HudData }) => {
  const { mode: voice, talking } = useVoice();
  if (!data) return null;
  const hunger = clampPct(data.hunger);
  const fullness = 100 - hunger; // the meter shows how fed you are
  const stage = (data.stage || '').toLowerCase();
  return (
    <>
      <Watermark on={data.watermarkOn !== false} />
      {data.hungerOn !== false && (
        <div className="dboStatus">
          <div className={`dboStatus__row dboStatus__row--${stage || 'sated'}`} title={`Hunger ${Math.round(hunger)}%`}>
            <span className="dboStatus__icon dboStatus__icon--food" />
            <span className="dboStatus__label">{STAGE_LABEL[stage] || data.stage || 'Well fed'}</span>
            <span className="dboStatus__value">{Math.round(fullness)}%</span>
            <div className="dboStatus__meter"><div className="dboStatus__fill" style={{ width: `${fullness}%` }} /></div>
          </div>
          <div className={'dboStatus__row dboStatus__row--voice' + (talking ? ' dboStatus__row--talking' : '')} title="Hold V to talk, tap Left Alt to change">
            <span className="dboStatus__icon dboStatus__icon--voice" />
            <span className="dboStatus__label">{VOICE_LABEL[voice] || 'Normal'}</span>
            <span className="dboStatus__value dboStatus__value--dim">{talking ? 'talking' : 'L-Alt'}</span>
          </div>
        </div>
      )}
      <Vitals data={data} />
    </>
  );
};

export default Hud;
