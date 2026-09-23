// Every panel can be sized on its own: hold Ctrl and turn the wheel over it. The size is kept per panel type
// in this browser's storage and multiplies the global UI size (UiScale.js). constructor.js applies it.

const KEY = 'dboPanelScales';
const RESET_KEY = 'dboPanelScalesResetAt';
const MIN = 0.5;
const MAX = 2.5;
const STEP = 0.05;

const clamp = (n) => Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100));

let scales = {};
try { scales = JSON.parse(window.localStorage.getItem(KEY)) || {}; } catch (e) { scales = {}; }

const save = () => { try { window.localStorage.setItem(KEY, JSON.stringify(scales)); } catch (e) { /* this session only */ } };
const announce = (type) => window.dispatchEvent(new CustomEvent('dbo:panelScale', { detail: type }));

export const panelScaleOf = (type) => (scales[type] > 0 ? scales[type] : 1);

export const setPanelScale = (type, value) => {
  if (!type) return 1;
  const n = clamp(value);
  if (n === 1) delete scales[type]; else scales[type] = n;
  save();
  announce(type);
  return n;
};

// The launcher's "Reset every panel" stamps a time; each new stamp clears the sizes once
window.dboResetPanelScales = (stamp) => {
  const at = Number(stamp) || 0;
  let done = 0;
  try { done = Number(window.localStorage.getItem(RESET_KEY)) || 0; } catch (e) { /* none */ }
  if (!at || at <= done) return false;
  scales = {};
  save();
  try { window.localStorage.setItem(RESET_KEY, String(at)); } catch (e) { /* none */ }
  announce('*');
  return true;
};

window.dboPanelScales = () => Object.assign({}, scales);

// A little readout so the player sees what the wheel did
let badge = null;
let badgeTimer = null;
const showBadge = (x, y, text) => {
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'dbo-panel-scale-badge';
    document.body.appendChild(badge);
  }
  badge.textContent = text;
  badge.style.left = x + 'px';
  badge.style.top = y + 'px';
  badge.style.opacity = '1';
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => { badge.style.opacity = '0'; }, 900);
};

// Non-passive so the page itself never zooms
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  const host = e.target && e.target.closest ? e.target.closest('[data-panel]') : null;
  if (!host) return;
  e.preventDefault();
  const type = host.getAttribute('data-panel');
  const n = setPanelScale(type, panelScaleOf(type) + (e.deltaY < 0 ? STEP : -STEP));
  showBadge(e.clientX, e.clientY, Math.round(n * 100) + '%');
}, { passive: false });

// Ctrl + middle click puts a panel back to its default size
document.addEventListener('mousedown', (e) => {
  if (!e.ctrlKey || e.button !== 1) return;
  const host = e.target && e.target.closest ? e.target.closest('[data-panel]') : null;
  if (!host) return;
  e.preventDefault();
  setPanelScale(host.getAttribute('data-panel'), 1);
  showBadge(e.clientX, e.clientY, '100%');
});
