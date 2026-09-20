// Temporary diagnostic: per-player movement speed measured from the server's own accepted positions.
// Feeds the ceiling for the C++ movement rate check. Delete with its require block in gamemode.js after.
// /mv <label> tags what you are doing, /mv report prints the maxima, /mv off stops tracing you.
// Only players who ran /mv are sampled, so the tick is free when nobody is tracing.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve('_diagnostics');
const OUT_FILE = path.join(OUT_DIR, 'movetrace.json');
const SAMPLE_MS = 20;
const WINDOWS = [0.25, 0.5, 1, 2];
const TELEPORT_JUMP = 1500; // no legitimate single sample moves this far
const SETTLE_MS = 8000; // how long a teleport is watched for in-flight packets and the client's settle

const newStats = () => ({
  steps: 0,
  maxStep: { d: 0, dt: 0, speed: 0 },
  maxUp: { d: 0, dt: 0, speed: 0 },
  maxDown: { d: 0, dt: 0, speed: 0 },
  maxGapMs: 0,
  win: Object.fromEntries(WINDOWS.map(w => [w, { xy: 0, up: 0, down: 0 }])),
  teleports: [],
});

module.exports = ({ mp, log, personal, display, registerChatCommand, every }) => {
  const ST = globalThis.__dboMoveTrace || (globalThis.__dboMoveTrace = {
    labels: new Map(), // label -> stats
    tracks: new Map(), // actorId -> live track
    label: new Map(), // actorId -> current label
    dirty: false,
    lastLog: new Map(),
  });

  const statsFor = (label) => {
    let s = ST.labels.get(label);
    if (!s) ST.labels.set(label, s = newStats());
    return s;
  };
  const labelOf = (a) => ST.label.get(a) || 'unlabelled';

  const noteMax = (slot, d, dt) => {
    const speed = dt > 0 ? d / dt : 0;
    if (speed > slot.speed) { slot.d = d; slot.dt = dt; slot.speed = speed; }
  };

  const forget = (a) => { ST.label.delete(a); ST.tracks.delete(a); ST.lastLog.delete(a); };

  // Only actors that asked for it with /mv are sampled, so the tick costs nothing
  // when nobody is tracing and never scales with a full server or a bot run
  const sample = () => {
    if (!ST.label.size) return;
    const now = performance.now();
    for (const a of [...ST.label.keys()]) {
      let pos, cell;
      try { pos = mp.get(a, 'pos'); cell = String(mp.get(a, 'worldOrCellDesc') || ''); } catch (e) { forget(a); continue; }
      if (!Array.isArray(pos)) continue;
      let tr = ST.tracks.get(a);
      if (!tr) { ST.tracks.set(a, { t: now, pos, cell, hist: [] }); continue; }

      if (tr.tp && now - tr.tp.at < SETTLE_MS) {
        const from = tr.tp.to;
        const away = Math.hypot(pos[0] - from[0], pos[1] - from[1], pos[2] - from[2]);
        if (away > tr.tp.settle) tr.tp.settle = away;
        const back = Math.hypot(pos[0] - tr.tp.from[0], pos[1] - tr.tp.from[1], pos[2] - tr.tp.from[2]);
        if (back < 256) tr.tp.returned = true;
      }

      if (pos[0] === tr.pos[0] && pos[1] === tr.pos[1] && pos[2] === tr.pos[2] && cell === tr.cell) continue;

      const dt = (now - tr.t) / 1000;
      const dxy = Math.hypot(pos[0] - tr.pos[0], pos[1] - tr.pos[1]);
      const dz = pos[2] - tr.pos[2];
      const st = statsFor(labelOf(a));

      if (cell !== tr.cell || Math.hypot(dxy, dz) > TELEPORT_JUMP) {
        if (tr.tp) st.teleports.push({ jump: Math.round(tr.tp.jump), cellChanged: tr.tp.cellChanged, resumeMs: tr.tp.resumeMs, settle: Math.round(tr.tp.settle), returned: !!tr.tp.returned, label: tr.tp.label });
        tr.tp = { at: now, from: tr.pos, to: pos, jump: Math.hypot(dxy, dz), cellChanged: cell !== tr.cell, settle: 0, resumeMs: null, label: labelOf(a) };
        log(`movetrace ${display(a)} teleport: ${Math.round(Math.hypot(dxy, dz))} units${cell !== tr.cell ? ` cell ${tr.cell} -> ${cell}` : ''} (${labelOf(a)})`);
        tr.hist.length = 0;
        tr.t = now; tr.pos = pos; tr.cell = cell;
        ST.dirty = true;
        continue;
      }

      if (tr.tp && tr.tp.resumeMs === null) tr.tp.resumeMs = Math.round(now - tr.tp.at);

      st.steps++;
      if (now - tr.t > st.maxGapMs) st.maxGapMs = Math.round(now - tr.t);
      noteMax(st.maxStep, dxy, dt);
      if (dz > 0) noteMax(st.maxUp, dz, dt); else if (dz < 0) noteMax(st.maxDown, -dz, dt);

      tr.hist.push({ t: now, d: dxy, up: dz > 0 ? dz : 0, down: dz < 0 ? -dz : 0 });
      const oldest = now - WINDOWS[WINDOWS.length - 1] * 1000;
      while (tr.hist.length && tr.hist[0].t < oldest) tr.hist.shift();

      let improved = false;
      for (const w of WINDOWS) {
        const since = now - w * 1000;
        let xy = 0, up = 0, down = 0;
        for (const h of tr.hist) if (h.t > since) { xy += h.d; up += h.up; down += h.down; }
        const slot = st.win[w];
        if (xy / w > slot.xy) { slot.xy = xy / w; improved = true; }
        if (up / w > slot.up) slot.up = up / w;
        if (down / w > slot.down) slot.down = down / w;
      }

      tr.t = now; tr.pos = pos; tr.cell = cell;
      ST.dirty = true;

      if (improved) {
        const last = ST.lastLog.get(a) || 0;
        if (now - last > 2000) {
          ST.lastLog.set(a, now);
          const w1 = st.win[1], w025 = st.win[0.25];
          log(`movetrace ${display(a)} ${labelOf(a)}: xy/s max ${Math.round(w025.xy)} (0.25 s) ${Math.round(w1.xy)} (1 s), step ${Math.round(st.maxStep.d)} in ${Math.round(st.maxStep.dt * 1000)} ms, up ${Math.round(st.win[1].up)}, down ${Math.round(st.win[1].down)}`);
        }
      }
    }
  };

  const report = (label) => {
    const s = ST.labels.get(label);
    if (!s) return `${label}: nothing recorded`;
    const w = (k) => WINDOWS.map(x => `${x}s ${Math.round(s.win[x][k])}`).join(' ');
    return `${label}: ${s.steps} steps, xy/s ${w('xy')} | up/s ${w('up')} | down/s ${w('down')} | biggest step ${Math.round(s.maxStep.d)} u in ${Math.round(s.maxStep.dt * 1000)} ms (${Math.round(s.maxStep.speed)} u/s), gap ${s.maxGapMs} ms, teleports ${s.teleports.length}`;
  };

  const write = () => {
    if (!ST.dirty) return;
    ST.dirty = false;
    const doc = { written: new Date().toISOString(), sampleMs: SAMPLE_MS, windows: WINDOWS, labels: Object.fromEntries([...ST.labels.entries()]) };
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const tmp = `${OUT_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, OUT_FILE);
    } catch (e) { log('movetrace write failed:', e.message); }
  };

  registerChatCommand('mv', (a, args) => {
    const arg = String(args || '').trim().toLowerCase();
    if (!arg) return personal(a, `Recording as "${labelOf(a)}". ${report(labelOf(a))}`);
    if (arg === 'report') {
      personal(a, `movetrace, ${ST.labels.size} labels:`);
      for (const label of ST.labels.keys()) personal(a, report(label));
      write();
      return;
    }
    if (arg === 'reset') { ST.labels.clear(); ST.tracks.clear(); ST.dirty = true; write(); return personal(a, 'movetrace cleared.'); }
    if (arg === 'off') { forget(a); log(`movetrace ${display(a)} stopped recording`); return personal(a, `Stopped recording. ${ST.label.size} player(s) still traced.`); }
    ST.label.set(a, arg);
    statsFor(arg);
    log(`movetrace ${display(a)} now recording as "${arg}"`);
    personal(a, `Recording as "${arg}". Do the movement, then /mv <next label>.`);
  }, { admin: true, help: 'movement speed recorder: /mv <label>, /mv report, /mv off, /mv reset' });

  every('moveTrace', SAMPLE_MS, sample);
  every('moveTraceWrite', 5000, write);
  log('movetrace loaded: /mv <label> to record');
};
