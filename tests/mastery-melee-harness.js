// Does a record holding One-Handed / Two-Handed move to Blade / Blunt by the weapons the character fought with, keeping
// every level, and only once skills.json has made the switch?
//
//   node tests\mastery-melee-harness.js <bundled masterySystem.js>
//   (bundle with: cd fork\skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests\\mastery-melee-harness.js <bundled masterySystem.js>'); process.exit(2); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } else console.log(`  PASS ${label}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-melee-'));
const home = process.cwd();
process.chdir(dir);
fs.writeFileSync('melee-migration.json', JSON.stringify({ byTag: { BLNT: 'blunt', BLDE: 'blade' } }));

const SWORD = 0x12eb7, MACE = 0x13982, AXE = 0x13790;
const DNAM = { [SWORD]: 1, [MACE]: 4, [AXE]: 3 };
const props = new Map();
const papyrus = [];
const mp = {
  get: (id, key) => { const v = props.get(`${id >>> 0}:${key}`); return v === undefined ? undefined : JSON.parse(v); },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: (kind, cls, fn, self, args) => papyrus.push([fn, self.desc, args]),
  lookupEspmRecordById: (id) => (DNAM[id] ? { record: { type: 'WEAP', fields: [{ type: 'DNAM', data: Uint8Array.from([DNAM[id], 0, 0]) }] } } : null),
};
const ctx = { svr: mp };

const def = (id, label, vanilla) => ({ id, category: 'combat', label, title: '', description: '', tiers: [], vanillaSkills: vanilla, counts: {}, gates: {} });
const sys = new MasterySystem(() => { });
sys.points = { pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 25, firstTouchCost: 1, bucketBurst: 20, bucketPerHour: 30, dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080 };
const NEW = [def('blade', 'Blade', ['OneHanded', 'TwoHanded']), def('blunt', 'Blunt', ['OneHanded', 'TwoHanded']), def('archery', 'Archery', ['Archery'])];
const OLD = [def('onehanded', 'One-Handed', ['OneHanded']), def('twohanded', 'Two-Handed', ['TwoHanded']), def('archery', 'Archery', ['Archery'])];

let next = 0xff000100;
const actor = (tag, skills, lastWorn) => {
  const id = next++;
  mp.set(id, 'private.charTag', tag);
  if (lastWorn) mp.set(id, 'private.lastWorn', lastWorn);
  mp.set(id, 'private.mastery', { v: 2, skills, order: Object.keys(skills), respecs: 0 });
  return id;
};
const prog = (level, granted) => ({ level, points: level, xp: 3, lock: 'raise', granted: granted || [] });

// skills.json not switched yet: nothing moves
sys.skills = OLD;
let a = actor('BLNT', { onehanded: prog(60) });
let rec = sys.read(ctx, a);
ok('with the old skills.json a record is left alone', rec && rec.skills.onehanded && rec.skills.onehanded.level === 60 && !rec.skills.blunt);

sys.skills = NEW;
a = actor('BLNT', { onehanded: prog(60, [0x1234]), archery: prog(30) });
rec = sys.read(ctx, a);
ok('one old skill goes to the side the log says they fought with', rec.skills.blunt && rec.skills.blunt.level === 60 && !rec.skills.onehanded && !rec.skills.blade);
ok('its xp and lock come with it', rec.skills.blunt.xp === 3 && rec.skills.blunt.lock === 'raise');
ok('other skills are untouched', rec.skills.archery.level === 30);
ok('the old tier markers are removed', papyrus.some(([fn, self, args]) => fn === 'RemoveSpell' && self === a.toString(16) && args[0].desc === '1234') && rec.skills.blunt.granted.length === 0);

a = actor('BLDE', { onehanded: prog(40), twohanded: prog(80) });
rec = sys.read(ctx, a);
ok('two old skills go to both, the higher to the side they fought with', rec.skills.blade.level === 80 && rec.skills.blunt.level === 40);
ok('no level is gained or lost', rec.skills.blade.level + rec.skills.blunt.level === 120);

a = actor('NONE', { twohanded: prog(55) }, [[MACE, 0], [AXE, 1], [SWORD, 0]]);
rec = sys.read(ctx, a);
ok('with no log, the last outfit decides (two blunt, one blade)', rec.skills.blunt && rec.skills.blunt.level === 55);

a = actor('ZERO', { twohanded: prog(20) });
rec = sys.read(ctx, a);
ok('with nothing to go on, Blade', rec.skills.blade && rec.skills.blade.level === 20);

a = actor('DONE', { blade: prog(33), onehanded: prog(90) });
rec = sys.read(ctx, a);
ok('a record already on Blade/Blunt is not moved again', rec.skills.blade.level === 33 && !rec.skills.blunt);

// actor values: both skills drive OneHanded and TwoHanded, and each takes the better rank
papyrus.length = 0;
a = actor('BOTH', { blade: prog(80), blunt: prog(30) });
rec = sys.read(ctx, a);
sys.applyActorValues(ctx, a, 'blunt', rec.skills.blunt.rank, rec);
const set = papyrus.filter(([fn]) => fn === 'SetActorValue').map(([, , args]) => args);
ok('a lower Blunt does not pull OneHanded below the Blade tier', set.length === 2 && set.every(([, v]) => v === 15 * (rec.skills.blade.rank + 1)), set);
papyrus.length = 0;
delete rec.skills.blade;
rec.order = rec.order.filter((x) => x !== 'blade');
sys.applyActorValues(ctx, a, 'blade', -1, rec);
const after = papyrus.filter(([fn]) => fn === 'SetActorValue').map(([, , args]) => args);
ok('dropping Blade leaves the actor values at the Blunt tier, not 15', after.every(([, v]) => v === 15 * (rec.skills.blunt.rank + 1)), after);

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
