// Page heartbeat, for the MO2 players stuck at character select with neither mouse nor keyboard (2026-09-28). Both
// dying at once is what a hung page or renderer looks like, so this answers the question directly: if the beat stops,
// the page stopped; if it keeps coming while the player says nothing responds, the page is alive and the fault is
// somewhere between the engine and it.
//
// Starts when the front loads and runs for the whole session. One beat every 2 s, and every fifth beat a line about
// the main thread's own health: how far the 2 s timer has drifted, and whether a requestAnimationFrame has fired
// since the last beat (a renderer that has stopped painting still runs timers, so the two differ).
//
// Logging only. Lines go out as a `diag:page` browser message, deliberately not a `dbo:` one so DboRelayService does
// not forward them to the server; the client writes them into skyrim-platform.log, which Report a Problem collects.

const BEAT_MS = 2000;
const LAG_EVERY = 5; // a lag line every fifth beat, so every 10 s

let started = false;
let beats = 0;
let rafSinceBeat = 0;
let expectedAt = 0;
let worstDriftMs = 0;

const send = (line) => {
  try {
    window.skyrimPlatform.sendMessage('diag:page', String(line).slice(0, 900));
  } catch (e) {
    // Outside the game the console is the log
    // eslint-disable-next-line no-console
    console.log('[diag:page]', line);
  }
};

const widgetIds = () => {
  try {
    const list = window.skyrimPlatform.widgets.get() || [];
    return list.map((w) => `${w.id}:${w.type}`).join(',') || 'none';
  } catch (e) {
    return 'unreadable';
  }
};

const countRaf = () => {
  try {
    window.requestAnimationFrame(() => { rafSinceBeat++; countRaf(); });
  } catch (e) { /* no rAF: the lag line will say raf=0 */ }
};

export const startPageHeartbeat = () => {
  if (started) return;
  started = true;
  countRaf();
  expectedAt = (window.performance && performance.now ? performance.now() : Date.now()) + BEAT_MS;

  setInterval(() => {
    const now = window.performance && performance.now ? performance.now() : Date.now();
    // How late this beat is: the main thread was busy or stalled for that long
    const drift = Math.round(now - expectedAt);
    expectedAt = now + BEAT_MS;
    if (drift > worstDriftMs) worstDriftMs = drift;
    beats++;

    send(`beat ${beats} t=${Math.round(now)} widgets=${widgetIds()}`);

    if (beats % LAG_EVERY === 0) {
      send(`lag beat=${beats} drift=${drift}ms worst=${worstDriftMs}ms raf=${rafSinceBeat} since the last beat`);
      worstDriftMs = 0;
    }
    rafSinceBeat = 0;
  }, BEAT_MS);
};
