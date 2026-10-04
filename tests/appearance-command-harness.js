// /appearance (appearance.js): a player reopens the appearance editor for gold; race, sex and name are kept, the gold is
// taken only for a changed look, once per cooldown, and never while busy. Stub mp, the real module.
//   node tests/appearance-command-harness.js   (from server/)
'use strict';
const path = require('path');
const MOD = path.resolve(__dirname, '..', 'appearance.js');
let fails = 0;
const ok = (c, label, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${label}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const A = 0xff000101;
let props, said, sys, audits, cmds, opened;
const look = () => ({ raceId: 0x13746, isFemale: false, name: 'Brand Stoneborn', weight: 50, skinColor: 1, hairColor: 2, headpartIds: [1, 2], headTextureSetId: 3, options: [0], presets: [0], tints: [] });
const reset = (gold) => {
  props = new Map([[`${A}|appearance`, look()], [`${A}|inventory`, { entries: [{ baseId: 0xf, count: gold }, { baseId: 0x1d4ec, count: 1 }] }]]);
  said = []; sys = []; audits = []; cmds = new Map(); opened = 0;
  delete require.cache[MOD];
  globalThis.__dboCombatAt = new Map(); globalThis.__dboIsDowned = null; globalThis.__dboBeastOriginalRace = null; globalThis.__dboDungeonCells = new Set();
  return require(MOD)({
    mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v), setRaceMenuOpen: () => { opened++; } },
    log: () => {}, personal: (a, t) => said.push(t), system: (a, t) => sys.push(t), audit: (t) => audits.push(t), who: () => 'Brand',
    registerChatCommand: (n, fn) => cmds.set(n, fn), cfg: { appearance: { cost: 500, cooldownHours: 24 } },
  });
};
const gold = () => props.get(`${A}|inventory`).entries.filter((e) => e.baseId === 0xf).reduce((s, e) => s + e.count, 0);
const run = () => cmds.get('appearance')(A, '');
const finish = (app) => globalThis.__dboAppearanceEdit.finish(A, app);

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

// 8. Not ours: finish ignores an actor with no pending edit (creation and GM /chargen keep their own path)
reset(800);
ok(globalThis.__dboAppearanceEdit.finish(A, look()) === false && gold() === 800, 'no pending edit: finish leaves it to creation and /chargen');

// 9. gamemode.js routes a pending edit to appearance.js before any creation step
const src = require('fs').readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const hook = src.slice(src.indexOf('const appearanceHook ='), src.indexOf('appearanceHook.__dbo = true'));
ok(hook.indexOf('__dboAppearanceEdit.pending') > 0 && hook.indexOf('__dboAppearanceEdit.pending') < hook.indexOf('moveToHubWhenReady') && /require\(APPEARANCE_JS\)/.test(src), 'gamemode.js hands a pending edit to appearance.js before creation\'s steps');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
