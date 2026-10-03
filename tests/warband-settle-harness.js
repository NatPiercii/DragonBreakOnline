// /warband settle keeps NPCs that are aggressive by their record (warband.js aggressionOf: AIDT aggression, through any
// template whose ACBS flags pass AI data on). A settled NPC is rebuilt as an ordinary one with its own factions and AI, so a
// Daedroth Titan settled on 3 Oct turned on the players near it. Unleash is unchanged.
//   node tests/warband-settle-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'warband.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-wbsettle-'));
const home = process.cwd();
process.chdir(dir);
const TITAN = 0x843, BANDIT = 0x1e7e2, LVL = 0x500, TPL_AGGR = 0x501, FARMER = 0x600, OWN_AI = 0x700, OWN_AI_TPL = 0x701, BROKEN = 0x800;
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [{ id: 'npc', kind: 'npc', items: [
  ['843:Skyrim.esm', 'Daedroth Titan'], ['1e7e2:Skyrim.esm', 'Bandit'], ['500:Skyrim.esm', 'Templated Wolf'], ['600:Skyrim.esm', 'Farmer'],
  ['700:Skyrim.esm', 'Own AI Villager'], ['800:Skyrim.esm', 'Broken Record'],
] }] }));
const u8 = (bytes) => new Uint8Array(bytes);
const acbs = (tflags) => { const b = new Uint8Array(24); new DataView(b.buffer).setUint16(18, tflags, true); return b; };
const tplt = (id) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, id, true); return b; };
const NPC = (fields) => ({ record: { type: 'NPC_', fields: fields.map(([type, data]) => ({ type, data })) }, toGlobalRecordId: (x) => x });
const records = {
  [TITAN]: NPC([['ACBS', acbs(0)], ['AIDT', u8([2, 3, 50])]]),
  [BANDIT]: NPC([['ACBS', acbs(0)], ['AIDT', u8([1, 2, 50])]]),
  [LVL]: NPC([['ACBS', acbs(0x10)], ['TPLT', tplt(TPL_AGGR)], ['AIDT', u8([0])]]),   // AI data comes from the template
  [TPL_AGGR]: NPC([['ACBS', acbs(0)], ['AIDT', u8([1])]]),
  [FARMER]: NPC([['ACBS', acbs(0)], ['AIDT', u8([0, 1, 50])]]),
  [OWN_AI]: NPC([['ACBS', acbs(0x04)], ['TPLT', tplt(OWN_AI_TPL)], ['AIDT', u8([0])]]),  // template gives factions only
  [OWN_AI_TPL]: NPC([['ACBS', acbs(0)], ['AIDT', u8([2])]]),
};
let next = 0xff000100;
const companions = new Map();
globalThis.__dboWarband = undefined;
globalThis.__dboCompanions = {
  spawn: (owner, baseId, opts) => { const id = next++; companions.set(id, { id, ownerId: owner, baseId, kind: opts.kind }); return id; },
  list: (owner) => [...companions.values()].filter((c) => c.ownerId === owner && !c.released),
  release: (id, hostile) => { const c = companions.get(id); c.released = true; c.hostile = hostile; return true; },
  dismiss: (id) => companions.delete(id), follow: () => true, stay: () => true, attack: () => true,
};
const said = [], logs = [], commands = {};
require(MODULE)({
  mp: { get: (id, k) => (k === 'pos' ? [0, 0, 0] : k === 'angle' ? [0, 0, 0] : undefined), getIdFromDesc: (d) => parseInt(d, 16),
    lookupEspmRecordById: (id) => { if (id === BROKEN) throw new Error('bad'); return records[id] || null; } },
  log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push(t), audit: () => {}, who: (a) => `GM${a}`, isAdmin: () => true,
  registerChatCommand: (n, f) => { commands[n] = f; }, findByName: () => 0, cfg: {}, onUi: () => {},
});
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const GM = 1;
const raised = (base) => [...companions.values()].filter((c) => c.baseId === base);
try {
  for (const n of ['Daedroth Titan', 'Bandit', 'Templated Wolf', 'Farmer', 'Own AI Villager', 'Broken Record']) commands.warband(GM, `raise ${n}`);
  ok(companions.size === 6, 'six raised', companions.size);
  said.length = 0;
  commands.warband(GM, 'settle');
  ok(raised(TITAN)[0].released !== true, 'a Daedroth Titan (very aggressive) is not settled');
  ok(raised(BANDIT)[0].released !== true, 'a bandit (aggressive) is not settled');
  ok(raised(LVL)[0].released !== true, 'aggression taken from the template when the ACBS flags pass AI data on');
  ok(raised(FARMER)[0].released === true && raised(FARMER)[0].hostile === false, 'an unaggressive farmer is settled as before');
  ok(raised(OWN_AI)[0].released === true, 'a template that passes on only factions: the record\'s own (unaggressive) AI decides');
  ok(raised(BROKEN)[0].released === true, 'a record that cannot be read is settled as before');
  const msg = said.join(' ');
  ok(/Your warband of 3 stays here as friendly NPCs/.test(msg), 'the GM is told who was settled', msg);
  ok(/3 \(Daedroth Titan, Bandit, Templated Wolf\) are aggressive by nature/.test(msg) && /dismiss them, or unleash them as a raid/.test(msg), '...and who stays, and why', msg);
  ok(logs.some((l) => /kept 3 aggressive NPC\(s\)/.test(l)), 'one log line for the kept ones');
  said.length = 0;
  commands.warband(GM, 'settle');
  ok(/Nobody was settled\./.test(said.join(' ')) && raised(TITAN)[0].released !== true, 'settling again with only aggressive ones left settles nobody', said);
  commands.warband(GM, 'unleash');
  ok(raised(TITAN)[0].released === true && raised(TITAN)[0].hostile === true && raised(BANDIT)[0].hostile === true, 'unleash still releases them, hostile');
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
