// /appearance (appearance.js): a player reopens the appearance editor for gold; race, sex and name are kept, the gold is
// taken only for a changed look, once per cooldown, and never while busy. Stub mp, the real module.
// Also the head guard (7 Oct): RaceMenu reopened on an existing non-Nord character puts the Nord default head on them;
// the head from before goes back, a head-only swap costs nothing, and the look is written again after the client's
// settle window. Real head ids from the affected characters' saved looks (backups 4-6 Oct, live 7 Oct), names left out.
// And a GM's /chargen on an existing character, which gets the same head guard, as does a patron's reroll (its snapshot
// rules here; the whole reroll close in appearance-reroll-harness.js). Review fixes, 8 Oct: a saved head that is no race's
// default is never swapped for the race's vanilla one; the settled write sends the newest stored look, since the client
// drops every write to its own look in the window. Second review, 8 Oct: the head a high-poly look lost is found by its
// record's type (HDPT PNAM 1, Face), a beast form taken in the window gets no settled write, editing() holds through the
// client's settle window after a close, and /appearance waits while a forced werewolf change is coming.
//   node tests/appearance-command-harness.js   (from server/)
'use strict';
const path = require('path');
const MOD = path.resolve(__dirname, '..', 'appearance.js');
let fails = 0;
const ok = (c, label, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${label}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const A = 0xff000101;
let props, said, sys, audits, cmds, opened, timers, user, writes, retakes;
// The clock, moved on by hand past the client's settle window after a close
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const settleWindow = () => { skew += 4000; };
// Head part records (HDPT PNAM: 1 Face, 2 Eyes, 3 Hair) when a check gives them; null: no record can be read
let hdpt = null;
const u32le = (n) => new Uint8Array(new Uint32Array([n]).buffer);
const lookupEspmRecordById = (id) => {
  if (!hdpt) throw new Error('no record');
  const t = hdpt.get(id >>> 0);
  return t === undefined ? { record: null } : { record: { type: 'HDPT', fields: [{ type: 'DATA', data: u32le(0) }, { type: 'PNAM', data: u32le(t) }] } };
};
const look = () => ({ raceId: 0x13746, isFemale: false, name: 'Brand Stoneborn', weight: 50, skinColor: 1, hairColor: 2, headpartIds: [1, 2], headTextureSetId: 3, options: [0], presets: [0], tints: [] });
const reset = (gold, start) => {
  props = new Map([[`${A}|inventory`, { entries: [{ baseId: 0xf, count: gold }, { baseId: 0x1d4ec, count: 1 }] }]]);
  if (start !== null) props.set(`${A}|appearance`, start === undefined ? look() : start);
  said = []; sys = []; audits = []; cmds = new Map(); opened = 0; timers = []; user = 3; writes = []; retakes = [];
  delete require.cache[MOD];
  globalThis.__dboCombatAt = new Map(); globalThis.__dboIsDowned = null; globalThis.__dboBeastOriginalRace = null; globalThis.__dboDungeonCells = new Set();
  globalThis.__dboTellsRetake = (a, before) => retakes.push([a, before]);
  globalThis.__dboFeralDue = new Map();
  return require(MOD)({
    mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => { if (k === 'appearance') writes.push(JSON.parse(JSON.stringify(v))); props.set(`${id}|${k}`, v); }, setRaceMenuOpen: () => { opened++; }, lookupEspmRecordById },
    log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => sys.push(t), audit: (t) => audits.push(t), who: () => 'Brand',
    registerChatCommand: (n, fn) => cmds.set(n, fn), cfg: { appearance: { cost: 500, cooldownHours: 24 } },
    userOf: () => user, profileOf: () => 7, later: (fn, ms) => timers.push({ fn, ms }),
  });
};
const gold = () => props.get(`${A}|inventory`).entries.filter((e) => e.baseId === 0xf).reduce((s, e) => s + e.count, 0);
const run = () => cmds.get('appearance')(A, '');
// The engine stores an allowed editor result before the hook hears of it (ActionListener::OnUpdateAppearance)
const engineStores = (app) => { if (app && typeof app === 'object') props.set(`${A}|appearance`, JSON.parse(JSON.stringify(app))); };
const finish = (app) => { engineStores(app); return globalThis.__dboAppearanceEdit.finish(A, app); };

