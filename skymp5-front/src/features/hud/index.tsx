import React from 'react';

import './styles.scss';

// The widget object pushed through window.skyrimPlatform.widgets by the
// gamemode's ff_hud property (owner-side code in gamemode.js). Passive, never
// focused. Bottom-left holds the needs bars; the right side is reserved for the
// vitals bars (health / magicka / stamina) when they are built.
export interface HudData {
  hunger?: number;      // 0 sated .. 100 starving
  stage?: string;       // Sated / Peckish / Hungry / Starving
  hungerOn?: boolean;
  // Vitals in percent, read on the client from the player's actor values
  health?: number;
  magicka?: number;
  stamina?: number;
  vitalsOn?: boolean;
}

const clampPct = (v: unknown): number => Math.max(0, Math.min(100, Number(v) || 0));

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

const stageClass = (stage: string): string => {
  const s = (stage || '').toLowerCase();
  if (s === 'starving') return 'dboHud__fill--starving';
  if (s === 'hungry') return 'dboHud__fill--hungry';
  if (s === 'peckish') return 'dboHud__fill--peckish';
  return '';
};

const Hud = ({ data }: { data: HudData }) => {
  if (!data) return null;
  const hunger = clampPct(data.hunger);
  const fullness = 100 - hunger; // the bar empties as hunger grows
  return (
    <>
      {data.hungerOn !== false && (
        <div className="dboHud">
          <div className="dboHud__row" title={`Hunger ${Math.round(hunger)}%`}>
            <span className="dboHud__label">Hunger</span>
            <div className="dboHud__bar">
              <div className={`dboHud__fill ${stageClass(data.stage || '')}`} style={{ width: `${fullness}%` }} />
            </div>
            <span className="dboHud__stage">{data.stage || ''}</span>
          </div>
        </div>
      )}
      <Vitals data={data} />
    </>
  );
};

export default Hud;
