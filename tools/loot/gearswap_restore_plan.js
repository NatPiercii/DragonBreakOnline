// The restore plan for gearswap.js: which characters had an enchanted piece swapped plain (3-4 Oct 2026, before the swap
// kept enchantments) and what goes back on its replacement at their next login. Read-only on the server; writes one file.
//   sudo node tools/loot/gearswap_restore_plan.js --out <plan.json> [--since 2026-10-03T23:52:00Z] [--until <iso>]
//        [--log /var/log/skymp-server.log.1 --log /var/log/skymp-server.log] [--backups /opt/skymp-backups/world]
//        [--order /opt/alduinak/deploy/skyrim-data/loadorder.txt] [--data /opt/skyrim-data]
// Each audit line "GEARSWAP <who>: <n> x <from> -> <to>[ (worn)] (enchanted)" (a container line never says enchanted)
// becomes one plan item, with an id from its time and text so it is restored once. The original entry's extras (a
// player's enchantment, the charge left) come from the newest hourly world backup taken before the swap in which that
// character is not yet swapped; an item enchanted by its own record (EITM) needs none of that, the server reads the
// record at the restore. A line whose original was only tempered or named is listed under "skipped", as is one whose
// player enchantment no backup holds. The file names characters (it stays on the box: gitignored, never committed).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..', '..');

const args = { log: [], backups: [] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, ''), v = process.argv[i + 1];
  if (k === 'log' || k === 'backups') { args[k].push(v); i++; } else if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true;
}
if (!args.out) { console.error('usage: node tools/loot/gearswap_restore_plan.js --out <plan.json> [--since iso] [--until iso] [--log f]... [--backups dir]... [--order f] [--data dir]'); process.exit(2); }
const SINCE = Date.parse(args.since || '2026-10-03T23:52:00Z');
const UNTIL = args.until ? Date.parse(args.until) : Infinity;
const LOGS = args.log.length ? args.log : ['/var/log/skymp-server.log.1', '/var/log/skymp-server.log'];
const BACKUPS = args.backups.length ? args.backups : ['/opt/skymp-backups/world'];
const ORDER = args.order || '/opt/alduinak/deploy/skyrim-data/loadorder.txt';
const DATA = args.data || '/opt/skyrim-data';
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
const G = require(path.join(SERVER, 'gearswap.js'));

// ---- the server's ids (as tools/loot/gearswap_dryrun.js): full plugins by index, light ones in the 0xFE space ----
const names = fs.readFileSync(ORDER, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim().replace(/^\*/, '')).filter((l) => l && !l.startsWith('#'));
const full = [], light = [];
for (const n of names) {
  let isLight = /\.esl$/i.test(n);
  try { const fd = fs.openSync(path.join(DATA, n), 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd); if (b.readUInt32LE(8) & 0x200) isLight = true; } catch (e) { /* missing */ }
  (isLight ? light : full).push(n);
}
const descOf = (id) => {
  id = id >>> 0;
  if ((id >>> 24) === 0xfe) { const n = light[(id >>> 12) & 0xfff]; return n ? `${(id & 0xfff).toString(16)}:${n}` : ''; }
  const n = full[id >>> 24]; return n ? `${(id & 0xffffff).toString(16)}:${n}` : '';
};
// The server's getIdFromDesc matches the plugin's file name exactly (FormDesc::ToFormId), and gear-swap.json keys are
// lower case: the plan names each plugin as the load order spells it
const proper = (d) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(d || '')); if (!m) return String(d || ''); const n = names.find((x) => x.toLowerCase() === m[2].toLowerCase()); return `${parseInt(m[1], 16).toString(16)}:${n || m[2]}`; };
const norm = (d) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(d || '')); return m ? `${parseInt(m[1], 16).toString(16)}:${m[2].toLowerCase()}` : String(d || '').toLowerCase(); };

