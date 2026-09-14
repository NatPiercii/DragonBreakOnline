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
}

const stageClass = (stage: string): string => {
  const s = (stage || '').toLowerCase();
  if (s === 'starving') return 'dboHud__fill--starving';
  if (s === 'hungry') return 'dboHud__fill--hungry';
  if (s === 'peckish') return 'dboHud__fill--peckish';
  return '';
};

const Hud = ({ data }: { data: HudData }) => {
  if (!data || data.hungerOn === false) return null;
  const hunger = Math.max(0, Math.min(100, Number(data.hunger) || 0));
  const fullness = 100 - hunger; // the bar empties as hunger grows
  return (
    <div className="dboHud">
      <div className="dboHud__row" title={`Hunger ${Math.round(hunger)}%`}>
        <span className="dboHud__label">Hunger</span>
        <div className="dboHud__bar">
          <div className={`dboHud__fill ${stageClass(data.stage || '')}`} style={{ width: `${fullness}%` }} />
        </div>
        <span className="dboHud__stage">{data.stage || ''}</span>
      </div>
    </div>
  );
};

export default Hud;
