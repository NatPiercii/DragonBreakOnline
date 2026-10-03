// The widgets are drawn in px against a 1920x1080 screen. Anything larger made
// them shrink, which is what 4K players reported. The scale is picked from the
// window and applied as --dbo-ui-scale; main.scss does the rest.
//
// window.dboSetUiScale(n) overrides it, 0 or "auto" goes back to automatic, and
// the choice is remembered per machine. The client pushes the launcher's
// uiScale setting through the same function.

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;
const MIN_SCALE = 1;
const MAX_SCALE = 3;
const STORAGE_KEY = 'dboUiScale';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const autoScale = () => {
  const w = window.innerWidth || DESIGN_WIDTH;
  const h = window.innerHeight || DESIGN_HEIGHT;
  // The smaller ratio wins so an ultrawide screen does not overscale
  const raw = Math.min(w / DESIGN_WIDTH, h / DESIGN_HEIGHT);
  return clamp(Math.round(raw * 20) / 20, MIN_SCALE, MAX_SCALE);
};

let override = 0;
try {
  const saved = parseFloat(window.localStorage.getItem(STORAGE_KEY));
  if (saved > 0) override = clamp(saved, 0.5, MAX_SCALE);
} catch (e) {
  // private mode or no storage: automatic is fine
}

const apply = () => {
  const scale = override > 0 ? override : autoScale();
  document.documentElement.style.setProperty('--dbo-ui-scale', String(scale));
  return scale;
};

const remember = () => {
  try {
    if (override > 0) window.localStorage.setItem(STORAGE_KEY, String(override));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // not being able to remember it does not stop it applying now
  }
};

// F3, Settings, Interface size: kept with the launcher's value at the time (uiSettings.ts). The client's push of the
// launcher's value keeps it while that value is unchanged, and drops it once the launcher's value differs.
const IN_GAME_KEY = 'dboUiScaleInGame';
let launcher = 0;
const readInGame = () => {
  try { const v = JSON.parse(window.localStorage.getItem(IN_GAME_KEY)); return v && Number(v.value) >= 0 ? v : null; } catch (e) { return null; }
};

// The launcher's value, pushed by the client (uiScaleService); 0 or "auto" is automatic
window.dboSetUiScale = (value) => {
  const n = value === 'auto' ? 0 : parseFloat(value);
  launcher = n > 0 ? clamp(n, 0.5, MAX_SCALE) : 0;
  const inGame = readInGame();
  if (inGame && (Number(inGame.launcher) || 0) === launcher) override = Number(inGame.value) > 0 ? clamp(Number(inGame.value), 0.5, MAX_SCALE) : 0;
  else {
    if (inGame) { try { window.localStorage.removeItem(IN_GAME_KEY); } catch (e) { /* none */ } }
    override = launcher;
  }
  remember();
  return apply();
};

// The in-game choice (0 = automatic)
window.dboSetUiScaleInGame = (value) => {
  const n = value === 'auto' ? 0 : parseFloat(value);
  override = n > 0 ? clamp(n, 0.5, MAX_SCALE) : 0;
  try { window.localStorage.setItem(IN_GAME_KEY, JSON.stringify({ value: override, launcher })); } catch (e) { /* this session only */ }
  remember();
  return apply();
};

window.dboGetUiScale = () => ({ applied: apply(), override, auto: autoScale(), launcher, inGame: readInGame() });

apply();
window.addEventListener('resize', apply);
