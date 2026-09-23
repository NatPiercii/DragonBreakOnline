// A message across the middle of the screen. The client calls window.__dboBanner(text, seconds) for a server
// dboBanner packet; a new message replaces the one showing.
import './Banner.scss';

const FADE_MS = 400;
let el = null;
let hideTimer = 0;
let removeTimer = 0;

const ensure = () => {
  if (el && document.body.contains(el)) return el;
  el = document.createElement('div');
  el.className = 'dboBanner';
  el.innerHTML = '<div class="dboBanner__rule"></div><div class="dboBanner__text"></div><div class="dboBanner__rule"></div>';
  document.body.appendChild(el);
  return el;
};

window.__dboBanner = (text, seconds) => {
  const t = String(text || '').trim();
  if (!t) return false;
  const node = ensure();
  node.querySelector('.dboBanner__text').textContent = t;
  clearTimeout(hideTimer);
  clearTimeout(removeTimer);
  node.classList.remove('dboBanner--out');
  // Restart the fade-in when a message replaces one still showing
  node.classList.remove('dboBanner--in');
  void node.offsetWidth;
  node.classList.add('dboBanner--in');
  const ms = Math.min(15, Math.max(1.5, Number(seconds) || 4)) * 1000;
  hideTimer = setTimeout(() => {
    node.classList.add('dboBanner--out');
    removeTimer = setTimeout(() => node.classList.remove('dboBanner--in', 'dboBanner--out'), FADE_MS);
  }, ms);
  return true;
};