// 1. Open, change the hair, save: 500 gold, cooldown set, audited
let m = reset(800);
run();
ok(opened === 1 && globalThis.__dboAppearanceEdit.pending(A), 'the command opens the editor and marks the edit pending on the character');
ok(/costs 500 gold/.test(said.at(-1)) && /race, sex and name stay/.test(said.at(-1)), 'the player is told the price and what stays', said.at(-1));
let after = Object.assign(look(), { hairColor: 9 });
ok(finish(after) === true && gold() === 300, 'a changed look is saved for 500 gold', gold());
ok(!globalThis.__dboAppearanceEdit.pending(A) && Number(props.get(`${A}|private.dboAppearanceAt`)) > 0, 'the edit is closed and the cooldown starts');
ok(audits.some((t) => /changed their look for 500 gold/.test(t)), 'audited', audits);

// 2. Cooldown
said = []; run();
ok(opened === 1 && /again in/.test(said.at(-1)), 'a second use within 24 hours is refused', said.at(-1));

// 3. Closing unchanged costs nothing
m = reset(800); run(); finish(look());
ok(gold() === 800 && /unchanged, so nothing was charged/.test(sys.at(-1)) && !props.get(`${A}|private.dboAppearanceAt`), 'an unchanged look costs nothing and starts no cooldown', sys.at(-1));

