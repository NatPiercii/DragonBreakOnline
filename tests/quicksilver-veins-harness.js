// Quicksilver in Mountainwatch's Frostiron Mine (smithing obtainability audit, 9 Oct; Nate: "fix everything"). No
// quicksilver vein stands inside the Bruma lock, so labour.js oreByRef gives four of the mine's iron veins Quicksilver,
// as the Bleak-Frost Mine's three give Meteoric Iron (tests/meteoric-veins-harness.js, whose mock this reuses). Works
// the mine's 12 iron veins (CYRFrostironmine01: 6 BSHeartland refs, 6 DLE v13 refs) and checks:
//   - the four refs give Quicksilver Ore (Skyrim 5ace2) from Miner tier 2 (Apprentice), not to a Novice
//   - the other eight iron veins still give iron
//   - gearswap.js leaves quicksilver ore alone (mined, never loot to swap)
//   node tests/quicksilver-veins-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const LABOUR = path.join(SERVER, 'labour.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

let virtual = 1000;
globalThis.performance = { now: () => virtual };

// The server's full-plugin indices for the three plugins involved (fork/deploy/skyrim-data/loadorder.txt with the light
// plugins skipped; 0x3c12ae11 in server.log is a DragonBreak Online Edits.esp ref)
const PLUG = { 'skyrim.esm': 0x00, 'bsassets.esm': 0x07, 'bsheartland.esm': 0x08, 'dragonbreak online edits.esp': 0x3c };
const idOfDesc = (d) => {
  const m = /^([0-9a-f]+):(.+)$/i.exec(String(d));
  if (!m || PLUG[m[2].toLowerCase()] === undefined) throw new Error(`${m ? m[2] : d} not found in loaded files`);
  return ((PLUG[m[2].toLowerCase()] << 24) | parseInt(m[1], 16)) >>> 0;
};
const DLE = (local) => idOfDesc(`${local}:DragonBreak Online Edits.esp`);

// The mine's iron veins (tools/crafting/obtainability.py lockNodes, cell CYRFrostironmine01): ref desc -> base editor id
const BASES = { MineOreIron01: 'a2c46', MineOreIron02: 'a2c4b', MineOreIron03: 'a2c4c', MineOreIron04: 'a2c4d' };
const VEINS = {
  'd9845:BSHeartland.esm': 'MineOreIron04', 'e59f9:BSHeartland.esm': 'MineOreIron01', 'd9847:BSHeartland.esm': 'MineOreIron04',
  'e59f8:BSHeartland.esm': 'MineOreIron02', 'e59fe:BSHeartland.esm': 'MineOreIron03', 'e59fd:BSHeartland.esm': 'MineOreIron04',
  '177fa4:DragonBreak Online Edits.esp': 'MineOreIron04', '177fa6:DragonBreak Online Edits.esp': 'MineOreIron04',
  '177f9e:DragonBreak Online Edits.esp': 'MineOreIron04', '177fa8:DragonBreak Online Edits.esp': 'MineOreIron04',
  '177fa2:DragonBreak Online Edits.esp': 'MineOreIron04', '177fa0:DragonBreak Online Edits.esp': 'MineOreIron04',
};
const QUICK = ['e59f8:BSHeartland.esm', '177fa4:DragonBreak Online Edits.esp', 'e59fd:BSHeartland.esm', '177fa8:DragonBreak Online Edits.esp'];
const ORE_ITEM = { iron: idOfDesc('71cf3:Skyrim.esm'), quicksilver: idOfDesc('5ace2:Skyrim.esm') };

// deny() says a refusal at most once in 1.5 s per player, so each refusal below is a different player
let ACTOR = 0x14;
const props = new Map();
const records = new Map();
for (const [edid, local] of Object.entries(BASES)) records.set(idOfDesc(`${local}:Skyrim.esm`), { record: { type: 'ACTI', editorId: edid } });
for (const [ref, edid] of Object.entries(VEINS)) props.set(idOfDesc(ref) + '|baseDesc', `${BASES[edid]}:Skyrim.esm`);

