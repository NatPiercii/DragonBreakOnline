// Scripted test for the Beyond Skyrim activators in gamemode.js: a wisp stalk gives its ingredient by Harvesting tier and
// then rests for everyone; an Ayleid well restores magicka once per player per game day and then regenerates it for a
// while. Which base is a stalk or a well, and the ingredient and spell they hand out, come from the REAL records: the
// VMAD of BSAssets' and BSHeartland's bases is read out of the plugins (skipped where the plugins are not on the box).
// The section is cut out of gamemode.js (from its banner to the world containers banner) and run with stubs.
//
//   node tests/bsactivators-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf('// ---- Beyond Skyrim activators the server runs itself');
const end = src.indexOf('// ---- world containers outside dungeons hold nothing');
if (start < 0 || end < start) { console.log('FAIL the section markers are gone from gamemode.js'); process.exit(1); }

// ---- the real records ------------------------------------------------------------------------------------------------
const DATA = process.env.DBO_PLUGINS || '/opt/skyrim-data';
// Load order positions (fork deploy/skyrim-data/loadorder.txt): Skyrim.esm 0x00, BSAssets 0x07, BSHeartland 0x08
const LOAD = { 'Skyrim.esm': 0x00, 'BSAssets.esm': 0x07, 'BSHeartland.esm': 0x08 };
const readPlugin = (name) => {
  const b = fs.readFileSync(path.join(DATA, name));
  const hs = b.readUInt32LE(4); const masters = []; let p = 24;
  while (p < 24 + hs) { const t = b.toString('latin1', p, p + 4); const l = b.readUInt16LE(p + 4); if (t === 'MAST') masters.push(b.toString('latin1', p + 6, p + 6 + l - 1)); p += 6 + l; }
  return { name, b, masters };
};
// The record with this plugin-local id, as mp.lookupEspmRecordById gives it: its fields, and toGlobalRecordId
const recordIn = (pl, local) => {
  const want = ((pl.masters.length << 24) | local) >>> 0; const b = pl.b; let p = 0;
  while (p < b.length) {
    const t = b.toString('latin1', p, p + 4); const sz = b.readUInt32LE(p + 4);
    if (t === 'GRUP') { p += 24; continue; }
    const fl = b.readUInt32LE(p + 8); const fid = b.readUInt32LE(p + 12);
    if (fid === want) {
      let d = b.subarray(p + 24, p + 24 + sz); if (fl & 0x40000) d = zlib.inflateSync(d.subarray(4));
      const fields = []; let q = 0;
      while (q < d.length) { const st = d.toString('latin1', q, q + 4); const l = d.readUInt16LE(q + 4); fields.push({ type: st, data: new Uint8Array(d.subarray(q + 6, q + 6 + l)) }); q += 6 + l; }
      const edid = (fields.find((f) => f.type === 'EDID') || {}).data;
      const order = pl.masters.concat([pl.name]);
      return { record: { type: t, editorId: edid ? Buffer.from(edid).toString('latin1').replace(/\0$/, '') : '', fields },
        toGlobalRecordId: (id) => (((LOAD[order[id >>> 24]] || 0) << 24) | (id & 0xffffff)) >>> 0 };
    }
    p += 24 + sz;
  }
  return null;
};
let plugins = null;
try { plugins = { 'BSAssets.esm': readPlugin('BSAssets.esm'), 'BSHeartland.esm': readPlugin('BSHeartland.esm') }; } catch (e) { plugins = null; }
if (!plugins) { console.log(`SKIP  the plugins are not readable in ${DATA}; set DBO_PLUGINS`); process.exit(0); }
const RECORDS = new Map([
  [0x076025b4, recordIn(plugins['BSAssets.esm'], 0x6025b4)],       // BSKFloraWispStalk01Small
  [0x076025b3, recordIn(plugins['BSAssets.esm'], 0x6025b3)],       // BSKFloraWispStalk01SmallCaveDirt
  [0x08061b5b, recordIn(plugins['BSHeartland.esm'], 0x61b5b)],     // CYRAyleidWellActivator
]);