// 4. Race and sex are kept: the old look goes back, nothing charged
m = reset(800); run(); finish(Object.assign(look(), { raceId: 0x13745, hairColor: 9 }));
ok(gold() === 800 && props.get(`${A}|appearance`).raceId === 0x13746 && props.get(`${A}|appearance`).hairColor === 2 && /Race can't be changed/.test(sys.at(-1)), 'a race change puts the previous look back and charges nothing', sys.at(-1));
m = reset(800); run(); finish(Object.assign(look(), { isFemale: true }));
ok(gold() === 800 && props.get(`${A}|appearance`).isFemale === false && /Sex can't be changed/.test(sys.at(-1)), 'so does a sex change');

// 5. The name is kept, the rest of the new look stays and is paid for
m = reset(800); run(); finish(Object.assign(look(), { name: 'Brandy', hairColor: 9 }));
ok(gold() === 300 && props.get(`${A}|appearance`).name === 'Brand Stoneborn' && props.get(`${A}|appearance`).hairColor === 9 && /name stays the same/.test(sys.at(-1)), 'a renamed look keeps the old name and the new hair', props.get(`${A}|appearance`));

// 6. Not enough gold: refused before opening; gold spent meanwhile: previous look back
m = reset(100); said = []; run();
ok(opened === 0 && /costs 500 gold. You have 100/.test(said.at(-1)), 'not enough gold: the editor does not open', said.at(-1));
m = reset(800); run(); props.set(`${A}|inventory`, { entries: [{ baseId: 0xf, count: 20 }] }); finish(Object.assign(look(), { hairColor: 9 }));
ok(props.get(`${A}|appearance`).hairColor === 2 && /no longer have 500 gold/.test(sys.at(-1)), 'gold spent while editing: the previous look is kept', sys.at(-1));

// 7. Busy states refuse
const refused = (setup, re, label) => { reset(800); setup(); said = []; run(); ok(opened === 0 && re.test(said.at(-1) || ''), label, said.at(-1)); };
refused(() => globalThis.__dboCombatAt.set(A, Date.now() - 5000), /fight/, 'refused in a fight');
refused(() => { globalThis.__dboIsDowned = (a) => a === A; }, /down/, 'refused while down');
refused(() => { globalThis.__dboBeastOriginalRace = () => 0x13746; }, /beast form/, 'refused in a beast form');
refused(() => props.set(`${A}|private.dboSentence`, { until: Date.now() + 60000 }), /jail/, 'refused in jail');
refused(() => props.set(`${A}|private.restrained`, true), /bound/, 'refused while bound');
refused(() => { props.set(`${A}|worldOrCellDesc`, '1234:Skyrim.esm'); globalThis.__dboDungeonCells = new Set(['1234:skyrim.esm']); }, /dungeon/, 'refused inside a dungeon');
refused(() => props.set(`${A}|private.creationPending`, true), /Finish making/, 'refused during character creation');
refused(() => props.set(`${A}|private.dboAppearanceEdit`, { at: 1, before: look() }), /already open/, 'refused while an edit is already pending');
// A forced werewolf change warned and on its way (supernatural.js __dboFeralDue): an editor opened now only held it, and a
// close with no change is free, so it was a way to skip the change (second review, 8 Oct)
refused(() => globalThis.__dboFeralDue.set(A, Date.now() + 30000), /beast is coming/, 'refused while a forced beast change is coming');
refused(() => globalThis.__dboFeralDue.set(A, Date.now() + 2000 - 45000), /beast is coming/, '...also one held past its due time a moment ago');
reset(800); globalThis.__dboFeralDue.set(A, Date.now() - 120000); said = []; run();
ok(opened === 1, 'a due time two minutes past is a leftover: the editor opens', said.at(-1));

// 8. Not ours: finish ignores an actor with no pending edit (creation and GM /chargen keep their own path)
reset(800);
ok(globalThis.__dboAppearanceEdit.finish(A, look()) === false && gold() === 800, 'no pending edit: finish leaves it to creation and /chargen');

// 9. gamemode.js routes a pending edit to appearance.js before any creation step
const src = require('fs').readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const hook = src.slice(src.indexOf('const appearanceHook ='), src.indexOf('appearanceHook.__dbo = true'));
ok(hook.indexOf('__dboAppearanceEdit.pending') > 0 && hook.indexOf('__dboAppearanceEdit.pending') < hook.indexOf('moveToHubWhenReady') && /require\(APPEARANCE_JS\)/.test(src), 'gamemode.js hands a pending edit to appearance.js before creation\'s steps');

// 10. The head guard. Looks as saved (ids from the affected characters; names left out)
const NORD_M = 0x5162f, NORD_F = 0x51623;
const char = (raceId, isFemale, headpartIds, extra) => Object.assign(look(), { raceId, isFemale, headpartIds }, extra || {});
const stored = () => props.get(`${A}|appearance`);
const parts = (x) => x.headpartIds.map((h) => h.toString(16)).join(' ');
const edit = (start, after, gold) => { reset(gold === undefined ? 800 : gold, start); run(); timers = []; writes = []; audits = []; return finish(after); };
// A Breton man (4 Oct look): the editor took his head (51633) out and put the Nord one in a later slot, nothing else
const bretonM = () => char(0x13741, false, [0x51633, 0x51631, 0x8555f, 0x220064cb, 0x24238, 0x1e0adc53, 0x1e0adc52, 0x20001d96, 0x1f005451], { skinColor: 13021352 });
const swapOnly = char(0x13741, false, [0x51631, 0x8555f, 0x220064cb, 0x24238, 0x1e0adc53, 0x1e0adc52, 0x20001d96, 0x1f005451, NORD_M], { skinColor: 13021352 });
edit(bretonM(), swapOnly);
ok(gold() === 800 && !props.get(`${A}|private.dboAppearanceAt`), 'a head-only swap costs nothing and starts no cooldown', gold());
ok(JSON.stringify(stored()) === JSON.stringify(bretonM()), 'the look from before is stored, head in its old slot', parts(stored()));
ok(/unchanged, so nothing was charged/.test(sys.at(-1)) && /another race's face; your own was kept/.test(sys.at(-1)), 'the player is told the look is unchanged and why', sys.at(-1));
ok(audits.some((t) => t === "APPEARANCE Brand editor swapped in Nord's default head; kept their own"), 'audited', audits);
ok(retakes.length === 0, 'an unchanged look is no new look for the tells');
// The settle window: the corrected look again once the client applies echoes
ok(timers.length === 1 && timers[0].ms === 3500 && writes.length === 1, 'written at once and once more after 3.5 s', timers.map((t) => t.ms));
timers[0].fn();
ok(writes.length === 2 && JSON.stringify(writes[1]) === JSON.stringify(bretonM()), 'the second write is the corrected look', writes.length);
// The client's settle window is still 3 s (the fork's client, when there is one)
const fork = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const rs = path.join(fork, 'skymp5-client/src/services/services/remoteServer.ts');
const settle = require('fs').existsSync(rs) ? Number((require('fs').readFileSync(rs, 'utf8').match(/const RACE_MENU_SETTLE_MS = (\d+)/) || [])[1]) : NaN;
ok(!Number.isFinite(settle) || (settle < 3500 && settle >= 2000), `the write lands after the client's RACE_MENU_SETTLE_MS (${Number.isFinite(settle) ? settle : 'no client here'})`, settle);

// The same edit with the hair changed too: paid, the new hair kept, the head put back
const swapHair = Object.assign(JSON.parse(JSON.stringify(swapOnly)), { hairColor: 9 });
edit(bretonM(), swapHair);
ok(gold() === 300 && stored().hairColor === 9 && stored().headpartIds.includes(0x51633) && !stored().headpartIds.includes(NORD_M), 'a real edit with the swap: paid, the new hair kept, their own head back', parts(stored()));
ok(/new look is saved. 500 gold paid. The editor had given you another race's face/.test(sys.at(-1)), 'and told', sys.at(-1));
ok(retakes.length === 1 && retakes[0][1].skinColor === 13021352, 'a paid save hands the new look to the tells, with the look before');
ok(timers.length === 1, 'the corrected look is sent again after the settle window');

// Real pairs. 303 (Breton man, 4 Oct -> 6 Oct): hair, scars and skin changed, head swapped
edit(bretonM(), char(0x13741, false, [0x51631, 0x8555f, 0x1e0adc53, 0x1e0adc52, 0x1f005451, NORD_M, 0x20001d96, 0x21008a33], { skinColor: 7364950 }));
ok(parts(stored()) === '51633 51631 8555f 1e0adc53 1e0adc52 1f005451 20001d96 21008a33' && stored().skinColor === 7364950 && gold() === 300, 'a Breton man: own head back in slot 0, the rest of the edit kept and paid', parts(stored()));
// 30e7 (Dark Elf man, 4 Oct -> 6 Oct): parts reordered, skin changed
edit(char(0x13742, false, [0x51631, 0xc716f, 0xec3b3, 0xec1b5, 0xc3cd8, 0x5162c, 0x2200cd45, 0xe4e2c, 0xe4dca], { skinColor: 5398635 }),
  char(0x13742, false, [0x51631, 0xe4e2c, 0xe4dca, 0xec3b3, 0xec1b5, 0xc3cd8, 0x2200cd45, 0xc716f, NORD_M], { skinColor: 8755875 }));
ok(stored().headpartIds.includes(0x5162c) && !stored().headpartIds.includes(NORD_M) && stored().headpartIds.length === 9 && gold() === 300, 'a Dark Elf man: own head back', parts(stored()));
// The same without the skin change: only reordered and swapped, so unchanged and free
edit(char(0x13742, false, [0x51631, 0xc716f, 0xec3b3, 0xec1b5, 0xc3cd8, 0x5162c, 0x2200cd45, 0xe4e2c, 0xe4dca], { skinColor: 5398635 }),
  char(0x13742, false, [0x51631, 0xe4e2c, 0xe4dca, 0xec3b3, 0xec1b5, 0xc3cd8, 0x2200cd45, 0xc716f, NORD_M], { skinColor: 5398635 }));
ok(gold() === 800 && /unchanged/.test(sys.at(-1)) && parts(stored()) === '51631 c716f ec3b3 ec1b5 c3cd8 5162c 2200cd45 e4e2c e4dca', 'parts only reordered plus the swap: unchanged, free, the look from before stored', parts(stored()));
// 17 (Breton woman, 4 Oct -> 5 Oct): the female Nord head
edit(char(0x13741, true, [0x1e015c9f, 0x51621, 0x5150f, 0xec1b2, 0x1f002e2b, 0x2100b05b, 0x1e084999, 0x1e084998]),
  char(0x13741, true, [0x1e015c9f, 0x5150f, 0xec1b2, 0x220064b7, 0x1f002e2b, NORD_F, 0x1e09f8d7, 0x1e09f8d6]));
ok(parts(stored()) === '1e015c9f 51621 5150f ec1b2 220064b7 1f002e2b 1e09f8d7 1e09f8d6', 'a Breton woman: own head (51621) back in slot 1', parts(stored()));
// 4cb (a Dark Elf woman turned vampire, DarkElfRaceVampire 8883d, 5 Oct -> 6 Oct): the vampire race wears the Dark Elf heads
edit(char(0x8883d, true, [0x5150f, 0x5161c, 0xec1b2, 0x1e0ab0ae, 0x1e0ab0ad, 0x1e08340d, 0x7291e, 0xe4d7c], { skinColor: 11186614 }),
  char(0x8883d, true, [0x5150f, 0xec1b2, 0x1e0ab0ae, 0x1e0ab0ad, 0x1e08340d, 0x2006f90, 0xe4d7c, NORD_F], { skinColor: 8958406 }));
ok(parts(stored()) === '5150f 5161c ec1b2 1e0ab0ae 1e0ab0ad 1e08340d 2006f90 e4d7c' && audits.some((t) => /swapped in Nord's default head/.test(t)), 'a Dark Elf vampire woman: own head back, her new eyes kept', parts(stored()));
ok(retakes.length === 1, '...and her new look goes to the tells');

// No false fire
const noFire = (label, start, after) => { edit(start, after); ok(!audits.some((t) => /swapped in/.test(t)) && JSON.stringify(stored()) === JSON.stringify(after) && gold() === 300, label, parts(stored())); };
noFire('a Nord keeps the Nord head (hair changed)', char(0x13746, false, [NORD_M, 0x51631, 0x8555f]), char(0x13746, false, [0x51631, 0x8555f, NORD_M], { hairColor: 9 }));
noFire('an Orc who kept the Orc head (5162a, in a later slot)', char(0x13747, false, [0x5162a, 0x51631, 0x8555f]), char(0x13747, false, [0x51631, 0x8555f, 0x5162a], { hairColor: 9 }));
noFire('a Breton who chose a head that is no race default', bretonM(), char(0x13741, false, [0x22001234, 0x51631, 0x8555f, 0x220064cb, 0x24238, 0x1e0adc53, 0x1e0adc52, 0x20001d96, 0x1f005451], { skinColor: 13021352 }));
noFire('a Breton man given the Breton woman\'s head (his own race\'s)', bretonM(), char(0x13741, false, [0x51621, 0x51631, 0x8555f, 0x220064cb, 0x24238, 0x1e0adc53, 0x1e0adc52, 0x20001d96, 0x1f005451], { skinColor: 13021352 }));
noFire('a Nord head already there before (an older swap) is left alone', char(0x13741, false, [0x51631, 0x8555f, NORD_M]), char(0x13741, false, [0x51631, 0x8555f, NORD_M], { hairColor: 9 }));
noFire('a race not in the table (Falmer) is never guarded', char(0x131f4, false, [0x51631, 0x8555f]), char(0x131f4, false, [0x51631, 0x8555f, NORD_M], { hairColor: 9 }));
// A saved head that is no race's default (a high-poly head, 37000800): the one part the editor took out goes back, never the
// race's vanilla head, and an edit that only swapped it is unchanged and free
const hiPoly = () => char(0x13741, false, [0x37000800, 0x51631, 0x8555f], { skinColor: 13021352 });
edit(hiPoly(), char(0x13741, false, [0x51631, 0x8555f, NORD_M], { skinColor: 13021352 }));
ok(JSON.stringify(stored()) === JSON.stringify(hiPoly()) && gold() === 800 && !props.get(`${A}|private.dboAppearanceAt`), 'a high-poly head swapped for the Nord one: their own back in its slot, unchanged, free', parts(stored()));
ok(/unchanged, so nothing was charged/.test(sys.at(-1)) && /your own was kept/.test(sys.at(-1)) && !stored().headpartIds.includes(0x51633), 'told the truth: their own head was kept (not the Breton vanilla one)', sys.at(-1));
edit(hiPoly(), char(0x13741, false, [0x37000800, 0x51631, 0x8555f, NORD_M], { skinColor: 13021352 }));
ok(JSON.stringify(stored()) === JSON.stringify(hiPoly()) && gold() === 800, 'the Nord head only added beside their own: it goes, no second face, free', parts(stored()));
edit(hiPoly(), char(0x13741, false, [0x51631, 0x8555f, NORD_M], { skinColor: 13021352, hairColor: 9 }));
ok(parts(stored()) === '37000800 51631 8555f' && stored().hairColor === 9 && gold() === 300, 'a real edit over a high-poly head: paid, their own head back', parts(stored()));
edit(hiPoly(), char(0x13741, false, [0x8555f, 0x22000777, NORD_M], { skinColor: 13021352 }));
ok(!audits.some((t) => /kept their own/.test(t)) && parts(stored()) === '8555f 22000777 5162f', 'two parts taken out of a look with no default head, no records: no telling which was the head, nothing guessed', parts(stored()));
ok(audits.some((t) => t === "APPEARANCE Brand editor swapped in Nord's default head, but their own could not be told from the other parts changed; saved as made, check it"), '...and audited for staff', audits);
// Second review, 8 Oct. No records: a part replaced beside a Nord head only added is no head (it was put back as one)
edit(char(0x13741, false, [0x2200aaaa, 0x51631, 0x8555f]), char(0x13741, false, [0x2200aaaa, NORD_M, 0x51632, 0x8555f]));
ok(parts(stored()) === '2200aaaa 5162f 51632 8555f' && !stored().headpartIds.includes(0x51631) && audits.some((t) => /could not be told/.test(t)), 'no records, a new hair beside an added Nord head: the old hair is not put back as the head', parts(stored()));
// With the records (the server's): the Face part taken out is the head, whatever else changed
hdpt = new Map([[0x37000800, 1], [0x2200aaaa, 1], [0x51631, 3], [0x51632, 3], [0x22000999, 3], [0x22000777, 3], [0x8555f, 2], [NORD_M, 1]]);
edit(hiPoly(), char(0x13741, false, [0x22000999, 0x8555f, NORD_M], { skinColor: 13021352 }));
ok(parts(stored()) === '37000800 22000999 8555f' && gold() === 300 && /another race's face; your own was kept/.test(sys.at(-1)) && audits.some((t) => /kept their own$/.test(t)), 'records: a high-poly head and the hair both changed by the editor: their own head back, the new hair kept, paid and told', parts(stored()));
edit(char(0x13741, false, [0x2200aaaa, 0x51631, 0x8555f]), char(0x13741, false, [0x2200aaaa, NORD_M, 0x51632, 0x8555f]));
ok(parts(stored()) === '2200aaaa 51632 8555f' && gold() === 300, 'records: a new hair beside an added Nord head: the Nord head goes, the new hair stays, no second hair', parts(stored()));
edit(hiPoly(), char(0x13741, false, [0x8555f, 0x22000777, NORD_M], { skinColor: 13021352 }));
ok(parts(stored()) === '37000800 8555f 22000777', 'records: the edit no records could tell: their own head back', parts(stored()));
edit(hiPoly(), char(0x13741, false, [0x51631, 0x8555f, NORD_M], { skinColor: 13021352 }));
ok(JSON.stringify(stored()) === JSON.stringify(hiPoly()) && gold() === 800, 'records: a head-only swap is still unchanged and free', parts(stored()));
edit(char(0x13741, false, [0x37000800, 0x2200aaaa, 0x51631]), char(0x13741, false, [0x51631, NORD_M]));
ok(parts(stored()) === '51631 5162f' && audits.some((t) => /could not be told/.test(t)) && !audits.some((t) => /kept their own$/.test(t)), 'records: two Face parts taken out: nothing guessed, audited', parts(stored()));
hdpt = new Map([[0x51631, 3]]);
edit(hiPoly(), char(0x13741, false, [0x22000999, 0x8555f, NORD_M], { skinColor: 13021352 }));
ok(parts(stored()) === '22000999 8555f 5162f' && audits.some((t) => /could not be told/.test(t)), 'a record missing for a part taken out: as with none, nothing guessed', parts(stored()));
hdpt = null;
// A plain paid edit leaves the client's look as it is: nothing to send again
edit(bretonM(), Object.assign(bretonM(), { hairColor: 9 }));
ok(timers.length === 0 && writes.length === 0, 'a paid edit with nothing put back is not written again', timers.length);
// A race change still puts the old look back, and that too is sent again after the window
edit(bretonM(), char(0x13746, false, [0x51631, NORD_M]));
ok(JSON.stringify(stored()) === JSON.stringify(bretonM()) && timers.length === 1, 'a refused race change: previous look, sent again after the window');

// 11. The settled write checks again before it writes
const settled = (label, meanwhile, writesExpected) => {
  edit(bretonM(), swapOnly);
  const n = writes.length;
  meanwhile();
  timers[0].fn();
  ok(writes.length - n === writesExpected, label, writes.length - n);
};
settled('the player logged out: no second write', () => props.set(`${A}|isOnline`, false), 0);
settled('another session has the character: no second write', () => { user = 4; }, 0);
settled('a newer /appearance is open: no second write', () => props.set(`${A}|private.dboAppearanceEdit`, { at: Date.now(), before: bretonM() }), 0);
settled('a GM /chargen is open: no second write', () => props.set(`${A}|private.dboChargenEdit`, { at: Date.now(), before: bretonM() }), 0);
settled('still online, same session, nothing newer: written', () => {}, 1);
// A beast form taken in the window (a Beast Form cast just after the close): the stored look keeps the mortal race named
// after the form, and writing it would rebuild the mortal head on the beast body (second review, 8 Oct)
settled('a beast form taken meanwhile: no second write', () => { props.set(`${A}|private.beast`, { form: 'werewolf', original: bretonM() }); props.set(`${A}|appearance`, Object.assign(bretonM(), { name: 'Werewolf' })); }, 0);
settled('an older beastform (only __dboBeastOriginalRace): no second write', () => { globalThis.__dboBeastOriginalRace = () => 0x13741; }, 0);
// The client drops every write to its own look in the window, so one made meanwhile (a mask's name, the tells, /rename)
// is what goes: the newest, never the guard's older copy
settled('the stored look changed meanwhile: the newer one is sent', () => props.set(`${A}|appearance`, Object.assign(bretonM(), { name: 'Masked Figure' })), 1);
ok(writes.at(-1).name === 'Masked Figure' && writes.at(-1).headpartIds.includes(0x51633), 'the write in the window is not lost on the player\'s own screen', writes.at(-1).name);

// 12. A GM's /chargen on an existing character
const E = globalThis.__dboAppearanceEdit;
const chargen = (start, after, setup) => {
  reset(800, start); if (setup) setup();
  const snap = E.chargenOpened(A);
  timers = []; writes = []; audits = []; sys = [];
  engineStores(after);
  const handled = E.chargenFinish(A, after);
  return { snap, handled };
};
let r = chargen(bretonM(), swapOnly);
ok(r.snap && r.handled && JSON.stringify(stored()) === JSON.stringify(bretonM()), 'a head-only swap under /chargen: the look from before', parts(stored()));
ok(audits.some((t) => /editor swapped in Nord's default head; kept their own \(GM \/chargen\)/.test(t)) && /another race's face/.test(sys.at(-1) || ''), 'audited and the player told', audits);
ok(gold() === 800 && timers.length === 1 && retakes.length === 0 && !props.get(`${A}|private.dboChargenEdit`), 'nothing charged, sent again after the window, the snapshot gone');
r = chargen(bretonM(), swapHair);
ok(stored().hairColor === 9 && stored().headpartIds.includes(0x51633) && !stored().headpartIds.includes(NORD_M) && retakes.length === 1, 'a /chargen edit with the swap: the edit kept, own head back, the tells retaken');
r = chargen(bretonM(), char(0x13746, false, [0x51631, NORD_M]));
ok(r.handled && !audits.some((t) => /swapped in/.test(t)) && writes.length === 0, 'a GM may change race: no guard', audits);
r = chargen(bretonM(), JSON.parse(JSON.stringify(bretonM())));
ok(r.handled && writes.length === 0 && timers.length === 0 && retakes.length === 0, 'closed unchanged: nothing written, nothing retaken');
r = chargen(null, swapOnly);
ok(!r.snap && !r.handled, 'a character with no look yet (creation) gets no snapshot');
r = chargen(bretonM(), swapOnly, () => props.set(`${A}|private.creationPending`, true));
ok(!r.snap && !r.handled && writes.length === 0, 'nor one still in creation');
r = chargen(bretonM(), swapOnly, () => props.set(`${A}|private.rerollPending`, true));
ok(!r.snap && !r.handled, 'nor one rerolling');
// A patron's reroll (patrons.js open()) takes its own snapshot; a /chargen over it leaves it alone
reset(800, bretonM()); props.set(`${A}|private.rerollPending`, true);
ok(E.chargenOpened(A, 'reroll') === true && props.get(`${A}|private.dboChargenEdit`).kind === 'reroll' && E.editing(A), 'a reroll snapshots the look, marked as a reroll');
ok(E.chargenOpened(A) === false && props.get(`${A}|private.dboChargenEdit`).kind === 'reroll', 'a GM /chargen while the reroll is open neither takes nor drops a snapshot');
timers = []; writes = []; audits = []; sys = []; engineStores(swapHair);
ok(E.chargenFinish(A, swapHair) === true && stored().headpartIds.includes(0x51633) && !stored().headpartIds.includes(NORD_M) && stored().hairColor === 9, 'the reroll close keeping race and sex: own head back, the rest as made', parts(stored()));
ok(audits.some((t) => /kept their own \(reroll\)$/.test(t)) && !props.get(`${A}|private.dboChargenEdit`), 'audited as a reroll, the snapshot gone', audits);
ok(retakes.length === 1 && JSON.stringify(retakes[0][1]) === JSON.stringify(bretonM()), 'a reroll\'s new look goes to the tells too, with the look before (second review, 8 Oct: a feed undid it)', retakes.length);
settleWindow(); ok(!E.editing(A), 'and once the window is over nothing is held');
reset(800, bretonM()); props.set(`${A}|private.creationPending`, true);
ok(E.chargenOpened(A, 'reroll') === false, 'no reroll snapshot for a character still in creation');
reset(800, bretonM()); props.set(`${A}|private.dboChargenEdit`, { at: Date.now() - 25 * 3600000, before: bretonM() });
ok(E.chargenFinish(A, swapOnly) === false && !props.get(`${A}|private.dboChargenEdit`), 'a snapshot a day old is dropped, not trusted');
// editing(): what supernatural.js holds the tells and forced changes on. Open, and for the client's settle window after a
// close (second review, 8 Oct: a tick in it after a close with no change, which sends nothing again, never reached the
// player's own screen)
let M = reset(800, bretonM()); let Ed = globalThis.__dboAppearanceEdit;
ok(!Ed.editing(A), 'editing: nothing open');
run(); ok(Ed.editing(A), 'editing: an /appearance edit is open');
finish(Object.assign(bretonM(), { hairColor: 9 })); ok(Ed.editing(A), 'editing: just closed, still held in the client\'s settle window');
skew += M.SETTLE_RESEND_MS - 100; ok(Ed.editing(A), 'editing: 3.4 s after the close, still held');
skew += 200; ok(!Ed.editing(A), 'editing: 3.6 s after the close, nothing held');
M = reset(800, bretonM()); Ed = globalThis.__dboAppearanceEdit; run(); finish(bretonM());
ok(timers.length === 0 && Ed.editing(A), 'editing: a close with no change (nothing sent again) is held through the window too');
settleWindow(); ok(!Ed.editing(A), '...and then released');
Ed.chargenOpened(A); ok(Ed.editing(A), 'editing: a /chargen is open');
Ed.chargenFinish(A, bretonM()); ok(Ed.editing(A), 'editing: a /chargen just closed, held in the window');
settleWindow(); ok(!Ed.editing(A), '...and then released');
Ed.chargenOpened(A);
props.set(`${A}|private.dboChargenEdit`, { at: Date.now() - 25 * 3600000, before: bretonM() }); ok(!Ed.editing(A), 'editing: a snapshot a day old holds nothing');
reset(800, bretonM()); run();
ok(E.chargenOpened(A) === false && !props.get(`${A}|private.dboChargenEdit`), 'no /chargen snapshot while the player\'s own /appearance is open (finish takes that close)');

reset(800, bretonM()); E.chargenOpened(A); props.set(`${A}|private.rerollPending`, true); engineStores(swapOnly);
ok(E.chargenFinish(A, swapOnly) === false && !props.get(`${A}|private.dboChargenEdit`) && !audits.some((t) => /swapped in/.test(t)), 'a reroll begun since the snapshot: that close is creation\'s, the snapshot dropped');
reset(800, bretonM()); E.chargenOpened(A); props.set(`${A}|private.dboAppearanceEdit`, { at: Date.now(), before: bretonM() }); finish(swapOnly);
ok(!props.get(`${A}|private.dboChargenEdit`) && JSON.stringify(stored()) === JSON.stringify(bretonM()) && timers.length === 1, 'an /appearance close ends a /chargen opened over it too, so its settled write is not held back');

// 13. gamemode.js: /chargen snapshots before it opens the editor; the hook guards its close and passes refusals on
const chargenCmd = src.slice(src.indexOf("registerChatCommand('chargen'"), src.indexOf("const NAME_RE"));
ok(chargenCmd.indexOf('chargenOpened(t)') > chargenCmd.indexOf('mp.setRaceMenuOpen(t, true)') && chargenCmd.indexOf('mp.setRaceMenuOpen(t, true)') > 0 && chargenCmd.indexOf('chargenOpened(t)') < chargenCmd.indexOf('Character creation opened for'), '/chargen takes the snapshot once the editor is open (a menu that failed to open leaves none)');
const afterEdit = hook.slice(hook.indexOf('return result;'));
ok(/if \(isAllowed\) \{\s*try \{ if \(globalThis\.__dboAppearanceEdit && typeof globalThis\.__dboAppearanceEdit\.chargenFinish === 'function'\)/.test(afterEdit)
  && afterEdit.indexOf('chargenFinish') < afterEdit.indexOf('__dboCreatorName'), 'the hook guards an allowed close after the /appearance branch and before creation\'s steps');
ok(/if \(!isAllowed\) \{\s*try \{ if \(globalThis\.__dboAppearanceEdit && typeof globalThis\.__dboAppearanceEdit\.refused === 'function'\)/.test(hook), 'the hook hands a refused close to appearance.js');
ok(/require\(APPEARANCE_JS\)\(\{[^}]*\buserOf\b/.test(src), 'appearance.js gets userOf (the settled write checks the session)');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
