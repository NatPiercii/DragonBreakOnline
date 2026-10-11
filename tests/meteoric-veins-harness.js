// Meteoric iron in the Bleak-Frost Mine (Nate, 4 Oct 2026: "change some of the iron nodes, maybe 3 in Bleak-Frost Mine
// to Meteoric Iron ore nodes"). No vein activator for meteoric iron exists in the load order, so labour.js oreByRef
// gives three placed iron veins another ore, keyed by the reference. This loads the real labour.js and skills.json with
// a mock gamemode api that resolves descs the way the server does (plugin index by the full-plugin load order:
// Skyrim.esm 0x00, BSAssets.esm 0x07, DragonBreak Online Edits.esp 0x3c), works every one of the mine's 21 veins
// (DLE v13, cell CYRBleakFrostMine01) and checks:
//   - the three refs give Meteoric Iron Ore (BSAssets 601c92) and only from Miner tier 3 (Adept), with their own rest
//   - the other nine iron veins, the six corundum and the three gold veins give what their base says, as before
//   - gearswap.js leaves meteoric ore and ingots alone (they are mined and smelted, never loot to swap)
//   node tests/meteoric-veins-harness.js   (from server/)
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

// The mine's veins out of graft-v13.esp (esplib, cell 34177FB6 CYRBleakFrostMine01): ref local id -> base editor id
const BASES = { MineOreIron01: 'a2c46', MineOreIron02: 'a2c4b', MineOreIron03: 'a2c4c', MineOreIron04: 'a2c4d', MineOreCorundum01: 'a2bed', MineOreGold03: 'a2c36', MineOreGold04: 'a2c42' };
const VEINS = {
  '177fd3': 'MineOreIron04', '178060': 'MineOreIron04', '17808d': 'MineOreIron04', '178010': 'MineOreIron04', '178055': 'MineOreIron04',
  '177ffe': 'MineOreIron04', '178049': 'MineOreIron04', '178031': 'MineOreIron04', '178026': 'MineOreIron04',
  '177fbb': 'MineOreIron02', '17809b': 'MineOreIron03', '17803f': 'MineOreIron01',
  '178070': 'MineOreCorundum01', '177fef': 'MineOreCorundum01', '178059': 'MineOreCorundum01', '1780b5': 'MineOreCorundum01', '178058': 'MineOreCorundum01', '17806e': 'MineOreCorundum01',
  '17803a': 'MineOreGold03', '17803b': 'MineOreGold03', '178068': 'MineOreGold04',
};
const METEORIC = ['178031', '17808d', '178026'];
const ORE_ITEM = { iron: idOfDesc('71cf3:Skyrim.esm'), corundum: idOfDesc('5acdb:Skyrim.esm'), gold: idOfDesc('5acde:Skyrim.esm'), meteoriciron: idOfDesc('601c92:BSAssets.esm') };

// deny() says a refusal at most once in 1.5 s per player, so each refusal below is a different player
let ACTOR = 0x14;
const props = new Map();
const records = new Map();
for (const [edid, local] of Object.entries(BASES)) records.set(idOfDesc(`${local}:Skyrim.esm`), { record: { type: 'ACTI', editorId: edid } });
for (const [ref, edid] of Object.entries(VEINS)) props.set(DLE(ref) + '|baseDesc', `${BASES[edid]}:Skyrim.esm`);

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
  const ref = DLE(local);
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
const yieldOf = (ore, rank) => Math.max(1, Math.round(({ iron: 5, corundum: 3, gold: 1, meteoriciron: 2 })[ore] * MINER.yieldMultiplierByTier[rank]));

// ---- 1. the data ----
check('the boot line counts the meteoric veins by reference (13 with the quicksilver, adamantium and geode ones) and the meteoric rest', /13 veins by reference/.test(boot) && /meteoriciron 60/.test(boot), boot);
check('skills.json: meteoric iron is a Miner tier 3 (Adept) ore, beside gold', bandOf('meteoriciron') === 2 && bandOf('gold') === 2, MINER.oreByTier);
check('...and the tier text says so', /meteoric iron/i.test(MINER.tiers[2]), MINER.tiers[2]);
check('the mine has 21 veins: 12 iron, 6 corundum, 3 gold', Object.keys(VEINS).length === 21
  && Object.values(VEINS).filter((e) => /Iron/.test(e)).length === 12 && Object.values(VEINS).filter((e) => /Corundum/.test(e)).length === 6 && Object.values(VEINS).filter((e) => /Gold/.test(e)).length === 3);
check('the three meteoric refs are iron veins by their base', METEORIC.every((r) => /^MineOreIron/.test(VEINS[r])));

// ---- 2. the meteoric veins ----
for (const [i, local] of METEORIC.entries()) {
  const low = work(local, 1, 0x100 + i);
  check(`${local}: an Apprentice miner is refused (meteoric iron is beyond them)`, !low.opened && low.said.some((t) => /^Meteoric Iron is beyond your skill/.test(t)), low.said);
  const r = work(local, 2);
  check(`${local}: an Adept miner works a Meteoric Iron Seam`, r.opened && r.title === 'Meteoric Iron Seam', r.title);
  check(`${local}: ...and wins ${yieldOf('meteoriciron', 2)} Meteoric Iron Ore (BSAssets 601c92), no iron`, r.items.length === 1 && r.items[0][0] === ORE_ITEM.meteoriciron && r.items[0][1] === yieldOf('meteoriciron', 2), r.items);
  check(`${local}: ...told so by name`, r.result === `The seam gives way: ${yieldOf('meteoriciron', 2)} Meteoric Iron Ore.`, r.result);
  check(`${local}: ...the seam rests 60 minutes for everyone`, r.restMin === 60, r.restMin);
  check(`${local}: ...and the skill is credited at the tier 3 band`, r.event && r.event.kind === 'mine' && r.event.detail.value === 2, r.event);
}
const master = work(METEORIC[0], 4);
check('a Master miner gets double: 4 Meteoric Iron Ore', master.items.length === 1 && master.items[0][0] === ORE_ITEM.meteoriciron && master.items[0][1] === 4, master.items);