const STALK = 0x07079800, STALK2 = 0x07079801, WELL = 0x020d6a3a, WELL2 = 0x020d6a3b, BARREL = 0x00012345;
const ME = 0xff000014, NOVICE = 0xff000015;
const bases = { [STALK]: '6025b4:BSAssets.esm', [STALK2]: '6025b3:BSAssets.esm', [WELL]: '61b5b:BSHeartland.esm', [WELL2]: '61b5b:BSHeartland.esm', [BARREL]: '12345:Skyrim.esm' };
const props = new Map();
const mp = {
  get: (id, p) => (p === 'baseDesc' ? bases[id] : props.get(id + '|' + p)),
  set: (id, p, v) => props.set(id + '|' + p, v),
  getIdFromDesc: (d) => { const [local, plugin] = String(d).split(':'); return ((LOAD[plugin] << 24) | parseInt(local, 16)) >>> 0; },
  lookupEspmRecordById: (id) => RECORDS.get(id >>> 0) || { record: null },
};
const said = []; const audits = []; const given = []; const events = [];
const personal = (a, t) => said.push({ a, t });
const giveItem = (a, id, n) => { given.push({ a, id, n }); return true; };
const tiers = { [ME]: 4, [NOVICE]: -1 };
const harvestingTier = (a) => tiers[a];
const HARVESTING = { yieldChanceByTier: [0.6, 0.7, 0.8, 0.9, 1], yieldMultiplierByTier: [1, 1.25, 1.5, 1.75, 2], unskilled: { yieldChance: 0.25, yieldMultiplier: 0.5 } };
let day = 10.5;
globalThis.__dboClock = { gameDays: () => day };
globalThis.__alduinakMasteryEvent = (kind, a, d) => events.push({ kind, a, d });
delete globalThis.__dboWispRest; delete globalThis.__dboWellRegen;
const packets = []; const ticks = {};
new Function('mp', 'personal', 'log', 'audit', 'who', 'cfg', 'giveItem', 'harvestingTier', 'HARVESTING', 'sendPacket', 'profileOf', 'every', src.slice(start, end))(
  mp, personal, () => {}, (t) => audits.push(t), (a) => `P${a.toString(16)}`, {}, giveItem, harvestingTier, HARVESTING, (a, p) => packets.push({ a, p }),
  (a) => (a === ME || a === NOVICE ? 1 : -1), (name, ms, fn) => { ticks[name] = { ms, fn }; });

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined && !ok ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };
const last = () => (said[said.length - 1] || {}).t;
let now = 1_000_000; const realNow = Date.now; Date.now = () => now;
const rnd = Math.random;

// ---- the records say what they are ----------------------------------------------------------------------------------
const WISP_ITEM = mp.getIdFromDesc('601924:BSAssets.esm'); const WELL_SPELL = mp.getIdFromDesc('61b66:BSHeartland.esm');
check('the real stalk and well bases were found in the plugins', [...RECORDS.values()].every((r) => r && r.record && r.record.type === 'ACTI'), [...RECORDS.values()].map((r) => r && r.record && r.record.editorId));

// ---- wisp stalks -----------------------------------------------------------------------------------------------------
check('an npc gets nothing from a stalk or a well (review WISP-1)', globalThis.__dboWispStalk(STALK, 0xff0000aa) === false && globalThis.__dboAyleidWell(WELL, 0xff0000aa) === false);
check('an activator whose record carries neither script passes through', globalThis.__dboWispStalk(BARREL, ME) === false && globalThis.__dboAyleidWell(BARREL, ME) === false);
check('a stalk is not a well, nor a well a stalk', globalThis.__dboAyleidWell(STALK, ME) === false && globalThis.__dboWispStalk(WELL, ME) === false);
Math.random = () => 0.5;
check('a master harvester picks a wisp stalk: double yield of the ingredient its VMAD names (BSKWispStalk 601924)', globalThis.__dboWispStalk(STALK, ME) === true && given[0].id === WISP_ITEM && given[0].n === 2 && /harvest 2 Wisp Stalks/.test(last()), given[0]);
check('the harvest counts toward Harvesting', events.length === 1 && events[0].d.refrId === STALK);
check('the stalk then rests for everyone, with a short line', globalThis.__dboWispStalk(STALK, NOVICE) === true && given.length === 1 && /has been picked\. It grows back in about 6 hour/.test(last()), last());
now += 6 * 3600000 + 1;
Math.random = () => 0.2;
check('after six hours it can be picked again; an unskilled hand has a 25% chance and gets one', globalThis.__dboWispStalk(STALK, NOVICE) === true && given.length === 2 && given[1].n === 1 && /harvest Wisp Stalk\./.test(last()));
Math.random = () => 0.3;
check('the cave-dirt stalk (another base, same script) crumbles past that chance, and still rests', globalThis.__dboWispStalk(STALK2, NOVICE) === true && given.length === 2 && /crumbles/.test(last()) && globalThis.__dboWispStalk(STALK2, ME) === true && given.length === 2);

