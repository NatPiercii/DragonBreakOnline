// Scripted test for lab alchemy (alchemy.js) and the Draught of Revival brewed at a lab (downed.js), against a mock
// api holding the real ingredient effects: the exact recipe with the book read and Alchemist tier 4 gives the Draught
// and takes one of each ingredient; without the book or the tier it gives the ordinary potion (the latter with a hint);
// a pair or a stray report never makes it; the recipe banner, the lab reminder, the downed text, /brew gone, E revive.
// The brew list (groundedpasta, 2026-09-29): using a lab opens an unfocused panel of what the pack can brew, each line
// the potion brew() really makes from that pair; it follows a brew and closes when the player walks away.
// Run it from this folder's parent with
//
//   node tests\alchemy-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER); // alchemy-potions.json resolves by cwd, as on the server

// Exact plugin-name matching; the two DragonBreak-side indices are harness-only, only their consistency matters
const PLUGINS = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'DragonBreak Online Edits.esp': 0x60, 'Journey to Baan Malur.esp': 0x61 };
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };

const TROLL_FAT = idOf('3ad72:Skyrim.esm'), FLY_AMANITA = idOf('4da00:Skyrim.esm'), YELLOW_POLYPORE = idOf('6018c7:BSAssets.esm');
const RED_POLYPORE = idOf('6018c6:BSAssets.esm'), BLUE_FLOWER = idOf('77e1c:Skyrim.esm'), GOLD = idOf('f:Skyrim.esm');
const DRAUGHT = idOf('12ae16:DragonBreak Online Edits.esp'), RECIPE_BOOK = idOf('12ae17:DragonBreak Online Edits.esp');
const LAB_BASE = 'bad0c:Skyrim.esm'; // CraftingAlchemyWorkbench

// Effects and base costs as the load order holds them (EFID read through ck-mcp, USSEP winning where it overrides)
const MGEF = {
  '3eb15:Skyrim.esm': ['AlchRestoreHealth', 0.5], '3eb1a:Skyrim.esm': ['AlchFortifyTwoHanded', 0.5], '73f29:Skyrim.esm': ['AlchInfluenceAggUp', 15],
  '90041:Skyrim.esm': ['AlchResistPoison', 0.5], '3eb42:Skyrim.esm': ['AlchDamageHealth', 3], '3eb06:Skyrim.esm': ['AlchFortifyHealRate', 0.1],
  '601946:BSAssets.esm': ['BSKAlchReflectSpell', 0], '3eb01:Skyrim.esm': ['AlchFortifyCarryWeight', 0.15], '73f2b:Skyrim.esm': ['AlchDamageMagickaRate', 0.5],
  '3eb25:Skyrim.esm': ['AlchFortifyConjuration', 0.25], '3eaf3:Skyrim.esm': ['AlchFortifyHealth', 0.35],
  '3eaea:Skyrim.esm': ['AlchResistFire', 0.5], '3eb08:Skyrim.esm': ['AlchFortifyStaminaRate', 0.1],
};
const INGR = {
  [TROLL_FAT]: ['TrollFat', ['90041:Skyrim.esm', '3eb1a:Skyrim.esm', '73f29:Skyrim.esm', '3eb42:Skyrim.esm']],
  [FLY_AMANITA]: ['Mushroom01', ['3eaea:Skyrim.esm', '3eb1a:Skyrim.esm', '73f29:Skyrim.esm', '3eb08:Skyrim.esm']],
  [YELLOW_POLYPORE]: ['BSKCinnabarPolyporeYellow', ['3eb15:Skyrim.esm', '3eb06:Skyrim.esm', '73f29:Skyrim.esm', '601946:BSAssets.esm']],
  [BLUE_FLOWER]: ['MountainFlower01Blue', ['3eb15:Skyrim.esm', '3eb25:Skyrim.esm', '3eaf3:Skyrim.esm', '73f2b:Skyrim.esm']],
};
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const RECORDS = {};
for (const [d, [edid, cost]] of Object.entries(MGEF)) {
  const data = new Uint8Array(152); new DataView(data.buffer).setFloat32(4, cost, true);
  RECORDS[idOf(d)] = { type: 'MGEF', editorId: edid, fields: [{ type: 'DATA', data }] };
}
for (const [id, [edid, effects]] of Object.entries(INGR)) RECORDS[id] = { type: 'INGR', editorId: edid, fields: effects.map((d) => ({ type: 'EFID', data: u32(idOf(d)) })) };
RECORDS[idOf(LAB_BASE)] = { type: 'FURN', editorId: 'CraftingAlchemyWorkbench', fields: [] };
RECORDS[GOLD] = { type: 'MISC', editorId: 'Gold001', fields: [] };

