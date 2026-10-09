// Drinks at an alchemy lab (Nate, 8 Oct: "add or create alcohol recipes for alchemy, includes skooma etc"): crouching at
// a lab opens the Brewing panel (alchemy.js, brewing.json) with the recipes at or under the brewer's Alchemist tier; a
// click brews one, taking the inputs; standing, the lab's own menu opens as before. Loads the real alchemy.js and data.
//   node tests/brewing-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const PLUGINS = { 'skyrim.esm': 0x00, 'dragonborn.esm': 0x04, 'bsassets.esm': 0x0a, 'bsheartland.esm': 0x0b, 'ccbgssse037-curios.esl': 0xfe };
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); const i = PLUGINS[String(plugin).toLowerCase()]; if (i === undefined) throw new Error(`no plugin ${plugin}`); return ((i << 24) | parseInt(hex, 16)) >>> 0; };
const LAB = 0x5000, LAB_BASE = idOf('bad0c:Skyrim.esm');
const BREWER = 0x14, NOVICE = 0x15, NOTRADE = 0x16;
const props = new Map();
const put = (id, k, v) => props.set(id + '|' + k, v);
const sneak = new Set();
const mp = {
  get: (id, k) => { if (id === LAB && k === 'baseDesc') return 'bad0c:Skyrim.esm'; return props.get(id + '|' + k); },
  set: (id, k, v) => props.set(id + '|' + k, v),
  getIdFromDesc: idOf, getDescFromId: (id) => id.toString(16),
  lookupEspmRecordById: (id) => (id === LAB_BASE ? { record: { type: 'FURN', editorId: 'CraftingAlchemyWorkbench', fields: [] } } : null),
  callPapyrusFunction: (kind, cls, fn, self, args) => (fn === 'GetAnimationVariableBool' && args[0] === 'IsSneaking' ? sneak.has(parseInt(self.desc, 16)) : null),
};
for (const a of [BREWER, NOVICE, NOTRADE, LAB]) { put(a, 'worldOrCellDesc', '1:Skyrim.esm'); put(a, 'pos', [0, 0, 0]); }
const rank = (a, r) => put(a, 'private.mastery', { skills: { alchemist: { level: r * 25, rank: r } }, order: ['alchemist'] });
rank(BREWER, 2); rank(NOVICE, 0);
const W = idOf('4b0ba:Skyrim.esm'), HONEY = idOf('b08c5:Skyrim.esm'), MOON = idOf('d8e3f:Skyrim.esm');
const ALE = idOf('34c5e:Skyrim.esm'), SKOOMA = idOf('57a7a:Skyrim.esm'), DD_SKOOMA = idOf('3f4bd:Skyrim.esm');
put(BREWER, 'inventory', { entries: [{ baseId: W, count: 5 }, { baseId: MOON, count: 2 }, { baseId: HONEY, count: 1 }] });
const count = (a, id) => (props.get(a + '|inventory').entries.filter((e) => e.baseId === id).reduce((n, e) => n + e.count, 0));
const widgets = [], said = [], audits = [], ui = new Map(), awards = [];
globalThis.__alduinakMasteryAward = (a, skill, units, key) => { awards.push([a, skill, key]); return 1; };
require(path.join(SERVER, 'alchemy.js'))({ mp, log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), display: String, who: String,
  openWidget: (a, w) => widgets.push([a, w]), closeWidget: () => {}, every: () => {}, itemName: () => '', cfg: {}, sendPacket: () => {}, onUi: (e, fn) => ui.set(e, fn) });

