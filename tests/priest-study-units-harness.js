// Scripted test for Priest Studies' panel (server\schools.js): what "This sitting: N units of study" and the level on the
// panel say must be what Priest itself was paid, not the study clock.
//
// #bugs 1556715483414405242 (5 Oct, "it tells me I'm receiving priest xp but I have the same amount when checking";
// "I got 20 minutes reading but it gave me maybe less than half a level") and the launcher report 1557281429686194216
// (7 Oct, "priest book not gaining levels"; Carloft Fhang #A5V7 sat 05:41-05:49 and 06:12-06:19, the panel said 50 and 40
// units). Study Magic pays its school meter one unit every tickSeconds and shows those units; Priest Studies has no meter
// and pays Priest only through the Wheel's cast credit once a minute (about 6.5 Priest units for a full 20 minutes at
// Novice, a third of that per level band higher), yet its panel counted the same tick units (120 for a full sitting).
//
// The mastery system here is a small stand-in: each 'cast' event of the Priest spell pays Priest `PER_CREDIT` units on the
// Wheel's curve (skillPoints.ts), into the level and xp when Priest is held and into the bank (shadow) when it is not;
// `poolFull` pays nothing, as a full Wheel with nothing marked to fall does.
//
//   node tests\priest-study-units-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const SPELLS = path.join(SERVER, 'spells.js');
const SCHOOLS = path.join(SERVER, 'schools.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priest-study-units-'));
process.chdir(dir);
for (const f of ['skills.json', 'spell-tomes.json']) fs.copyFileSync(path.join(SERVER, f), f);
const CONFIG = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));

let wallClock = Date.parse('2026-10-07T05:40:00Z');
Date.now = () => wallClock;
const MIN = 60000, HOUR = 3600000;
const advance = (ms) => { wallClock += ms; };

const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Online Edits.esp': 0x60 };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin'); return `${(id & 0xffffff).toString(16)}:${p}`; };

// The Cathedral of St Martin and its PriestStudy activators (DLE v10), as tests/schools-harness.js has them
const CATHEDRAL = '12cb:BSHeartland.esm';
const PSTUDY_BASE = '16daf4:DragonBreak Online Edits.esp';
const PSTUDY = idOf('16db15:DragonBreak Online Edits.esp');
const HEAL = idOf('12fcc:Skyrim.esm');
const RECORDS = { [idOf(PSTUDY_BASE)]: { type: 'ACTI', editorId: 'PriestStudy', fields: [] } };

const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos || [0, 0, 0]); };
put(PSTUDY, 'baseDesc', PSTUDY_BASE); at(PSTUDY, CATHEDRAL, [0, 0, 0]);

const NOVICE = 0x31, APPRENTICE = 0x32, UNTAKEN = 0x33, FULL = 0x34, OLDSIT = 0x35;
const NAMES = { [NOVICE]: 'Novice', [APPRENTICE]: 'Apprentice', [UNTAKEN]: 'Untaken', [FULL]: 'Full', [OLDSIT]: 'Oldsit' };
const priestAt = (a, level, xp) => {
  const r = props.get(a + '|private.mastery') || { v: 2, skills: {}, order: [] };
  r.skills.priest = { level, xp: xp || 0, rank: level >= 25 ? 1 : 0 };
  if (!r.order.includes('priest')) r.order.push('priest');
  put(a, 'private.mastery', r);
};
for (const a of [NOVICE, APPRENTICE, UNTAKEN, FULL, OLDSIT]) { at(a, CATHEDRAL, [0, 0, 0]); put(a, 'profileId', a); }
priestAt(NOVICE, 12, 0); priestAt(APPRENTICE, 30, 40); priestAt(FULL, 12, 0); priestAt(OLDSIT, 12, 0);

// The Wheel's curve (skillPoints.ts) and a stand-in for masterySystem's credit of Priest Studies' cast events
const XP_BANDS = [[0, 10], [25, 5], [50, 2.5], [75, 1.25], [90, 0.5], [95, 0.25]];
const xpPerUnitAt = (level) => { let x = XP_BANDS[0][1]; for (const [from, per] of XP_BANDS) if (level >= from) x = per; return x; };
const PER_CREDIT = 0.33;
let poolFull = false;
const queue = [];
globalThis.__alduinakMasteryEvent = (kind, a, detail) => queue.push({ kind, a, detail });
const drain = () => {
  for (const ev of queue.splice(0, queue.length)) {
    if (ev.kind !== 'cast' || ev.detail.spellId !== HEAL || poolFull) continue;
    const r = props.get(ev.a + '|private.mastery') || { v: 2, skills: {}, order: [] };
    const p = r.skills.priest || (r.skills.priest = { level: 0, xp: 0 });
    if (!r.order.includes('priest') || !(p.level >= 1)) { p.shadow = (p.shadow || 0) + PER_CREDIT; put(ev.a, 'private.mastery', r); continue; }
    p.xp += PER_CREDIT * xpPerUnitAt(p.level);
    while (p.xp >= 100) { p.xp -= 100; p.level++; }
    put(ev.a, 'private.mastery', r);
  }
};
const unitsOf = (a) => {
  const r = props.get(a + '|private.mastery'); const p = r && r.skills && r.skills.priest;
  if (!p) return 0;
  if (!r.order.includes('priest') || !(p.level >= 1)) return p.shadow || 0;
  let u = 0; for (let l = 0; l < p.level; l++) u += 100 / xpPerUnitAt(l);
  return u + p.xp / xpPerUnitAt(p.level);
};