const TABLE = JSON.parse(fs.readFileSync('alchemy-potions.json', 'utf8')).effects;
const potionsOf = (mg) => TABLE[mg].potions.map((p) => idOf(p.id));
const ORDINARY = new Set([...potionsOf('03eb15'), ...potionsOf('03eb1a')]); // Restore Health, Fortify Two-handed
const TWO_HANDED = new Set(potionsOf('03eb1a'));

const BREWER = 0x14, NOVICE = 0x15, STRANGER = 0x16, FALLEN = 0x17, LAB = 0x5000;
const props = new Map();
const put = (id, p, v) => props.set(id + '|' + p, v);
const mastery = (a, rank) => put(a, 'private.mastery', { v: 2, skills: { alchemist: { level: rank * 25, xp: 0, rank } }, order: ['alchemist'] });
const stock = (a) => put(a, 'inventory', { entries: [{ baseId: TROLL_FAT, count: 2 }, { baseId: FLY_AMANITA, count: 2 }, { baseId: YELLOW_POLYPORE, count: 2 }, { baseId: BLUE_FLOWER, count: 1 }, { baseId: GOLD, count: 50 }] });
const count = (a, baseId) => ((props.get(a + '|inventory') || { entries: [] }).entries.filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0));
const total = (a, set) => [...set].reduce((n, id) => n + count(a, id), 0);
for (const a of [BREWER, NOVICE, STRANGER, FALLEN]) { put(a, 'profileId', a); put(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); put(a, 'pos', [0, 0, 0]); put(a, 'angle', [0, 0, 0]); }
put(LAB, 'baseDesc', LAB_BASE); put(LAB, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); put(LAB, 'pos', [100, 50, 0]);

const out = { said: [], packets: [], audits: [], logs: [], widgets: [] };
const commands = new Map();
const mp = {
  getIdFromDesc: idOf,
  getDescFromId: (id) => { const plugin = Object.keys(PLUGINS).find((k) => PLUGINS[k] === (id >>> 24)); return `${(id & 0xffffff).toString(16)}:${plugin}`; },
  get: (id, p) => props.get(id + '|' + p),
  set: (id, p, v) => props.set(id + '|' + p, JSON.parse(JSON.stringify(v))),
  lookupEspmRecordById: (id) => (RECORDS[id] ? { record: RECORDS[id], toGlobalRecordId: (local) => local } : null),
};
// The gamemode's own hooks, re-installed before its modules on every reload
let innerActivate = 0;
const baseHooks = () => {
  mp.onActivate = () => { innerActivate++; return true; };
  mp.onDeath = () => undefined;
  mp.onEatItem = () => true;
  mp.onHitDamageAttempt = () => true;
  mp.onHitDamage = () => undefined;
  mp.onSpellHit = () => undefined;
  mp.onSpellCast = () => undefined;
};
const api = (cfg) => ({
  mp, cfg,
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.said.push([a, t]),
  sendPacket: (a, p) => out.packets.push([a, p]),
  audit: (t) => out.audits.push(t),
  who: (a) => `P${a.toString(16)}`,
  display: (a) => `P${a.toString(16)}`,
  profileOf: (a) => a,
  nameOf: (a) => `P${a.toString(16)}`,
  onlineActors: () => [BREWER, NOVICE, STRANGER, FALLEN],
  every: (name, ms, fn) => timers.set(name, fn),
  openWidget: (a, widget, focus) => out.widgets.push([a, 'open', widget, !!focus]),
  itemName: (d) => CATALOG[String(d).toLowerCase()] || '',
  closeWidget: (a, id) => out.widgets.push([a, 'close', id]),
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
});
const timers = new Map();
// The F7 catalog's names for the harness ingredients (admin-items.json); Troll Fat is left out to test the fallback
const CATALOG = { '4da00:skyrim.esm': 'Fly Amanita', '6018c7:bsassets.esm': 'Yellow Cinnabar Polypore', '77e1c:skyrim.esm': 'Blue Mountain Flower' };
const CONFIG = JSON.parse(fs.readFileSync('gamemode-config.json', 'utf8'));
const load = (cfg) => {
  commands.clear(); baseHooks();
  for (const f of ['downed.js', 'alchemy.js']) { const p = path.resolve(f); delete require.cache[p]; require(p)(api(cfg)); }
};

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
let wallClock = 1780000000000;
Date.now = () => wallClock;
const craft = (a, ids) => { wallClock += 5000; out.said.length = 0; out.packets.length = 0; mp.onCraftUnmatched(a, LAB, 0xff000123, { entries: ids.map((baseId) => ({ baseId, count: 1 })) }); };
const saidTo = (a) => out.said.filter(([x]) => x === a).map(([, t]) => t);
const bannerTo = (a) => out.packets.filter(([x, p]) => x === a && p.customPacketType === 'dboBanner').map(([, p]) => p.text);

