import React, { useEffect, useRef, useState } from 'react';

import './styles.scss';

// Party panel: the names and health of your party, fed by the gamemode's ff_party
// property (owner-side code reads each member's health from the loaded actor).
// Movable by its title bar and resizable by its corner while the cursor is free
// (F7); position and size persist per player in localStorage.
export interface PartyMember {
  id: number;          // actor form id
  name: string;
  leader?: boolean;
  health?: number;     // 0..100, undefined when the actor is not loaded nearby
  far?: boolean;
  dead?: boolean;
  summon?: boolean;    // an own summon or companion listed under the party
  leftSec?: number;    // seconds until a summon ends, 0 when it has no limit
  staying?: boolean;   // ordered to hold its ground
}

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export interface PartyData {
  id: number;
  members: PartyMember[];
  self?: number;
}

const STORE_KEY = 'dbo.party.box';
const load = (): { x: number; y: number; w: number; h: number } | null => {
  try { const raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const save = (box: { x: number; y: number; w: number; h: number }): void => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(box)); } catch { /* private mode */ }
};

const Party = ({ data }: { data: PartyData }) => {
  const members = data.members || [];
  const [box, setBox] = useState(() => load() || { x: 30, y: 300, w: 240, h: 0 });
  const drag = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; box: typeof box } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current; if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (d.mode === 'move') setBox({ ...d.box, x: Math.max(0, d.box.x + dx), y: Math.max(0, d.box.y + dy) });
      else setBox({ ...d.box, w: Math.max(160, d.box.w + dx), h: Math.max(0, d.box.h + dy) });
    };
    const onUp = () => { if (drag.current) { drag.current = null; setBox((b) => { save(b); return b; }); } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  if (!members.length) return null;
  const start = (mode: 'move' | 'size') => (e: React.MouseEvent) => { e.preventDefault(); drag.current = { mode, sx: e.clientX, sy: e.clientY, box }; };

  return (
    <div className="dboParty" style={{ left: box.x, top: box.y, width: box.w, height: box.h || 'auto' }}>
      <div className="dboParty__bar" onMouseDown={start('move')}>
        <span className="dboParty__title">{members.some((m) => !m.summon) ? 'Party' : 'Companions'}</span>
        <span className="dboParty__count">{members.length}</span>
      </div>
      <div className="dboParty__list">
        {members.map((m) => {
          const pct = Math.max(0, Math.min(100, Number(m.health) || 0));
          return (
            <div key={m.id} className={'dboParty__row' + (m.id === data.self ? ' dboParty__row--self' : '') + (m.dead ? ' dboParty__row--dead' : '') + (m.summon ? ' dboParty__row--summon' : '')}>
              <span className="dboParty__name">
                {m.leader ? '✦ ' : ''}{m.name}
                {m.summon && m.staying ? <span className="dboParty__tag">stay</span> : null}
                {m.summon && m.leftSec ? <span className="dboParty__timer">{clock(m.leftSec)}</span> : null}
              </span>
              <div className="dboParty__bar-track" title={m.far ? 'Too far to see' : `${Math.round(pct)}%`}>
                {m.far ? <span className="dboParty__far">far</span> : <div className="dboParty__fill" style={{ width: `${pct}%` }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="dboParty__grip" onMouseDown={start('size')} title="Drag to resize" />
    </div>
  );
};

export default Party;