const known = new Map();
const mp = {
  getIdFromDesc: idOf,
  getDescFromId: descOf,
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    if (cls === 'Debug' && fn === 'SendAnimationEvent') return null;
    const a = idOf(self.desc); const s = known.get(a) || (known.set(a, new Set()), known.get(a));
    if (fn === 'GetSpellCount') return s.size;
    if (fn === 'GetNthSpell') { const id = [...s][args[0]]; return id === undefined ? null : { type: 'espm', desc: descOf(id) }; }
    const spell = idOf(args[0].desc);
    if (fn === 'AddSpell') { if (s.has(spell)) return false; s.add(spell); return true; }
    if (fn === 'RemoveSpell') return s.delete(spell);
    throw new Error('unexpected papyrus ' + fn);
  },
};
mp.onReadBook = () => undefined;
globalThis.__alduinakMasteryFirstTouch = () => 'ok';

let online = [NOVICE, APPRENTICE, UNTAKEN, FULL, OLDSIT];
const out = { widgets: [], closed: [], said: [], audits: [], logs: [] };
const handlers = new Map(), timers = new Map();
const mkApi = (cfg) => ({
  mp, cfg,
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => `${NAMES[a] || 'P'} #TAG${(a & 0xf).toString(16)}`,
  who: (a) => `P${a.toString(16)}`,
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); return true; },
  closeWidget: (a, id) => { out.closed.push([a, id]); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: () => {},
  onlineActors: () => online.slice(),
  every: (name, ms, fn) => timers.set(name, fn),
  distanceMeters: (a, b) => {
    if (props.get(a + '|worldOrCellDesc') !== props.get(b + '|worldOrCellDesc')) return Infinity;
    const p = props.get(a + '|pos'), q = props.get(b + '|pos');
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70;
  },
  sendPacket: () => true,
  isAdmin: () => false,
  findByName: () => null,
  isWorldspace: () => false,
  profileOf: (a) => { const v = props.get(a + '|profileId'); return v === undefined ? -1 : v; },
  takeGold: () => false, giveItem: () => true, depositToTreasury: (z, n) => n,
});
const load = () => {
  handlers.clear();
  const cfg = { spells: Object.assign({}, CONFIG.spells), schools: Object.assign({}, CONFIG.schools, { enabled: true }) };
  delete require.cache[SPELLS]; require(SPELLS)(mkApi(cfg));
  delete require.cache[SCHOOLS]; require(SCHOOLS)(mkApi(cfg));
};
load();

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const ui = (ev, a, args, widgetId) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widgetId || 0));
const panel = (a) => { const l = out.widgets.filter((w) => w.a === a && w.w.id === 75); return l.length ? l[l.length - 1].w : null; };
const sitting = (a) => globalThis.__dboSchoolsState.priestStudying.has(a);
// The server's loop: the gameplay tick enqueues, masterySystem drains between ticks
const tick = () => { timers.get('schools.tick')(); drain(); };
const sit = (a, ms) => { for (let t = 0; t < ms; t += 2000) { advance(2000); tick(); } };
const r1 = (x) => Math.round(x * 10) / 10;
for (const a of online) ui('uiCaps', a, ['bank', 'spellbook', 'schools']);