load(CONFIG);
check('downed.js and alchemy.js load with the live config', typeof globalThis.__dboLabDraught === 'function' && typeof mp.onCraftUnmatched === 'function', out.logs.filter((l) => /failed|not in/.test(l)));
check('...the config recipe is read (1 recipe)', out.logs.some((l) => /Draught of Revival on \(Alchemist tier 4, 3 lab bases, 1 recipes\)/.test(l)), out.logs);
check('/brew is gone', !commands.has('brew'), [...commands.keys()]);
check('/respawn stays', commands.has('respawn'));

// ---- reading the recipe book ----
mastery(BREWER, 3); mastery(NOVICE, 1); mastery(STRANGER, 4);
out.packets.length = 0;
mp.onReadBook(BREWER, RECIPE_BOOK);
check('the book teaches the recipe', (props.get(BREWER + '|private.dboRecipes') || {}).revive === true);
check('...its banner names the three ingredients', bannerTo(BREWER)[0] === 'You learned the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore at an alchemy lab.', bannerTo(BREWER));
out.packets.length = 0;
mp.onReadBook(NOVICE, RECIPE_BOOK);
check('...below tier 4 it adds the tier it takes', bannerTo(NOVICE)[0] === 'You learned the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore at an alchemy lab. Brewing it takes an Alchemist of tier 4.', bannerTo(NOVICE));

// ---- the lab reminder ----
out.said.length = 0; innerActivate = 0;
mp.onActivate(LAB, BREWER);
check('sitting at a lab reminds a tier 4 brewer of the mix', saidTo(BREWER)[0] === 'You know the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore here.' && innerActivate === 1, saidTo(BREWER));
out.said.length = 0;
mp.onActivate(LAB, NOVICE); mp.onActivate(LAB, STRANGER);
check('...below the tier it adds the tier it takes', saidTo(NOVICE)[0] === 'You know the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore here. Brewing it takes an Alchemist of tier 4.', saidTo(NOVICE));
check('...and says nothing without the book', saidTo(STRANGER).length === 0);
out.packets.length = 0;
mp.onReadBook(NOVICE, RECIPE_BOOK);
check('re-reading the book shows the recipe again', bannerTo(NOVICE)[0] === 'You know the Draught of Revival: mix troll fat, fly amanita and yellow cinnabar polypore at an alchemy lab. Brewing it takes an Alchemist of tier 4.', bannerTo(NOVICE));
check('...and audits the learning only once', out.audits.filter((t) => /^RECIPE P15 /.test(t)).length === 1, out.audits);

