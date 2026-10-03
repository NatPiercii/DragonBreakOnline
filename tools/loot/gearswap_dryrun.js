// What the steel-cap gear swap (gearswap.js) WOULD take, read from the world's change forms. Read-only.
//   sudo node tools/loot/gearswap_dryrun.js [changeForms dir] [loadorder.txt] [data dir] [house-cells.json] [server-settings.json] [gamemode-config.json]
// house-cells.json comes from tools/loot/house_cells.py. Staff (left alone) follow gamemode.js tierOf: admin profile ids,
// then the Discord roles stored on the character against server-settings adminRoles. No role or profile id is printed.
// Counts per character (names stay internal), the totals by family and replacement, the skipped artifacts and
// unmapped pieces, and what player-owned containers hold (counted only; Nate decides).
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..', '..');
const [dir = '/opt/skymp-state/world/changeForms', order = path.join(process.env.HOME || '/home/nate', 'dragonbreak/fork/deploy/skyrim-data/loadorder.txt'), data = '/opt/skyrim-data',
  houseCellsFile = '', settingsFile = '/opt/alduinak/build/dist/server/server-settings.json', configFile = '/opt/alduinak/build/dist/server/gamemode-config.json'] = process.argv.slice(2);
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };

// The server's ids: a full plugin by its index among full plugins, a light one (ESL flag) in the 0xFE space
const names = fs.readFileSync(order, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim().replace(/^\*/, '')).filter((l) => l && !l.startsWith('#'));
const full = [], light = [];
for (const n of names) {
  let isLight = /\.esl$/i.test(n);
  try { const fd = fs.openSync(path.join(data, n), 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd); if (b.readUInt32LE(8) & 0x200) isLight = true; } catch (e) { /* missing */ }
  (isLight ? light : full).push(n);
}
const descOf = (id) => {
  id = id >>> 0;
  if ((id >>> 24) === 0xfe) { const n = light[(id >>> 12) & 0xfff]; return n ? `${(id & 0xfff).toString(16)}:${n}` : ''; }
  const n = full[id >>> 24]; return n ? `${(id & 0xffffff).toString(16)}:${n}` : '';
};
const idOf = (desc) => {
  const m = /^([0-9a-f]+):(.+)$/i.exec(String(desc)); if (!m) return 0;
  const local = parseInt(m[1], 16), lower = m[2].toLowerCase();
  const fi = full.findIndex((n) => n.toLowerCase() === lower); if (fi >= 0) return ((fi << 24) | local) >>> 0;
  const li = light.findIndex((n) => n.toLowerCase() === lower); if (li >= 0) return (0xfe000000 | (li << 12) | (local & 0xfff)) >>> 0;
  return 0;
};

const TIERS = require(path.join(SERVER, 'loottiers.js'))({ materials: readJson(path.join(SERVER, 'loot-materials.json'), { items: {} }),
  factionGear: readJson(path.join(SERVER, 'faction-gear.json'), { items: {} }), overrides: readJson(path.join(SERVER, 'loot-overrides.json'), { never: {} }), cfg: undefined });
const SWAP = readJson(path.join(SERVER, 'gear-swap.json'), { items: {}, metals: {} });
const pats = (readJson(path.join(SERVER, 'artifacts.json'), { patterns: [] }).patterns || []);
const ARTIFACT = new RegExp(pats.map((p) => `(?:${p})`).join('|'), 'i');
const { plan, wornIn } = require(path.join(SERVER, 'gearswap.js'));

const norm = (d) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(d || '')); return m ? `${parseInt(m[1], 16).toString(16)}:${m[2].toLowerCase()}` : String(d || '').toLowerCase(); };
const houseCells = new Set((houseCellsFile ? readJson(houseCellsFile, []) : []).map(norm));
const settings = readJson(settingsFile, {});
const gcfg = readJson(configFile, {});
const staffProfiles = new Set([...(settings.adminProfileIds || []), ...(gcfg.admins || [])].map(Number));
const staffRoles = new Set([].concat(...Object.values(settings.adminRoles || {}).map((v) => (Array.isArray(v) ? v.map(String) : [])), (settings.adminRoleIds || []).map(String)));
const isStaff = (d) => staffProfiles.has(Number(d.profileId)) || ((d.dynamicFields || {})['private.discordRoles'] || []).some((r) => staffRoles.has(String(r)));

const perChar = [], byFamily = {}, byTo = {}, containers = { refs: 0, items: 0, inHouses: 0, houseRefs: 0, byFamily: {} };
let artifacts = 0, unmapped = 0, worn = 0, enchanted = 0, metals = 0, ammo = 0, staffSkipped = 0, staffItems = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
  const entries = (d.inv && d.inv.entries) || [];
  if (!entries.length) continue;
  const p = plan({ entries, descOf, classOf: TIERS.classOf, swap: SWAP, idOf, isArtifact: (e) => ARTIFACT.test(e), worn: wornIn(d.equipmentDump) });
  const n = p.swaps.reduce((a, s) => a + s.count, 0);
  const isChar = Number(d.profileId) >= 0 && d.recType === 1;
  if (!isChar) {
    if (n && d.recType !== 1) {
      containers.refs++; containers.items += n;
      if (houseCells.has(norm(d.worldOrCellDesc))) { containers.inHouses += n; containers.houseRefs++; }
      for (const s of p.swaps) containers.byFamily[s.family] = (containers.byFamily[s.family] || 0) + s.count;
    }
    continue;
  }
  if (isStaff(d)) { if (n) { staffSkipped++; staffItems += n; } continue; }
  artifacts += p.skipped.artifact; unmapped += p.skipped.unmapped;
  if (!n) continue;
  for (const s of p.swaps) {
    byFamily[s.family] = (byFamily[s.family] || 0) + s.count;
    byTo[s.toEdid] = (byTo[s.toEdid] || 0) + s.count;
    if (s.worn || s.wornLeft) worn += s.count;
    if (s.enchanted) enchanted += s.count;
    if (s.family === 'ammo') ammo += s.count; else if (s.metal) metals += s.count;
  }
  perChar.push({ profile: Number(d.profileId), char: f.replace('.json', ''), items: n, worn: p.swaps.filter((s) => s.worn || s.wornLeft).length });
}
perChar.sort((a, b) => b.items - a.items);
const total = perChar.reduce((a, c) => a + c.items, 0);
console.log(`characters with something to swap: ${perChar.length}; items: ${total} (worn ${worn}, enchanted ${enchanted}, metals ${metals}, arrows and bolts ${ammo})`);
console.log(`staff left alone: ${staffSkipped} character(s) holding ${staffItems} item(s)`);
console.log(`kept: artifacts ${artifacts}, above the cap but without a replacement ${unmapped}`);
console.log('by family:', JSON.stringify(Object.entries(byFamily).sort((a, b) => b[1] - a[1])));
console.log('replacements given:', JSON.stringify(Object.entries(byTo).sort((a, b) => b[1] - a[1])));
console.log(`containers (swapped once, as they are opened): ${containers.items} item(s) in ${containers.refs} container(s); in claimed houses ${containers.inHouses} item(s) in ${containers.houseRefs}`);
console.log('containers by family:', JSON.stringify(Object.entries(containers.byFamily).sort((a, b) => b[1] - a[1])));
console.log('per character (profile, change form, items, worn):');
for (const c of perChar) console.log(`  p${c.profile} ${c.char} ${c.items} ${c.worn}`);