(async () => {
  // ---- a Novice priest: one minute ----
  check('a PriestStudy activator begins a sitting', globalThis.__dboSchoolsActivate(PSTUDY, NOVICE) === true && sitting(NOVICE) && panel(NOVICE).title === 'Priest Studies', panel(NOVICE));
  const start = unitsOf(NOVICE);
  // The panel redraws every tickSeconds (10 s); a credit enqueued at the 60 s tick is drained before the 70 s redraw
  sit(NOVICE, 72000);
  const paid1 = unitsOf(NOVICE) - start;
  check('a minute in: the Wheel has paid Priest once (the stand-in masterySystem)', Math.abs(paid1 - PER_CREDIT) < 1e-9, paid1);
  check('...and the panel\'s "This sitting" is what Priest was paid (0.3), not the clock\'s seven tick units', panel(NOVICE).mode === 'studying' && panel(NOVICE).gained === r1(paid1), panel(NOVICE));
  check('...and its level shows the part of the level Priest has made (12.0 + 3.3%), the meter likewise', panel(NOVICE).level === 12 && Math.abs(panel(NOVICE).fill - (12 + PER_CREDIT * 10 / 100) / 100) < 1e-6, { level: panel(NOVICE).level, fill: panel(NOVICE).fill });

  // ---- the whole 20 minutes ----
  sit(NOVICE, 20 * MIN);
  const paid = unitsOf(NOVICE) - start;
  check('a full sitting ends by itself at the window', !sitting(NOVICE), sitting(NOVICE));
  const last = out.widgets.filter((w) => w.a === NOVICE && w.w.id === 75 && w.w.mode === 'studying').pop().w;
  check('...the last panel of the sitting showed Priest\'s own pay (about 20 credits), not 120 tick units', last.gained >= r1(paid) - 0.4 && last.gained <= r1(paid) && last.gained < 10, { shown: last.gained, paid });
  check('...and the audit says what Priest was paid as well as the time', out.audits.some((l) => /SCHOOLS P31 stopped Priest Studies \(budget\): 120 units, Priest \+6\.\d units/.test(l)), out.audits.filter((l) => /P31 stopped/.test(l)));
  check('...a whole level is not reached at Novice: the level shown is 12 and some, never 13', last.level >= 12 && last.level < 13, last.level);

  // ---- an Apprentice (Priest 30, 40 xp): the fraction is shown, the units are Priest's ----
  globalThis.__dboSchoolsActivate(PSTUDY, APPRENTICE);
  check('Priest 30 with 40 xp: the panel shows 30.4', panel(APPRENTICE).level === 30.4 && panel(APPRENTICE).gained === 0, panel(APPRENTICE));
  const a0 = unitsOf(APPRENTICE);
  sit(APPRENTICE, 3 * MIN + 12000);
  check('three minutes in: three credits, shown as Priest units', panel(APPRENTICE).gained === r1(unitsOf(APPRENTICE) - a0) && panel(APPRENTICE).gained === 1, { shown: panel(APPRENTICE).gained, paid: unitsOf(APPRENTICE) - a0 });
  ui('priestStudyStop', APPRENTICE, [panel(APPRENTICE).nonce]);
  check('Close the books: the audit says Priest +1 units', out.audits.some((l) => /SCHOOLS P32 stopped Priest Studies \(stopped\): 19 units, Priest \+1 units/.test(l)), out.audits.filter((l) => /P32 stopped/.test(l)));

  // ---- Priest not taken up: the Wheel banks it ----
  globalThis.__dboSchoolsActivate(PSTUDY, UNTAKEN);
  sit(UNTAKEN, 2 * MIN + 12000);
  check('Priest not taken up: the panel shows the banked work, still "Not yet taken up" at 0', panel(UNTAKEN).rank === 'Not yet taken up' && panel(UNTAKEN).level === 0 && panel(UNTAKEN).gained === r1(2 * PER_CREDIT), panel(UNTAKEN));
  ui('priestStudyClose', UNTAKEN);

  // ---- a full Wheel (nothing marked to fall): nothing paid, nothing shown ----
  poolFull = true;
  globalThis.__dboSchoolsActivate(PSTUDY, FULL);
  sit(FULL, 5 * MIN);
  check('a full Wheel pays Priest nothing, and the panel says 0 rather than 30 units', panel(FULL).gained === 0 && panel(FULL).level === 12, panel(FULL));
  ui('priestStudyClose', FULL);
  poolFull = false;

  // ---- a sitting from before the reload (no starting mark): it starts counting from the reload ----
  globalThis.__dboSchoolsActivate(PSTUDY, OLDSIT);
  sit(OLDSIT, 2 * MIN + 4000);
  delete globalThis.__dboSchoolsState.priestStudying.get(OLDSIT).priestFrom;
  load();
  const o0 = unitsOf(OLDSIT);
  sit(OLDSIT, MIN + 12000);
  check('a hot reload keeps an older sitting, which counts Priest\'s pay from the reload on', sitting(OLDSIT) && panel(OLDSIT).gained === r1(unitsOf(OLDSIT) - o0) && panel(OLDSIT).gained > 0, { shown: panel(OLDSIT).gained, since: unitsOf(OLDSIT) - o0 });
  ui('priestStudyClose', OLDSIT);

  console.log(`\n${checks - failures}/${checks} passed`);
  process.chdir(os.tmpdir());
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