// ---- brewing ----
stock(BREWER);
craft(BREWER, [YELLOW_POLYPORE, TROLL_FAT, FLY_AMANITA]);
check('the exact set, the book and tier 4 give the Draught', count(BREWER, DRAUGHT) === 1, props.get(BREWER + '|inventory'));
check('...and take one of each ingredient', count(BREWER, TROLL_FAT) === 1 && count(BREWER, FLY_AMANITA) === 1 && count(BREWER, YELLOW_POLYPORE) === 1);
check('...and no ordinary potion', total(BREWER, ORDINARY) === 0);
check('...the banner says it reaches the pack', /^You brewed a Draught of Revival\. It reaches your pack as you leave the lab\./.test(bannerTo(BREWER)[0] || ''), bannerTo(BREWER));
check('...and it is audited', out.audits.some((t) => /^BREW P14 brewed a Draught of Revival at a lab$/.test(t)));

stock(STRANGER);
craft(STRANGER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('without the book the same set gives the ordinary potion', count(STRANGER, DRAUGHT) === 0 && total(STRANGER, ORDINARY) === 1, props.get(STRANGER + '|inventory'));
check('...one of each ingredient used', count(STRANGER, TROLL_FAT) === 1 && count(STRANGER, FLY_AMANITA) === 1 && count(STRANGER, YELLOW_POLYPORE) === 1);
check('...and nothing hints at a secret recipe', saidTo(STRANGER).length === 1 && /^You brew [^.]+\.$/.test(saidTo(STRANGER)[0]), saidTo(STRANGER));

stock(NOVICE);
craft(NOVICE, [FLY_AMANITA, YELLOW_POLYPORE, TROLL_FAT]);
check('with the book below tier 4 the set gives the ordinary potion', count(NOVICE, DRAUGHT) === 0 && total(NOVICE, ORDINARY) === 1, props.get(NOVICE + '|inventory'));
check('...with the hint in the same message', saidTo(NOVICE).length === 1 && / You know the Draught of Revival, but brewing it takes an Alchemist of tier 4\. This mix made an ordinary potion\.$/.test(saidTo(NOVICE)[0]), saidTo(NOVICE));

stock(BREWER);
craft(BREWER, [TROLL_FAT, FLY_AMANITA]);
check('a pair of the recipe gives Fortify Two-handed, not the Draught', count(BREWER, DRAUGHT) === 0 && total(BREWER, TWO_HANDED) === 1, props.get(BREWER + '|inventory'));
stock(BREWER);
craft(BREWER, [TROLL_FAT, FLY_AMANITA, BLUE_FLOWER]);
check('a different third ingredient gives no Draught', count(BREWER, DRAUGHT) === 0 && total(BREWER, ORDINARY) === 1, props.get(BREWER + '|inventory'));

stock(BREWER);
const before = JSON.stringify(props.get(BREWER + '|inventory'));
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE, GOLD]);
check('a report holding a non-ingredient makes nothing', JSON.stringify(props.get(BREWER + '|inventory')) === before && saidTo(BREWER).length === 0);
check('...and is logged, with the reason', out.logs.some((l) => /not a lab mix \(.+\); ignored/.test(l)));
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE, BLUE_FLOWER]);
check('four ingredients make nothing', JSON.stringify(props.get(BREWER + '|inventory')) === before);
check('...and the player is told why', /^The lab did not recognise that mix/.test(saidTo(BREWER)[0] || ''), saidTo(BREWER));
put(BREWER, 'pos', [5000, 0, 0]);
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('a mix reported away from the lab makes nothing', JSON.stringify(props.get(BREWER + '|inventory')) === before && count(BREWER, DRAUGHT) === 0 && saidTo(BREWER).length === 0);
check('...and is logged', out.logs.some((l) => /while not at it; ignored/.test(l)));
put(BREWER, 'pos', [0, 0, 0]); put(BREWER, 'worldOrCellDesc', '1:Skyrim.esm');
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('...as does one from another cell', JSON.stringify(props.get(BREWER + '|inventory')) === before && count(BREWER, DRAUGHT) === 0);
put(BREWER, 'worldOrCellDesc', 'a764b:BSHeartland.esm');