const data = JSON.parse(fs.readFileSync('brewing.json', 'utf8'));
ok(globalThis.__dboBrewDrinks.length === data.recipes.length && data.recipes.length >= 20, `all ${data.recipes.length} recipes load`, globalThis.__dboBrewDrinks.length);
const names = data.recipes.map((r) => r.name);
ok(['Nord Mead', 'Ale', 'Alto Wine', 'Wine', 'Spiced Wine', 'Black-Briar Mead', 'Honningbrew Mead', 'Cyrodilic Brandy', 'Firebrand Wine', 'Sujamma', 'Shein', 'Mazte', 'Flin', 'Mead with Juniper Berry', 'Skooma', 'Double-Distilled Skooma'].every((n) => names.includes(n)), 'the asked-for drinks are all there');
ok(data.recipes.filter((r) => /Skooma/.test(r.name)).every((r) => r.contraband && r.tier >= 3), 'skooma is contraband and tier 3 or more');

ok(globalThis.__dboAlchemyLab(LAB, BREWER) === false, 'standing at the lab: its own menu opens, as before');
sneak.add(BREWER);
ok(globalThis.__dboAlchemyLab(LAB, BREWER) === true, 'crouching at the lab: the Brewing panel instead (gamemode refuses the menu)');
const panel = widgets[widgets.length - 1][1];
ok(panel.id === 72 && panel.mode === 'menu' && /Brewing \(Alchemist tier 3/.test(panel.targetName), 'the panel names the brewer\'s tier', panel.targetName);
const labels = panel.actions.map((x) => x.label);
ok(labels.some((l) => /^Ale: Wheat x2$/.test(l)) && labels.some((l) => /^Skooma: Moon Sugar x2$/.test(l)), 'recipes the pack can make are plain lines', labels.slice(0, 3));
ok(labels.some((l) => /^Nord Mead: Honeycomb x2 \(missing\)$/.test(l)), '...those it cannot are marked missing');
ok(!labels.some((l) => /Double-Distilled/.test(l)) && /1 more at higher tiers/.test(panel.targetName), 'a tier-4 recipe is not offered at tier 3, and is counted', panel.targetName);
const pick = (label) => panel.actions.find((x) => x.label.startsWith(label)).id;
ui.get('brewChoose')(BREWER, [pick('Ale:')]);
ok(count(BREWER, W) === 3 && count(BREWER, ALE) === 1, 'brewing Ale takes two Wheat and gives one Ale');
ok(awards.some(([a, s, k]) => a === BREWER && s === 'alchemist' && k === ALE), 'the brew credits Alchemist');
ui.get('brewChoose')(BREWER, [pick('Skooma:')]);
ok(count(BREWER, SKOOMA) === 1 && count(BREWER, MOON) === 0 && audits.some((t) => /brewed Skooma \(contraband\)/.test(t)), 'skooma brews, and is audited as contraband', audits);
said.length = 0;
ui.get('brewChoose')(BREWER, [pick('Nord Mead:')]);
ok(said.some(([, t]) => /Nord Mead needs Honeycomb x2/.test(t)) && count(BREWER, HONEY) === 1, 'missing inputs: told what it needs, nothing taken');
put(BREWER, 'pos', [5000, 0, 0]);
const before = count(BREWER, W);
ui.get('brewChoose')(BREWER, [pick('Ale:')]);
ok(count(BREWER, W) === before, 'away from the lab nothing is brewed');
sneak.add(NOTRADE); said.length = 0;
ok(globalThis.__dboAlchemyLab(LAB, NOTRADE) === true && said.some(([, t]) => /Alchemist's trade/.test(t)), 'without the Alchemist trade: told to take it up');
sneak.add(NOVICE); widgets.length = 0;
globalThis.__dboAlchemyLab(LAB, NOVICE);
ok(widgets.length && widgets[0][1].actions.every((x) => !/Skooma|Brandy|Black-Briar/.test(x.label)), 'a Novice sees tier-1 drinks only');
const src = fs.readFileSync('gamemode.js', 'utf8');
ok(/if \(globalThis\.__dboAlchemyLab\(targetId >>> 0, casterId >>> 0\) === true\) return false;/.test(src) && /require\(ALCHEMY_JS\)\(\{[^}]*onUi \}\)/.test(src), 'gamemode refuses the lab\'s menu when the panel opened, and passes onUi');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
