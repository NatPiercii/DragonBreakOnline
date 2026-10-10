// A dragon's bones and scales are skinned, by a Master Skinner only (Nate, 11 Oct: "the ability to skin dragons for the
// last tier in skinning"). The real stashPelts and dragonParts from server\gamemode.js, run in a sandbox, plus the
// value bands and the bonus line read from the source. Run it from server\ with
//
//   node tests\skin-dragon-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const cut = (from, to) => { const a = src.indexOf(from); if (a < 0) throw new Error(`${from} not found`); const b = src.indexOf(to, a); return src.slice(a + 1, b + to.length); };
const code = cut('\nconst dragonParts = ', '\n};\n');

let failures = 0;
const check = (label, ok, got) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); };

const BONE = 0x3ada4, SCALES = 0x3ada3, GOLD = 0xf, GEM = 0x63b45, DEERPELT = 0x80679bd;
const run = (entries, tag) => {
  const props = new Map([['inventory', { entries }], ['private.npcSpawner', tag]]);
  const sb = {
    mp: { get: (id, k) => props.get(k), set: (id, k, v) => props.set(k, v) },
    peltPending: new Map(), log: () => {},
    isDragonMaterial: (id) => id === BONE || id === SCALES,
    trophyFor: () => null,
    recordOf: (id) => ({ [DEERPELT]: { record: { type: 'MISC', editorId: 'DeerPelt' } }, [GEM]: { record: { type: 'MISC', editorId: 'GemAmethyst' } } }[id] || null),
    PELT: /pelt|hide|skin$|fur$|pelts$/i,
  };
  sb.globalThis = sb; vm.runInNewContext(code + '\nglobalThis.stashPelts = stashPelts;', sb);
  sb.stashPelts(0xff000200);
  return { pelts: props.get('private.dboPelts'), left: props.get('inventory').entries };
};

// A dragon's death item: bone, scales, gold and a gem. Staff-spawned, so no spawn tag
let r = run([{ baseId: BONE, count: 2 }, { baseId: SCALES, count: 3 }, { baseId: GOLD, count: 150 }, { baseId: GEM, count: 1 }], undefined);
check('a dragon\'s bones and scales go to the skinning stash, even with no spawn tag', Array.isArray(r.pelts) && r.pelts.length === 2 && r.pelts.every((p) => p.dragon === true) && r.pelts.find((p) => p.baseId === BONE).count === 2 && r.pelts.find((p) => p.baseId === SCALES).count === 3, r.pelts);
check('...and off the body; its gold and gem stay lootable', r.left.length === 2 && r.left.every((e) => e.baseId === GOLD || e.baseId === GEM), r.left);
r = run([{ baseId: DEERPELT, count: 1 }, { baseId: GOLD, count: 3 }], 'wild:deer:1');
check('a deer is stashed as before (its pelt, not marked dragon)', r.pelts.length === 1 && r.pelts[0].baseId === DEERPELT && !r.pelts[0].dragon && r.left.length === 1, r);
r = run([{ baseId: GOLD, count: 3 }], undefined);
check('an untagged body with no dragon parts is left alone', r.pelts === undefined && r.left.length === 1, r);

// The bands: DragonBone (500 gold) and DragonScales (250) are past Expert's cap, so only a Master takes them
const caps = (src.match(/tierValueCap: \[([^\]]+)\]/) || [])[1].split(',').map(Number);
check('Expert\'s cap is below DragonScales (250) and Master\'s is above DragonBone (500)', caps[3] < 250 && caps[4] >= 500, caps);
check('no second-pelt bonus on dragon parts', /const count = \(Number\(p\.count\) \|\| 1\) \+ \(!p\.dragon && Math\.random\(\) < bonus \? 1 : 0\);/.test(src));
check('dragonParts reads dragon-materials.json through isDragonMaterial', /const dragonParts = \(entries\) => entries\.filter\(\(e\) => isDragonMaterial\(/.test(src));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
