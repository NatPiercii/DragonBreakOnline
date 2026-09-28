// Panels a player can move: hold the header and drag. The position is kept per panel type for this session only
// (Nate, 2026-09-28, from the salvage menu at a smelter: a menu that reopens after every click has to stay where it
// was put). It is deliberately not written to storage - a position is worth remembering while you work at a smelter,
// not for ever, and a panel that opens off in a corner weeks later has no obvious way back.
//
// A panel adopts it with two lines: onMouseDown={(e) => startPanelDrag(e, panelRef.current, setPos)} on its header,
// and dragPositionOf('<type>') as the starting point when it opens. The panel keeps owning its own left/top.

// type -> { left, top }, in the panel's own coordinate space (see the scale note below)
const positions = {};

export const dragPositionOf = (type) => (type && positions[type]) || null;
export const setDragPosition = (type, left, top) => { if (type) positions[type] = { left, top }; };
export const forgetDragPosition = (type) => { if (type) delete positions[type]; };

// A panel inside a resized wrapper is drawn through `zoom` (constructor.scss .dbo-domain--scaled), so a mouse
// movement of 10 client px is fewer than 10 px in the panel's own space. The ratio recovers it without reading CSS.
const scaleOf = (el) => {
  const w = el.offsetWidth;
  if (!w) return 1;
  const drawn = el.getBoundingClientRect().width;
  return drawn > 0 ? drawn / w : 1;
};

// Inside the box the panel is positioned against, with a margin, so it can never be dragged off screen
export const clampToParent = (el, left, top, margin = 8) => {
  const parent = el.offsetParent;
  const maxX = (parent ? parent.clientWidth : window.innerWidth) - el.offsetWidth - margin;
  const maxY = (parent ? parent.clientHeight : window.innerHeight) - el.offsetHeight - margin;
  return {
    left: Math.round(Math.max(margin, Math.min(left, Math.max(margin, maxX)))),
    top: Math.round(Math.max(margin, Math.min(top, Math.max(margin, maxY))))
  };
};

/**
 * Begin a drag from a mousedown on a panel's header.
 * @param {{button: number, clientX: number, clientY: number, target: any, preventDefault: () => void, stopPropagation: () => void}} e
 *        the mousedown; React's synthetic event and the DOM's both fit
 * @param {HTMLElement} el the positioned panel
 * @param {(pos: {left: number, top: number}) => void} onMove called as it moves, and once at the end
 * @param {string} type panel type to remember the position under; omit to move it without remembering
 */
export const startPanelDrag = (e, el, onMove, type) => {
  if (!el || e.button !== 0) return;
  // Buttons and fields inside a header stay clickable
  const t = e.target;
  if (t && t.closest && t.closest('button, input, textarea, select, a')) return;
  e.preventDefault();
  e.stopPropagation();

  const scale = scaleOf(el);
  const startX = e.clientX;
  const startY = e.clientY;
  const fromLeft = el.offsetLeft;
  const fromTop = el.offsetTop;
  let last = { left: fromLeft, top: fromTop };

  const move = (ev) => {
    last = clampToParent(el, fromLeft + (ev.clientX - startX) / scale, fromTop + (ev.clientY - startY) / scale);
    onMove(last);
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('dbo-dragging');
    setDragPosition(type, last.left, last.top);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  document.body.classList.add('dbo-dragging');
};
