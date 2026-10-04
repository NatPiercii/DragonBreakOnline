// The mined metals' restore plan for gearswap.js (Nate, 4 Oct 2026: "Keep mined ores, swap only gear"). The ores players
// mine above steel and the ingots they smelt to (loottiers.js LOOT_ONLY_METALS) came off gear-swap.json's metals list;
// before that the login and container sweeps had swapped them for steel ingots and iron ore. Every GEARSWAP audit line of
// one of them, a character's or a container's, becomes one plan item: gearswap.js gives the original back once, count for
// count, and takes back the plain replacement as far as it is still there (a character at their next login, a container
// the first time it is opened). Read-only on the server; writes one file, which names characters (live data: gitignored).
//   sudo node tools/loot/gearswap_metal_restore_plan.js --out <plan.json> [--since 2026-10-04T02:45:57Z] [--until <iso>]
//        [--log /var/log/skymp-server.log]... [--from <saved audit lines>]...
// Install by copying the file beside gearswap.js as gearswap-restore-metals.json (config gearSwap.metalRestoreFile); a hot
// reload or the file's own change makes it read.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SERVER = path.resolve(__dirname, '..', '..');

const args = { log: [], from: [] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, ''), v = process.argv[i + 1];
  if (k === 'log' || k === 'from') { args[k].push(v); i++; } else if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true;
}
if (!args.out) { console.error('usage: node tools/loot/gearswap_metal_restore_plan.js --out <plan.json> [--since iso] [--until iso] [--log f]... [--from f]...'); process.exit(2); }
// 02:45:57Z, 4 Oct: hotfix-1004b's second pass (gearswap version steelcap-2026-10-04) started swapping again
const SINCE = Date.parse(args.since || '2026-10-04T02:45:57Z');
const UNTIL = args.until ? Date.parse(args.until) : Infinity;
const LOGS = args.log.length || args.from.length ? [...args.log, ...args.from] : ['/var/log/skymp-server.log'];

// The metals that came off the swap's list: by editor id, with the desc the server knows and what the swap gave for each
const LOOT_ONLY = require(path.join(SERVER, 'loottiers.js')).LOOT_ONLY_METALS;
const SWAP = JSON.parse(fs.readFileSync(path.join(SERVER, 'gear-swap.json'), 'utf8'));
const proper = (d) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(d)); if (!m) return String(d); const p = m[2].toLowerCase(); return `${m[1]}:${p === 'skyrim.esm' ? 'Skyrim.esm' : p === 'bsassets.esm' ? 'BSAssets.esm' : m[2]}`; };
const BY_EDID = new Map();
for (const [desc, v] of Object.entries(LOOT_ONLY)) {
  if (SWAP.metals[desc]) continue;   // still swapped: not given back
  BY_EDID.set(v.edid, { from: proper(desc), to: v.to, toEdid: /^5ace5:/i.test(v.to) ? 'IngotSteel' : 'OreIron' });
}

const CHAR = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\].*?audit: GEARSWAP (?!container |take )(.*) #(\S{4}) \(profile (-?\d+)(?:, <@\d+>)?\): (\d+) x (\S+) -> (\S+)/;
const CONT = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\].*?audit: GEARSWAP container ([0-9a-f]+): (\d+) x (\S+) -> (\S+)/;
const lines = [], seen = new Set();
let earlier = 0;
for (const f of LOGS) {
  let text = '';
  try { const buf = fs.readFileSync(f); text = (f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('latin1'); } catch (e) { console.error(`cannot read ${f}: ${e.message}`); continue; }
  for (const raw0 of text.split('\n')) {
    const raw = raw0.replace(/\r$/, '');
    if (raw.indexOf('GEARSWAP') < 0 || seen.has(raw)) continue;
    const c = CONT.exec(raw), m = c ? null : CHAR.exec(raw);
    if (!c && !m) continue;
    const [date, time] = c ? [c[1], c[2]] : [m[1], m[2]];
    const fromEdid = c ? c[5] : m[7], toEdid = c ? c[6] : m[8];
    const metal = BY_EDID.get(fromEdid);
    if (!metal || metal.toEdid !== toEdid) continue;
    const at = Date.parse(`${date}T${time}Z`);
    if (at < SINCE) { earlier++; continue; }
    if (!(at < UNTIL)) continue;
    seen.add(raw);
    lines.push(c ? { at, stamp: `${date}T${time}Z`, ref: c[3], count: Number(c[4]), fromEdid, toEdid, metal }
      : { at, stamp: `${date}T${time}Z`, name: m[3], tag: m[4], profileId: Number(m[5]), count: Number(m[6]), fromEdid, toEdid, metal });
  }
}
lines.sort((a, b) => a.at - b.at);
const ids = new Map();
const characters = new Map(), containers = new Map();
for (const l of lines) {
  const base = l.ref ? `${l.stamp}|c:${l.ref}|${l.fromEdid}>${l.toEdid}` : `${l.stamp}|${l.profileId}|${l.tag}|${l.fromEdid}>${l.toEdid}`;
  const k = (ids.get(base) || 0) + 1; ids.set(base, k);
  const item = { id: k > 1 ? `${base}|${k}` : base, at: l.stamp, count: l.count, from: l.metal.from, fromEdid: l.fromEdid, to: l.metal.to, toEdid: l.toEdid, kind: 'metal' };
  if (l.ref) {
    if (!containers.has(l.ref)) containers.set(l.ref, { ref: l.ref, items: [] });
    containers.get(l.ref).items.push(item);
  } else {
    const key = `${l.profileId}|${l.tag}`;
    if (!characters.has(key)) characters.set(key, { profileId: l.profileId, tag: l.tag, name: l.name, items: [] });
    characters.get(key).items.push(item);
  }
}
const units = (list) => list.reduce((n, c) => n + c.items.reduce((x, i) => x + i.count, 0), 0);
const byMetal = {};
for (const l of lines) byMetal[l.fromEdid] = (byMetal[l.fromEdid] || 0) + l.count;
const plan = {
  _comment: 'Written by tools/loot/gearswap_metal_restore_plan.js: mined ores and their ingots gearswap.js swapped for steel or iron before they came off its list (Nate, 4 Oct 2026). gearswap.js gives each back once (private.dboGearRestore): a character at the next login, a container the first time it is opened. Live data: gitignored, names characters.',
  version: `metalrestore-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
  since: new Date(SINCE).toISOString(), until: Number.isFinite(UNTIL) ? new Date(UNTIL).toISOString() : null, logs: LOGS,
  counts: { lines: lines.length, characters: characters.size, characterUnits: units([...characters.values()]), containers: containers.size, containerUnits: units([...containers.values()]), byMetal, earlierLines: earlier },
  characters: [...characters.values()], containers: [...containers.values()],
};
fs.writeFileSync(args.out, JSON.stringify(plan, null, 1) + '\n', { mode: 0o640 });
console.log(`${lines.length} swap line(s) of a mined metal since ${plan.since}: ${plan.counts.characterUnits} unit(s) for ${characters.size} character(s), ${plan.counts.containerUnits} in ${containers.size} container(s); by metal ${JSON.stringify(byMetal)}; ${earlier} earlier line(s) left out (--since)`);
for (const c of plan.characters) for (const i of c.items) console.log(`  ${c.name} #${c.tag} (profile ${c.profileId}): ${i.count} x ${i.fromEdid} back for ${i.toEdid} [${i.at}]`);
for (const c of plan.containers) for (const i of c.items) console.log(`  container ${c.ref}: ${i.count} x ${i.fromEdid} back for ${i.toEdid} [${i.at}]`);
console.log(`wrote ${args.out}`);