// ---- 3. every other vein is as it was ----
let others = 0;
for (const [local, edid] of Object.entries(VEINS)) {
  if (METEORIC.includes(local)) continue;
  const ore = oreOfBase(edid);
  const rank = bandOf(ore);
  const r = work(local, rank);
  const ok = r.opened && r.title === `${ore.charAt(0).toUpperCase() + ore.slice(1)} Seam` && r.items.length === 1 && r.items[0][0] === ORE_ITEM[ore]
    && r.items[0][1] === yieldOf(ore, rank) && r.restMin === 30;
  if (ok) others++; else check(`${local} ${edid} gives ${ore} at tier ${rank + 1}, rest 30`, false, r);
}
check('the other 18 veins (9 iron, 6 corundum, 3 gold) give their own ore at their own tier, rest 30 minutes', others === 18, others);
const novice = work('177fd3', 0);
check('a Novice still works an ordinary iron vein of the mine: 5 iron ore', novice.opened && novice.items[0][0] === ORE_ITEM.iron && novice.items[0][1] === 5, novice.items);

// ---- 3b. the Bleak Mine geodes (economy scan, 11 Oct): three silver veins give one empty soul gem from Miner tier 1 ----
const SILVER_BASE = idOfDesc('a2c30:Skyrim.esm');   // a stand-in base id: only its editor id is read
records.set(SILVER_BASE, { record: { type: 'ACTI', editorId: 'MineOreSilver03' } });
const SOUL_GEMS = ['2e4e2', '2e4e4', '2e4e6', '2e4f4', '2e4fc'].map((l) => idOfDesc(`${l}:Skyrim.esm`));
const workHeartland = (local, rank, actor) => {
  const ref = idOfDesc(`${local}:BSHeartland.esm`);
  props.set(ref + '|baseDesc', 'a2c30:Skyrim.esm');
  ACTOR = actor || 0x14;
  clearRests(ref); setTier(rank);
  out.widgets.length = 0; out.personals.length = 0; out.items.length = 0;
  virtual += 1000000;
  const start = virtual;
  globalThis.__dboLabour(ref, ACTOR);
  const w = out.widgets[out.widgets.length - 1];
  if (!w) return { opened: false, said: out.personals.slice() };
  const st = strikesFor(w);
  virtual = start + st[st.length - 1] + 101;
  out.widgets.length = 0;
  fire('labour', [w.nonce, JSON.stringify(st), st[st.length - 1] + 1]);
  return { opened: true, title: w.title, items: out.items.slice(), result: (out.widgets[0] || {}).result || '' };
};
for (const [i, local] of ['f0076', 'f0071', 'f0073'].entries()) {
  const low = workHeartland(local, 0, 0x200 + i);
  check(`${local}: a Novice miner is refused the geode`, !low.opened && low.said.some((t) => /^Geode is beyond your skill/.test(t)), low.said);
  const r = workHeartland(local, 1);
  check(`${local}: an Apprentice works a Geode and wins one empty soul gem, no silver`, r.opened && r.title === 'Geode' && r.items.length === 1 && SOUL_GEMS.includes(r.items[0][0]) && r.items[0][1] === 1, r);
  check(`${local}: ...told so`, /^The geode cracks open: /.test(r.result), r.result);
}
const silver = workHeartland('f0075', 1);
check('f0075, another Bleak Mine silver vein, still gives silver at its own tier', !silver.opened || (silver.title === 'Silver Seam'), silver);

// ---- 4. gearswap never touches mined meteoric iron ----
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8'));
const G = require(path.join(SERVER, 'gearswap.js'));
const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: readJson('loot-materials.json'), factionGear: readJson('faction-gear.json'), overrides: readJson('loot-overrides.json'), cfg: undefined });
const SWAP = readJson('gear-swap.json');
const lower = (o) => Object.keys(o || {}).map((k) => k.toLowerCase());
const MET = ['601c92:bsassets.esm', '601c91:bsassets.esm'];
check('gear-swap.json maps neither meteoric ore nor ingot (metals, items or ammo)', MET.every((d) => ![SWAP.metals, SWAP.items, SWAP.ammo].some((m) => lower(m).includes(d))));
const DESC = { [ORE_ITEM.meteoriciron]: '601c92:BSAssets.esm', [idOfDesc('601c91:BSAssets.esm')]: '601c91:BSAssets.esm', [ORE_ITEM.iron]: '71cf3:Skyrim.esm' };
const p = G.plan({
  entries: [{ baseId: ORE_ITEM.meteoriciron, count: 6 }, { baseId: idOfDesc('601c91:BSAssets.esm'), count: 2 }, { baseId: ORE_ITEM.iron, count: 5 }],
  descOf: (id) => DESC[id >>> 0] || '', classOf: TIERS.classOf, swap: SWAP, idOf: (d) => { try { return idOfDesc(d); } catch (e) { return 0; } },
  isArtifact: () => false, edidOf: () => '',
});
check('a miner\'s 6 meteoric ore and 2 meteoric ingots go through the sweep untouched', p.swaps.length === 0 && p.entries.length === 3
  && p.entries.some((e) => e.baseId === ORE_ITEM.meteoriciron && e.count === 6) && p.entries.some((e) => e.baseId === idOfDesc('601c91:BSAssets.esm') && e.count === 2), p);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