put(BREWER, 'inventory', { entries: [{ baseId: TROLL_FAT, count: 1 }, { baseId: FLY_AMANITA, count: 1 }] });
craft(BREWER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('a missing ingredient makes nothing', count(BREWER, DRAUGHT) === 0 && count(BREWER, TROLL_FAT) === 1 && /do not have/.test(saidTo(BREWER)[0] || ''), saidTo(BREWER));

// ---- the down state and the Draught used by hand ----
put(FALLEN, 'isDead', true);
out.packets.length = 0;
mp.onDeath(FALLEN, 0);
// The banner keeps to the timer; the ways back ride in the chat line with it (downed.js banner's detail, ec229fab)
check('the downed banner gives the timer', bannerTo(FALLEN)[0] === 'You are down. You wake at the temple in 60 seconds, or say /respawn to go now.', bannerTo(FALLEN));
check('...and the chat names both ways back', saidTo(FALLEN).some((t) => /A Priest's healing or a Draught of Revival can bring you back where you fell\./.test(t)), saidTo(FALLEN));
put(BREWER, 'inventory', { entries: [{ baseId: DRAUGHT, count: 1 }] });
put(FALLEN, 'percentages', { health: 0, magicka: 1, stamina: 1 });
const r = mp.onActivate(FALLEN, BREWER);
check('E on the fallen with the Draught raises them and uses it', r === false && props.get(FALLEN + '|isDead') === false && count(BREWER, DRAUGHT) === 0);

// ---- reloads and config ----
load(CONFIG); load(CONFIG);
out.packets.length = 0; props.delete(STRANGER + '|private.dboRecipes'); innerActivate = 0;
mp.onReadBook(STRANGER, RECIPE_BOOK);
check('after two reloads a read still teaches once', bannerTo(STRANGER).length === 1 && /^You learned/.test(bannerTo(STRANGER)[0]), bannerTo(STRANGER));
stock(STRANGER);
craft(STRANGER, [TROLL_FAT, YELLOW_POLYPORE, FLY_AMANITA]);
check('...and the Draught still brews', count(STRANGER, DRAUGHT) === 1 && total(STRANGER, ORDINARY) === 0);

load({});
check('with no config the default recipe is the same', /1 recipes\)/.test(out.logs.filter((l) => /^downed on/.test(l)).pop()));
stock(STRANGER);
const had = count(STRANGER, DRAUGHT);
craft(STRANGER, [TROLL_FAT, FLY_AMANITA, YELLOW_POLYPORE]);
check('...and brews the Draught', count(STRANGER, DRAUGHT) === had + 1);

load({ downed: { potion: { recipes: [
  [{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: '4da00:Skyrim.esm', name: 'fly amanita' }, { id: '6018c6:BSAssets.esm', name: 'red cinnabar polypore' }],
  [{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: ['1', 'NotInTheLoadOrder.esp'].join(':'), name: 'nothing' }],
  [{ id: '3ad72:Skyrim.esm', name: 'troll fat' }, { id: '3ad72:Skyrim.esm', name: 'troll fat' }],
] } } });
check('recipes with an unresolved or repeated id are dropped', /1 recipes\)/.test(out.logs.filter((l) => /^downed on/.test(l)).pop()));
check('...the red polypore alternative matches when configured', globalThis.__dboLabDraught(STRANGER, [RED_POLYPORE, TROLL_FAT, FLY_AMANITA]) && globalThis.__dboLabDraught(STRANGER, [RED_POLYPORE, TROLL_FAT, FLY_AMANITA]).potion === DRAUGHT);
check('...and the yellow one then does not', globalThis.__dboLabDraught(STRANGER, [YELLOW_POLYPORE, TROLL_FAT, FLY_AMANITA]) === null);

// The craft report carries the created result among its inputs (Falcius, 2026-09-28: two good ingredients
// refused because a dynamic id rode along). A created object is never an ingredient, so it must be dropped
// rather than sinking the whole mix.
craft(BREWER, [TROLL_FAT, FLY_AMANITA, 0xff000b2f]);
check('a created object in the craft report does not sink the mix',
  !out.logs.some((l) => /not a lab mix/.test(l) && /ff000b2f/.test(l)), out.logs.slice(-2));
check('...and the pair still brews', out.said.some(([, t]) => /You brew/.test(t)) || out.logs.some((l) => /brewed/.test(l)), out.said.slice(-2));

// ---- the brew list at the lab --------------------------------------------------------------------------------------
{
  load(CONFIG);
  stock(BREWER); mastery(BREWER, 2); put(BREWER, 'pos', [0, 0, 0]);
  const lastPanel = (a) => out.widgets.filter(([x, k, w]) => x === a && k === 'open' && w.id === 71).map(([, , w, f]) => ({ w, focus: f })).pop();
  out.widgets.length = 0;
  check('using something that is not a lab opens no list', globalThis.__dboAlchemyLab(0x5001, BREWER) === false && !lastPanel(BREWER));
  check('using a lab never stops the lab\'s own menu', globalThis.__dboAlchemyLab(LAB, BREWER) === false);
  const panel = lastPanel(BREWER);
  check('...and opens the list beside it, unfocused', !!panel && panel.w.type === 'contextMenu' && panel.w.mode === 'inspect' && panel.focus === false, panel);
  const lines = panel ? panel.w.lines : [];
  check('...naming Restore Health (Yellow Polypore + Blue Mountain Flower) and Fortify Two-handed (Troll Fat + Fly Amanita)',
    lines.some((l) => /Restore Health/.test(l)) && lines.some((l) => /Two ?Handed/i.test(l)), lines);
  // Each line's pair, brewed, gives the potion the line names
  const nameIds = { 'Troll Fat': TROLL_FAT, 'Fly Amanita': FLY_AMANITA, 'Yellow Cinnabar Polypore': YELLOW_POLYPORE, 'Blue Mountain Flower': BLUE_FLOWER };
  check('ingredients go by their catalog names, and by their editor id where the catalog has none', lines.some((l) => /Fly Amanita/.test(l)) && lines.some((l) => /Troll Fat/.test(l)), lines);
  let agree = 0;
  for (const l of lines) {
    const m = /^(.+): (.+) \+ (.+)$/.exec(l); if (!m) continue;
    const pair = [nameIds[m[2]], nameIds[m[3]]]; if (!pair[0] || !pair[1]) continue;
    stock(BREWER);
    craft(BREWER, pair);
    const brewed = (out.said.find(([a, t]) => a === BREWER && /You brew/.test(t)) || [])[1] || '';
    if (brewed.indexOf(`You brew ${m[1]}`) === 0) agree++; else check(`"${l}" brews what it says`, false, brewed);
  }
  check(`every listed pair brews the potion its line names (${agree} of ${lines.length})`, agree === lines.length && agree > 0);
  out.widgets.length = 0;
  stock(BREWER);
  craft(BREWER, [YELLOW_POLYPORE, BLUE_FLOWER]);
  check('a brew refreshes the open list', !!lastPanel(BREWER));
  put(BREWER, 'inventory', { entries: [{ baseId: TROLL_FAT, count: 1 }, { baseId: GOLD, count: 5 }] });
  globalThis.__dboAlchemyLab(LAB, BREWER);
  check('with nothing to pair, the list says so', /Nothing yet/.test((lastPanel(BREWER) || { w: { lines: [] } }).w.lines[0] || ''), lastPanel(BREWER));
  out.widgets.length = 0;
  timers.get('alchemyPanel')();
  check('standing at the lab keeps it open', !out.widgets.some(([a, k]) => a === BREWER && k === 'close'));
  put(BREWER, 'pos', [5000, 0, 0]);
  timers.get('alchemyPanel')();
  check('walking away from the lab closes it', out.widgets.some(([a, k, id]) => a === BREWER && k === 'close' && id === 71));
}

// One ingredient named twice (24 lab reports 23-30 Sep, e.g. BSKCairnBolete x1 + BSKCairnBolete x1): the player's lab
// brewed from two, the report lost the second. Nothing is brewed or taken, the player is told what happened, and the
// report and the player's stack of that ingredient are logged for the client fix.
{
  stock(BREWER);
  put(BREWER, 'pos', mp.get(LAB, 'pos'));
  const before = JSON.stringify(mp.get(BREWER, 'inventory'));
  out.logs.length = 0;
  craft(BREWER, [FLY_AMANITA, FLY_AMANITA]);
  check('one ingredient reported twice brews nothing and takes nothing', JSON.stringify(mp.get(BREWER, 'inventory')) === before);
  check('...and says the second ingredient was lost, not that a potion needs two', /lost track of your second ingredient/.test(saidTo(BREWER)[0] || '') && !/needs at least two/.test(saidTo(BREWER)[0] || ''), saidTo(BREWER));
  check('...and logs the report and how the stack is held', out.logs.some((l) => /report named Mushroom01 2 times and nothing else at lab 5000; held as 1 stack\(s\) \[count=2\]; report 4da00x1 4da00x1/.test(l)), out.logs);
  wallClock += 5000;
  craft(BREWER, [FLY_AMANITA]);
  check('a report with just one ingredient once still says a potion needs two', /needs at least two/.test(saidTo(BREWER)[0] || ''), saidTo(BREWER));
}

// ---- brewing is the Alchemist's work (Nate, 2026-09-30: Alchemist rose from picking mushrooms) ----
// Every brew above ran with no __alduinakMasteryAward (the live fork has none): brewing works the same without it.
const awards = [];
globalThis.__alduinakMasteryAward = (a, skill, weight, key) => { awards.push({ a, skill, weight, key }); return weight; };
stock(STRANGER);
craft(STRANGER, [TROLL_FAT, FLY_AMANITA]);
const strangerAward = awards[0];
check('an ordinary brew awards Alchemist once, keyed on the potion brewed', awards.length === 1 && strangerAward.a === STRANGER && strangerAward.skill === 'alchemist' && TWO_HANDED.has(strangerAward.key), awards);
check('...worth 1 to 3', strangerAward && strangerAward.weight >= 1 && strangerAward.weight <= 3, strangerAward);
awards.length = 0; stock(NOVICE);
craft(NOVICE, [TROLL_FAT, FLY_AMANITA]);
check('a Novice\'s brew is worth less than an Expert\'s', awards.length === 1 && awards[0].weight < strangerAward.weight, [awards, strangerAward]);
awards.length = 0; stock(BREWER); mastery(BREWER, 3); put(BREWER, 'private.dboRecipes', { revive: true });
craft(BREWER, [YELLOW_POLYPORE, TROLL_FAT, FLY_AMANITA]);
check('the Draught of Revival awards Alchemist too, keyed on the Draught', awards.length === 1 && awards[0].key === DRAUGHT && count(BREWER, DRAUGHT) >= 1, awards);
awards.length = 0; stock(BREWER);
craft(BREWER, [FLY_AMANITA, FLY_AMANITA]);
check('a mix that brews nothing awards nothing', awards.length === 0, awards);
globalThis.__alduinakMasteryAward = () => { throw new Error('boom'); };
stock(STRANGER);
const beforeThrow = total(STRANGER, TWO_HANDED);
craft(STRANGER, [TROLL_FAT, FLY_AMANITA]);
check('an award that throws never costs the potion', total(STRANGER, TWO_HANDED) === beforeThrow + 1 && out.logs.some((l) => /mastery award failed/.test(l)));
delete globalThis.__alduinakMasteryAward;

// ---- skills.json: gathering and eating are not the Alchemist's work ----
const SKILLS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'skills.json'), 'utf8')).skills;
const counts = (id) => (SKILLS.find((k) => k.id === id) || {}).counts || {};
check('Alchemist no longer counts harvesting plants or trees', !(counts('alchemist').activateTypes || []).some((t) => /^(FLOR|TREE)$/i.test(t)), counts('alchemist'));
check('...nor eating an ingredient (vanilla gives no Alchemy for it)', !counts('alchemist').eatIngredient);
check('...and Harvesting still does', ['FLOR', 'TREE'].every((t) => (counts('harvesting').activateTypes || []).includes(t)), counts('harvesting'));
const typeOwners = new Map();
for (const k of SKILLS) for (const t of ((k.counts || {}).activateTypes || [])) typeOwners.set(t, (typeOwners.get(t) || []).concat([k.id]));
check('no activated record type credits two trades at once', [...typeOwners.values()].every((ids) => ids.length === 1), Object.fromEntries(typeOwners));

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
