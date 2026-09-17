import React, { useLayoutEffect, useRef, useState } from 'react';

import './styles.scss';

interface MenuAction {
  id: string;
  label: string;
}

interface ContextMenuEvents {
  action: string;
  close: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
// The gamemode picks the entries (playermenu.js); mode "inspect" shows lines instead of actions.
export interface ContextMenuData {
  targetName: string;
  actions: MenuAction[];
  lines?: string[];
  mode?: 'menu' | 'inspect';
  events: ContextMenuEvents;
}

// Entries only guards, officials and admins receive; shown under their own heading.
const LAW_ACTIONS = new Set(['search', 'capture', 'release', 'carry', 'putdown']);

// Gap from the screen centre to the panel's top-left corner, in px.
const GAP = 18;

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('contextMenu sendMessage', key, args);
  }
};

const ContextMenu = ({ data }: { data: ContextMenuData }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const ev = data.events || ({} as ContextMenuEvents);
  const actions = data.actions || [];
  const lines = data.lines || [];
  const inspect = data.mode === 'inspect';
  const common = actions.filter((a) => !LAW_ACTIONS.has(a.id));
  const law = actions.filter((a) => LAW_ACTIONS.has(a.id));

  // Panel hangs down-right of the crosshair, clamped inside the viewport before first paint.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const margin = 12;
    let left = window.innerWidth / 2 + GAP;
    let top = window.innerHeight / 2 - el.offsetHeight / 3;
    left = Math.max(margin, Math.min(left, window.innerWidth - el.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - el.offsetHeight - margin));
    setPos({ left, top });
  }, [data.targetName, actions.length, lines.length, data.mode]);

  const style = pos
    ? { left: pos.left + 'px', top: pos.top + 'px' }
    : { left: 'calc(50% + ' + GAP + 'px)', top: '40%' };

  const row = (a: MenuAction) => (
    <button key={a.id} className="context-menu__row" onClick={() => send(ev.action, a.id)}>
      {a.label}
    </button>
  );

  return (
    <div className="context-menu">
      <div className="context-menu__panel" ref={panelRef} style={style}>
        <div className="context-menu__kicker">{inspect ? 'Inspect' : 'Interact'}</div>
        <div className="context-menu__title">{data.targetName}</div>
        <div className="context-menu__rule" />

        {inspect ? (
          <ul className="context-menu__lines">
            {lines.map((l, i) => (
              <li key={i} className="context-menu__line">{l}</li>
            ))}
          </ul>
        ) : (
          <div className="context-menu__rows">{common.map(row)}</div>
        )}

        {!inspect && law.length > 0 && (
          <>
            <div className="context-menu__section">Guard</div>
            <div className="context-menu__rows">{law.map(row)}</div>
          </>
        )}

        <button className="context-menu__close" onClick={() => send(ev.close)}>
          Close
        </button>
      </div>
    </div>
  );
};

export default ContextMenu;