const out = { widgets: [], logs: [], items: [], personals: [], events: [] };
const handlers = new Map();
globalThis.__alduinakMasteryEvent = (kind, actorId, detail) => out.events.push({ kind, actorId, detail });
const SKILLS = JSON.parse(fs.readFileSync(path.join(SERVER, 'skills.json'), 'utf8'));
const api = {
  mp: {
    getIdFromDesc: idOfDesc,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push(t),
  audit: () => {},
  display: () => 'Tester #ABCD',
  who: () => 'Tester #ABCD (profile 1)',
  // Server judging keeps a won round deterministic here; the payout and the rests are the same code either way
  // The shared rest is what these checks read: pinned off, as tests/labour-harness.js does since 2832fe19 (iron and
  // corundum rest per player by default since 5a26ae2a)
  cfg: { labour: { clientJudged: false, perPlayerNodes: false } },
  distanceMeters: () => 2,
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  giveItem: (a, id, n) => { out.items.push([id >>> 0, n]); return true; },
  skills: SKILLS,
};
require(LABOUR)(api);
const boot = out.logs.join(' | ');
const fire = (ev, args) => (handlers.get(ev) || []).forEach((f) => f(ACTOR, args, 33));

// The widget's sweep, so a strike list lands every band (labour.js markerAt)
const markerAt = (ms, sweepMs) => { const phase = (ms % (sweepMs * 2)) / sweepMs; return phase <= 1 ? phase * 100 : (2 - phase) * 100; };
const strikesFor = (w) => {
  const s = []; let ready = 0;
  for (let i = 0; i < w.strikes; i++) {
    let t = ready;
    while (Math.abs(markerAt(t, w.sweepMs) - w.bands[i]) > w.band * 0.5) t++;
    s.push(t); ready = t + w.hitMs + 50;
  }
  return s;
};
const setTier = (rank) => props.set(ACTOR + '|private.mastery', { order: ['miner'], skills: { miner: { rank } } });
const clearRests = (ref) => { props.delete(ACTOR + '|private.minedVeins'); props.delete(ref + '|private.dboWorkedUntil'); };
// Activate the vein at a Miner rank; if a round opens, win it. Returns what the player saw and got
const work = (local, rank, actor) => {
  ACTOR = actor || 0x14;
  const ref = idOfDesc(local);
  clearRests(ref); setTier(rank);
  out.widgets.length = 0; out.personals.length = 0; out.items.length = 0; out.events.length = 0;
  virtual += 1000000;
  const start = virtual;
  globalThis.__dboLabour(ref, ACTOR);
  const w = out.widgets[out.widgets.length - 1];
  if (!w) return { opened: false, said: out.personals.slice() };
  const s = strikesFor(w);
  const at = s[s.length - 1] + 1;
  virtual = start + at + 100;
  out.widgets.length = 0;
  fire('labour', [w.nonce, JSON.stringify(s), at]);
  const rest = Number(props.get(ref + '|private.dboWorkedUntil')) || 0;
  return { opened: true, title: w.title, items: out.items.slice(), result: (out.widgets[0] || {}).result || '', restMin: rest ? Math.round((rest - Date.now()) / 60000) : 0, event: out.events[0] };
};
const oreOfBase = (edid) => /^MineOre([A-Za-z]+?)\d/.exec(edid)[1].toLowerCase();
const MINER = SKILLS.skills.find((k) => k.id === 'miner');
const bandOf = (ore) => MINER.oreByTier.findIndex((t) => (t || []).some((o) => String(o).toLowerCase() === ore));
const yieldOf = (ore, rank) => Math.max(1, Math.round(({ iron: 5, quicksilver: 2 })[ore] * MINER.yieldMultiplierByTier[rank]));

// ---- 1. the data ----
check('the boot line counts seven veins by reference (3 meteoric, 4 quicksilver)', /7 veins by reference/.test(boot), boot);
check('skills.json: quicksilver is a Miner tier 2 (Apprentice) ore', bandOf('quicksilver') === 1, MINER.oreByTier);
check('the four quicksilver refs are iron veins of the mine by their base', QUICK.every((r) => /^MineOreIron/.test(VEINS[r])));

// ---- 2. the quicksilver veins ----
for (const [i, ref] of QUICK.entries()) {
  const low = work(ref, 0, 0x100 + i);
  check(`${ref}: a Novice is refused (quicksilver is beyond them)`, !low.opened && low.said.some((t) => /^Quicksilver is beyond your skill/.test(t)), low.said);
  const r = work(ref, 1);
  check(`${ref}: an Apprentice works a Quicksilver Seam`, r.opened && r.title === 'Quicksilver Seam', r.title);
  check(`${ref}: ...and wins ${yieldOf('quicksilver', 1)} Quicksilver Ore (Skyrim 5ace2), no iron`, r.items.length === 1 && r.items[0][0] === ORE_ITEM.quicksilver && r.items[0][1] === yieldOf('quicksilver', 1), r.items);
}

// ---- 3. the other iron veins are as they were ----
let others = 0;
for (const [ref, edid] of Object.entries(VEINS)) {
  if (QUICK.includes(ref)) continue;
  const r = work(ref, 0);
  if (r.opened && r.title === 'Iron Seam' && r.items.length === 1 && r.items[0][0] === ORE_ITEM.iron && r.items[0][1] === yieldOf('iron', 0)) others++;
  else check(`${ref} ${edid} gives iron`, false, r);
}
check('the other 8 iron veins give iron to a Novice', others === 8, others);

// ---- 4. gearswap never touches mined quicksilver ----
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8'));
const SWAP = readJson('gear-swap.json');
const lower = (o) => Object.keys(o || {}).map((k) => k.toLowerCase());
check('gear-swap.json maps neither quicksilver ore nor ingot', ['5ace2:skyrim.esm', '5ada0:skyrim.esm'].every((d) => ![SWAP.metals, SWAP.items, SWAP.ammo].some((m) => lower(m).includes(d))));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