// ---- Ayleid wells ----------------------------------------------------------------------------------------------------
mp.set(ME, 'percentages', { health: 0.8, magicka: 0.1, stamina: 0.5 });
check('an Ayleid well restores magicka and keeps health and stamina', globalThis.__dboAyleidWell(WELL, ME) === true && JSON.stringify(mp.get(ME, 'percentages')) === JSON.stringify({ health: 0.8, magicka: 1, stamina: 0.5 }));
check('it is audited', /^WELL Pff000014 drew on the Ayleid well 20d6a3a/.test(audits[0] || ''));
check('the client is asked to cast the spell the well\'s VMAD names (AyleidAbility, CYRAyleidWellSpell 61b66)', packets.length === 1 && packets[0].a === ME && packets[0].p.customPacketType === 'dboCastSelf' && packets[0].p.spell === WELL_SPELL, packets[0]);
check('the message says the magicka flows back faster for five minutes', /restored, and flows back faster for 5 minutes/.test(last()), last());
// Regeneration, applied by the server through the percentage
const tick = ticks.ayleidWellRegen;
check('the regeneration ticks every 5 seconds', !!tick && tick.ms === 5000);
mp.set(ME, 'percentages', { health: 0.8, magicka: 0.5, stamina: 0.5 });
now += 5000; tick.fn();
check('each tick adds 2% magicka and nothing else', JSON.stringify(mp.get(ME, 'percentages')) === JSON.stringify({ health: 0.8, magicka: 0.52, stamina: 0.5 }), mp.get(ME, 'percentages'));
mp.set(ME, 'percentages', { health: 0.8, magicka: 0.99, stamina: 0.5 });
now += 5000; tick.fn();
check('it never goes past full', mp.get(ME, 'percentages').magicka === 1);
mp.set(ME, 'percentages', { health: 0, magicka: 0.2, stamina: 0 });
now += 5000; tick.fn();
check('the dead do not regenerate', mp.get(ME, 'percentages').magicka === 0.2);
mp.set(ME, 'percentages', { health: 0.8, magicka: 0.2, stamina: 0.5 });
now += 300000; tick.fn();
check('after five minutes it stops', mp.get(ME, 'percentages').magicka === 0.2 && !globalThis.__dboWellRegen.has(ME));
// Once per player per game day, at any well
mp.set(NOVICE, 'percentages', { health: 1, magicka: 0, stamina: 1 });
check('another player draws on the same well the same day', globalThis.__dboAyleidWell(WELL, NOVICE) === true && mp.get(NOVICE, 'percentages').magicka === 1);
now += 2000;
check('the first player cannot drink again that day, at this well or another', globalThis.__dboAyleidWell(WELL2, ME) === true && mp.get(ME, 'percentages').magicka === 0.2 && /drunk the Ayleids' starlight today/.test(last()), last());
const casts = packets.length;
day = 10.99;
check('a refusal asks for no cast, and still refuses before midnight', globalThis.__dboAyleidWell(WELL, ME) === true && packets.length === casts && mp.get(ME, 'percentages').magicka === 0.2);
day = 11.01;
check('after the world clock passes midnight a well answers again', globalThis.__dboAyleidWell(WELL2, ME) === true && mp.get(ME, 'percentages').magicka === 1 && packets.length === casts + 1);

Math.random = rnd; Date.now = realNow;
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