// ---- a record's own enchantment, read from its plugin (the report only; the server reads the winning record) ----
const plugins = new Map();
const recordsOf = (file) => {
  if (plugins.has(file)) return plugins.get(file);
  const out = new Map();
  try {
    const buf = fs.readFileSync(path.join(DATA, file));
    const hsize = buf.readUInt32LE(4);
    let masters = 0;
    for (let i = 24; i + 6 <= 24 + hsize;) { const sig = buf.toString('latin1', i, i + 4), sz = buf.readUInt16LE(i + 4); if (sig === 'MAST') masters++; i += 6 + sz; }
    const walk = (pos, end) => {
      while (pos + 24 <= end) {
        const sig = buf.toString('latin1', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
        if (sig === 'GRUP') { const label = buf.toString('latin1', pos + 8, pos + 12), type = buf.readUInt32LE(pos + 12); if (type !== 0 || label === 'WEAP' || label === 'ARMO') walk(pos + 24, pos + size); pos += size; continue; }
        const flags = buf.readUInt32LE(pos + 8), fid = buf.readUInt32LE(pos + 12);
        if ((sig === 'WEAP' || sig === 'ARMO') && (fid >>> 24) === masters) {
          let d = buf.subarray(pos + 24, pos + 24 + size);
          if (flags & 0x40000) { try { d = zlib.inflateSync(d.subarray(4)); } catch (e) { d = Buffer.alloc(0); } }
          const rec = { type: sig };
          for (let i = 0; i + 6 <= d.length;) { const s = d.toString('latin1', i, i + 4), z = d.readUInt16LE(i + 4); if (s === 'EITM' && z >= 4) rec.eitm = d.readUInt32LE(i + 6); if (s === 'EAMT' && z >= 2) rec.eamt = d.readUInt16LE(i + 6); if (s === 'EDID') rec.edid = d.toString('latin1', i + 6, i + 6 + z).replace(/\0+$/, ''); i += 6 + z; }
          out.set(fid & 0xffffff, rec);
        }
        pos += 24 + size;
      }
    };
    walk(24 + hsize, buf.length);
  } catch (e) { console.error(`cannot read ${file}: ${e.message}`); }
  plugins.set(file, out);
  return out;
};
const recordAt = (desc) => { const m = /^([0-9a-f]+):(.+)$/i.exec(String(desc)); if (!m) return null; const file = names.find((n) => n.toLowerCase() === m[2].toLowerCase()); return file ? recordsOf(file).get(parseInt(m[1], 16)) || null : null; };

// ---- the audit lines ----
const LINE = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\].*?audit: GEARSWAP (?!container )(.*) #(\S{4}) \(profile (-?\d+)(?:, <@\d+>)?\): (\d+) x (\S+) -> (\S+)( \(worn\))? \(enchanted\)\s*$/;
const lines = [];
for (const f of LOGS) {
  let text = ''; try { text = fs.readFileSync(f, 'latin1'); } catch (e) { console.error(`cannot read ${f}: ${e.message}`); continue; }
  for (const raw of text.split('\n')) {
    if (raw.indexOf('GEARSWAP') < 0) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}Z`);
    if (!(at >= SINCE && at < UNTIL)) continue;
    lines.push({ at, stamp: `${m[1]}T${m[2]}Z`, name: m[3], tag: m[4], profileId: Number(m[5]), count: Number(m[6]), fromEdid: m[7], toEdid: m[8], worn: !!m[9], text: raw.slice(raw.indexOf('GEARSWAP')) });
  }
}
lines.sort((a, b) => a.at - b.at);
// One id per line: its time, character and text, and a counter for the rare identical line in the same millisecond
const seenIds = new Map();
for (const l of lines) {
  const base = `${l.stamp}|${l.profileId}|${l.tag}|${l.fromEdid}>${l.toEdid}`;
  const k = (seenIds.get(base) || 0) + 1; seenIds.set(base, k);
  l.id = k > 1 ? `${base}|${k}` : base;
}

// ---- the world backups, newest first: world-<stamp>.tar.gz or extracted folders holding changeForms ----
const stampOf = (s) => { const m = /(\d{8})T(\d{6})Z/.exec(s); return m ? Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4)}Z`) : NaN; };
const backupList = [];
for (const b of BACKUPS) {
  let st = null; try { st = fs.statSync(b); } catch (e) { continue; }
  const items = st.isDirectory() && !fs.existsSync(path.join(b, 'state')) && !fs.existsSync(path.join(b, 'changeForms')) ? fs.readdirSync(b).map((f) => path.join(b, f)) : [b];
  for (const p of items) { const t = stampOf(path.basename(p)); if (Number.isFinite(t) && (p.endsWith('.tar.gz') || fs.statSync(p).isDirectory())) backupList.push({ at: t, path: p }); }
}
backupList.sort((a, b) => b.at - a.at);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gearrestore-'));
const loaded = new Map();
const charactersIn = (b) => {
  if (loaded.has(b.path)) return loaded.get(b.path);
  let dir = '';
  if (b.path.endsWith('.tar.gz')) {
    const to = path.join(TMP, path.basename(b.path, '.tar.gz'));
    fs.mkdirSync(to, { recursive: true });
    try { execFileSync('tar', ['-xzf', b.path, '-C', to, 'state/world/changeForms'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { console.error(`cannot extract ${b.path}: ${e.message}`); }
    dir = path.join(to, 'state/world/changeForms');
  } else dir = [path.join(b.path, 'state/world/changeForms'), path.join(b.path, 'world/changeForms'), path.join(b.path, 'changeForms')].find((d) => fs.existsSync(d)) || b.path;
  const chars = new Map();
  let files = []; try { files = fs.readdirSync(dir); } catch (e) { files = []; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    if (d.recType !== 1 || !(Number(d.profileId) >= 0)) continue;
    const dyn = typeof d.dynamicFields === 'string' ? readJsonText(d.dynamicFields) : (d.dynamicFields || {});
    const tag = dyn['private.charTag'];
    if (typeof tag !== 'string') continue;
    const inv = typeof d.inv === 'string' ? readJsonText(d.inv) : d.inv;
    chars.set(`${Number(d.profileId)}|${tag}`, { formDesc: String(d.formDesc || f.replace(/\.json$/, '')), swapped: !!(dyn['private.dboGearSwap'] && dyn['private.dboGearSwap'].version), entries: (inv && inv.entries) || [] });
  }
  if (b.path.endsWith('.tar.gz')) fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  loaded.set(b.path, chars);
  return chars;
};
function readJsonText(t) { try { return JSON.parse(t); } catch (e) { return {}; } }

// ---- the plan ----
const SWAP = readJson(path.join(SERVER, 'gear-swap.json'), { items: {} });
const candidatesOf = (fromEdid, toEdid) => Object.entries(SWAP.items || {}).filter(([, v]) => v.edid === fromEdid && v.toEdid === toEdid).map(([k, v]) => ({ from: k, to: v.to }));
const KEEP = ['enchantmentId', 'enchantmentEffects', 'maxCharge', 'chargePercent', 'removeEnchantmentOnUnequip', 'name'];
const used = new Map(); // backup entry already given to an earlier line of the same character
const characters = new Map(), skipped = [];
for (const l of lines) {
  const cands = candidatesOf(l.fromEdid, l.toEdid);
  if (!cands.length) { skipped.push({ id: l.id, line: l.text, why: 'no gear-swap.json item with these editor ids' }); continue; }
  // The newest backup before the swap where this character is not swapped yet
  let found = null;
  for (const b of backupList) {
    if (b.at > l.at) continue;
    const c = charactersIn(b).get(`${l.profileId}|${l.tag}`);
    if (!c) continue;
    if (c.swapped) continue;
    const key = `${b.path}|${l.profileId}|${l.tag}`;
    const taken = used.get(key) || new Set();
    const hits = c.entries.map((e, i) => ({ e, i })).filter(({ e, i }) => !taken.has(i) && cands.some((x) => norm(x.from) === norm(descOf(Number(e.baseId)))));
    // An enchanted copy first, then a charged one, then any
    hits.sort((a, b) => score(b.e) - score(a.e));
    if (hits.length) { taken.add(hits[0].i); used.set(key, taken); found = { backup: path.basename(b.path), formDesc: c.formDesc, entry: hits[0].e }; }
    else found = { backup: path.basename(b.path), formDesc: c.formDesc, entry: null };
    break;
  }
  function score(e) { return (e.enchantmentId || (e.enchantmentEffects && e.enchantmentEffects.length) ? 4 : 0) + (Number(e.chargePercent) > 0 ? 2 : 0) + (e.name ? 1 : 0); }
  const entry = found && found.entry;
  const from = entry ? descOf(Number(entry.baseId)) : (cands.length === 1 ? cands[0].from : '');
  const cand = cands.find((x) => norm(x.from) === norm(from)) || (cands.length === 1 ? cands[0] : null);
  if (!cand) { skipped.push({ id: l.id, line: l.text, why: `${cands.length} items share these editor ids and no backup says which` }); continue; }
  const rec = recordAt(cand.from);
  const own = !!(entry && (entry.enchantmentId || (entry.enchantmentEffects && entry.enchantmentEffects.length)));
  const kind = own ? 'crafted' : rec && rec.eitm ? 'record' : '';
  if (!kind) {
    const why = entry ? `not enchanted: the original carried only ${Object.keys(entry).filter((k) => !['baseId', 'count', 'worn', 'wornLeft'].includes(k)).join(', ') || 'nothing'}` : 'no backup holds the original, and its record has no enchantment of its own';
    skipped.push({ id: l.id, line: l.text, why }); continue;
  }
  const extras = {};
  if (entry) for (const k of KEEP) if (entry[k] !== undefined && entry[k] !== null && entry[k] !== 0 && entry[k] !== '') extras[k] = entry[k];
  const key = `${l.profileId}|${l.tag}`;
  if (!characters.has(key)) characters.set(key, { profileId: l.profileId, tag: l.tag, name: l.name, formDesc: (found && found.formDesc) || '', items: [] });
  const ch = characters.get(key);
  if (!ch.formDesc && found) ch.formDesc = found.formDesc;
  ch.items.push({ id: l.id, at: l.stamp, count: l.count, from: proper(cand.from), fromEdid: l.fromEdid, to: proper(cand.to), toEdid: l.toEdid, worn: l.worn, kind,
    enchantment: kind === 'record' ? { local: rec.eitm.toString(16), charge: rec.type === 'WEAP' ? rec.eamt || 0 : 0 } : undefined,
    source: found ? (found.entry ? found.backup : `${found.backup} (original not found)`) : 'no backup', extras });
}
fs.rmSync(TMP, { recursive: true, force: true });
const plan = {
  _comment: 'Written by tools/loot/gearswap_restore_plan.js: enchanted pieces gearswap.js swapped plain (3-4 Oct 2026). gearswap.js puts each enchantment back at the character\'s next login, once per item (private.dboGearRestore). Live data: gitignored, names characters.',
  version: `gearrestore-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
  since: new Date(SINCE).toISOString(), until: Number.isFinite(UNTIL) ? new Date(UNTIL).toISOString() : null,
  logs: LOGS, backups: backupList.map((b) => path.basename(b.path)).slice(0, 48),
  counts: { lines: lines.length, characters: characters.size, items: [...characters.values()].reduce((n, c) => n + c.items.length, 0),
    record: [...characters.values()].reduce((n, c) => n + c.items.filter((i) => i.kind === 'record').length, 0),
    crafted: [...characters.values()].reduce((n, c) => n + c.items.filter((i) => i.kind === 'crafted').length, 0), skipped: skipped.length },
  characters: [...characters.values()],
  skipped,
};
fs.writeFileSync(args.out, JSON.stringify(plan, null, 1) + '\n', { mode: 0o640 });
console.log(`${lines.length} enchanted swap line(s) since ${plan.since}: ${plan.counts.items} item(s) for ${plan.counts.characters} character(s) to restore (${plan.counts.record} by their record's enchantment, ${plan.counts.crafted} player enchantments), ${skipped.length} skipped`);
for (const c of plan.characters) for (const i of c.items) console.log(`  ${c.name} #${c.tag} (profile ${c.profileId}): ${i.count} x ${i.fromEdid} -> ${i.toEdid}: ${i.kind}${i.extras.chargePercent ? `, charge ${Math.round(i.extras.chargePercent)}` : ''} [${i.source}]`);
for (const s of skipped) console.log(`  skipped: ${s.line.replace(/ \(profile [^)]*\)/, '')}: ${s.why}`);
console.log(`wrote ${args.out}`);
