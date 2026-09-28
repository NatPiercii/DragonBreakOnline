// Page-side input diagnostic for "MO2 players sit at character select with no mouse or keyboard effect" (2026-09-28,
// GroundedPasta and Vaelis; the game is alive, its heartbeat reaches the server 18 s after login). Worker A is
// logging the native side (WndProc / DInput -> CEF); this is the other end, and answers one question: do the events
// reach the page at all, and if they do, what is under the cursor when they land.
//
// Logging only. Nothing here changes what the page does. Lines go to the client as a `diag:page` browser message -
// deliberately NOT a `dbo:` one, so DboRelayService does not forward every line to the server - and the client
// writes them with logTrace, which puts them in skyrim-platform.log, which is what Report a Problem collects.
//
// Rate: the first 5 of each kind, then at most one per 10 s of that kind, so a player who moves the mouse for a
// minute does not fill the log.

const KINDS = ['mousemove', 'mousedown', 'click', 'keydown'];
const FIRST_N = 5;
const THEN_EVERY_MS = 10000;

let on = false;
let listeners = [];
const counts = {};
const lastAt = {};

const send = (line) => {
  try {
    window.skyrimPlatform.sendMessage('diag:page', String(line).slice(0, 900));
  } catch (e) {
    // Outside the game (Storybook, a browser): the console is the log
    // eslint-disable-next-line no-console
    console.log('[diag:page]', line);
  }
};

const shouldLog = (kind) => {
  counts[kind] = (counts[kind] || 0) + 1;
  if (counts[kind] <= FIRST_N) { lastAt[kind] = Date.now(); return true; }
  if (Date.now() - (lastAt[kind] || 0) >= THEN_EVERY_MS) { lastAt[kind] = Date.now(); return true; }
  return false;
};

const describe = (el) => {
  if (!el) return 'none';
  const id = el.id ? '#' + el.id : '';
  const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
  return (el.tagName || '?').toLowerCase() + id + cls;
};

// What the browser says is under the pointer, and whether anything in its chain could be swallowing the event
const underPoint = (x, y) => {
  let el = null;
  try { el = document.elementFromPoint(x, y); } catch (e) { return 'elementFromPoint threw'; }
  if (!el) return 'nothing at that point';
  const chain = [];
  let node = el;
  for (let i = 0; i < 6 && node && node !== document.body; i++) {
    let s = {};
    try { s = window.getComputedStyle(node); } catch (e) { s = {}; }
    chain.push(`${describe(node)}[pe=${s.pointerEvents || '?'} z=${s.zIndex || 'auto'} op=${s.opacity || '?'}]`);
    node = node.parentElement;
  }
  return chain.join(' < ');
};

// These lines reach a staff-visible report and the server log, and the question they answer is only "did a keydown
// arrive". So nothing typed is written: a key that produces a character is recorded as "printable" and no more, and
// only keys that produce none are named (Worker A, 2026-09-28).
const keyKind = (e) => {
  let name = '';
  try { name = String(e.key || ''); } catch (err) { return 'key=unreadable'; }
  // A printable key has a single-character `key`; everything else is a named key such as Escape, Tab or ArrowLeft
  if (name.length === 1) return 'key=printable';
  if (!name) return 'key=unnamed';
  return `key=${name}`;
};

const state = () => {
  let active = 'none';
  try { active = describe(document.activeElement); } catch (e) { /* none */ }
  let focus = '?';
  try { focus = String(document.hasFocus()); } catch (e) { /* none */ }
  return `focus=${focus} active=${active}`;
};

// Anything laid over the whole screen that still takes the pointer is the obvious suspect, so it is dumped once
const overlays = () => {
  const out = [];
  let all = [];
  try { all = Array.prototype.slice.call(document.querySelectorAll('body *')); } catch (e) { return 'query failed'; }
  for (const el of all) {
    let s;
    try { s = window.getComputedStyle(el); } catch (e) { continue; }
    if (s.position !== 'fixed' && s.position !== 'absolute') continue;
    if (s.pointerEvents === 'none' || s.display === 'none' || s.visibility === 'hidden') continue;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9) continue;
    out.push(`${describe(el)}[pe=${s.pointerEvents} z=${s.zIndex} op=${s.opacity}]`);
    if (out.length >= 12) break;
  }
  return out.length ? out.join(' | ') : 'none';
};

// MO2's virtual file system changes how files resolve, so whether the menu video actually loaded is worth knowing
const media = () => {
  let vids = [];
  try { vids = Array.prototype.slice.call(document.querySelectorAll('video, audio')); } catch (e) { return 'query failed'; }
  if (!vids.length) return 'no video or audio element';
  return vids.map((v) => {
    const src = (v.currentSrc || v.src || '').split('/').pop() || '(none)';
    // readyState 0 = nothing loaded; networkState 3 = no source could be used
    return `${v.tagName.toLowerCase()} src=${src} ready=${v.readyState} net=${v.networkState} err=${v.error ? v.error.code : 0} paused=${v.paused}`;
  }).join(' | ');
};

export const startInputDiag = (where) => {
  if (on) return;
  on = true;
  for (const k of KINDS) { counts[k] = 0; lastAt[k] = 0; }

  send(`open ${where} ${state()} win=${window.innerWidth}x${window.innerHeight} screen=${(window.screen || {}).width}x${(window.screen || {}).height} dpr=${window.devicePixelRatio}`);
  send(`overlays ${overlays()}`);
  send(`media ${media()}`);

  for (const kind of KINDS) {
    const fn = (e) => {
      if (!shouldLog(kind)) return;
      const n = counts[kind];
      if (kind === 'keydown') {
        send(`${kind} #${n} ${keyKind(e)} ${state()}`);
      } else {
        send(`${kind} #${n} at=${Math.round(e.clientX)},${Math.round(e.clientY)} ${state()} under=${underPoint(e.clientX, e.clientY)}`);
      }
    };
    // Capture, so an element that stops propagation cannot hide the event from this
    document.addEventListener(kind, fn, true);
    listeners.push([kind, fn]);
  }
};

export const stopInputDiag = () => {
  if (!on) return;
  on = false;
  for (const [kind, fn] of listeners) {
    try { document.removeEventListener(kind, fn, true); } catch (e) { /* gone already */ }
  }
  listeners = [];
  send(`closed, counts ${KINDS.map((k) => `${k}=${counts[k] || 0}`).join(' ')}`);
};
