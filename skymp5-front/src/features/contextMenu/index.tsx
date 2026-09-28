import React, { useLayoutEffect, useRef, useState } from 'react';

import './styles.scss';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore untyped helper shared with the other panels
import { startPanelDrag, dragPositionOf, clampToParent } from '../../utils/PanelDrag';

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

// The menu is kept under this name while the session lasts, so salvage reopening the same widget after every
// breakdown puts it back where the player dragged it instead of under the crosshair again.
const PANEL = 'contextMenu';

// Past this many characters a name is given two lines at a smaller size rather than being cut ("Break down at the ...")
const LONG_TITLE = 20;

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

  // Where the player last dragged it, if anywhere; otherwise down-right of the crosshair. Either way it is clamped
  // inside the screen before the first paint, so a remembered spot survives a window that has since been resized.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const kept = dragPositionOf(PANEL);
    if (kept) { setPos(clampToParent(el, kept.left, kept.top, 12)); return; }
    setPos(clampToParent(el, window.innerWidth / 2 + GAP, window.innerHeight / 2 - el.offsetHeight / 3, 12));
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
        <div
          className="context-menu__header"
          onMouseDown={(e) => startPanelDrag(e, panelRef.current, setPos, PANEL)}
          title="Drag to move"
        >
          <div className="context-menu__kicker">{inspect ? 'Inspect' : 'Interact'}</div>
          <div className={'context-menu__title' + (String(data.targetName || '').length > LONG_TITLE ? ' context-menu__title--long' : '')}>
            {data.targetName}
          </div>
        </div>
        <div className="context-menu__rule" />

        {inspect
          ? (
          <ul className="context-menu__lines">
            {lines.map((l, i) => (
              <li key={i} className="context-menu__line">{l}</li>
            ))}
          </ul>
            )
          : (
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
