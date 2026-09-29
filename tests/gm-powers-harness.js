// A GM observes; owner powers are for a Lead GM and above (claude-jake's review A3, 2026-09-28). Loads the real
// guilds.js and playermenu.js against stub apis with three staff-less and staff actors, and checks each refusal:
//   A3-4  naming a faction's leader, removing members and inviting are refused to a GM, allowed to a Lead GM
//   A3-5  /masktest, /faction leader and /faction remove are in the gamemode's Lead-GM-only list
//   A3-7  a GM is not lawful (no instant restraint, no guard at a cell door, no freeing the bound) unless they hold a
//         rank like anyone else; a Lead GM is; a staff target is still asked before being bound
//
//   node tests/gm-powers-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let fail = 0;
const ok = (c, what, extra) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || extra === undefined ? '' : ': ' + JSON.stringify(extra)}`); if (!c) fail++; };

const PLAYER = 0x14, GM = 0x15, LEAD = 0x16, GUARD = 0x17;
const TIER = { [GM]: 'gm', [LEAD]: 'leadgm' };
const isAdmin = (a) => TIER[a] !== undefined;
const isLeadStaff = (a) => TIER[a] !== undefined && TIER[a] !== 'gm';
const names = { [PLAYER]: 'Player', [GM]: 'Gamemaster', [LEAD]: 'Leadgm', [GUARD]: 'Guard' };
const findByName = (n) => Number(Object.keys(names).find((k) => names[k].toLowerCase() === String(n).toLowerCase()) || 0);

// ---- A3-5: the gamemode's Lead-GM-only list ----------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
  const m = src.match(/const LEAD_ONLY = new Set\(\[([\s\S]*?)\]\);/);
  const list = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  for (const c of ['masktest', 'faction leader', 'faction remove', 'appoint', 'dismiss', 'jail'])
    ok(list.includes(c), `/${c} is for a Lead GM and above (LEAD_ONLY)`, list);
  ok(/if \(\(LEAD_ONLY\.has\(cmd\) \|\| LEAD_ONLY\.has\(sub\)\) && isAdmin\(a\) && !isLeadStaff\(a\)\)/.test(src), 'the command gate refuses a GM on that list');
  for (const mod of ['JAIL_JS', 'STRUGGLE_JS', 'PLAYERMENU_JS', 'GUILDS_JS'])
    ok(new RegExp(`require\\(${mod}\\)\\(\\{[^}]*\\bisLeadStaff\\b`).test(src), `the gamemode hands isLeadStaff to ${mod.replace('_JS', '').toLowerCase()}.js`);
}

// ---- A3-4: factions ----------------------------------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gmpowers-'));
  fs.copyFileSync(path.join(ROOT, 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
  const here = process.cwd(); process.chdir(dir);
  const props = new Map(); const said = []; const cmds = {}; const audits = [];
  const noop = () => {};
  delete require.cache[path.join(ROOT, 'guilds.js')];
  globalThis.__dboGuilds = undefined;
  require(path.join(ROOT, 'guilds.js'))({
    mp: { get: (id, p) => props.get(`${id}|${p}`), set: (id, p, v) => props.set(`${id}|${p}`, v) },
    log: noop, personal: (a, t) => said.push([a, t]), system: noop, audit: (t) => audits.push(t),
    registerChatCommand: (n, f) => { cmds[n] = f; }, onUi: noop, openWidget: noop, closeWidget: noop,
    display: (a) => names[a] || `P${a.toString(16)}`, who: (a) => names[a] || '', nameOf: (a) => names[a] || '', tagOf: () => 'TAG',
    onlineActors: () => [PLAYER, GM, LEAD, GUARD], isAdmin, isLeadStaff, findByName, cfg: {}, profileOf: (a) => a,
  });
  const faction = (a, args) => { said.length = 0; cmds.faction(a, args); return (said[said.length - 1] || [])[1] || ''; };
  ok(/Lead GM or above/.test(faction(GM, 'leader Player synod')), 'a GM cannot name a faction leader (/faction leader)');
  ok(!audits.some((t) => /named/.test(t)), '...and nothing was recorded as done');
  ok(/now leads/.test(faction(LEAD, 'leader Player synod')), 'a Lead GM can');
  ok(/Use the faction menu/.test(faction(GM, 'remove Player synod')), 'a GM cannot remove a member (/faction remove)');
  ok(/Removed/.test(faction(LEAD, 'remove Player synod')), 'a Lead GM can');
  ok(/cannot invite/.test(faction(GM, 'invite Guard synod')), 'a GM with no rank cannot invite into a faction');
  ok(/invited/i.test(faction(LEAD, 'invite Guard synod')), 'a Lead GM can');
  ok(/cannot invite|may only take|only takes|not a vampire|takes only/i.test(faction(GM, 'invite Player cyrodiil-vampyrum-order')), 'a GM cannot slip a mortal into a vampire order');
  process.chdir(here);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- A3-7: who is lawful, and who binds without asking --------------------------------------------------------------
{
  const props = new Map(); const noop = () => {};
  const RANKS = { [GUARD]: [{ zone: 'bruma', rank: 'guard' }] };
  delete require.cache[path.join(ROOT, 'playermenu.js')];
  globalThis.__dboInstantRestraint = undefined;
  require(path.join(ROOT, 'playermenu.js'))({
    mp: { get: (id, p) => props.get(`${id}|${p}`), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: () => 0, getDescFromId: (id) => id.toString(16), callPapyrusFunction: noop, lookupEspmRecordById: () => null },
    log: noop, personal: noop, system: noop, registerChatCommand: noop, onUi: noop, sendPacket: noop, display: (a) => names[a], nameOf: (a) => names[a], tagOf: () => 'TAG',
    profileOf: (a) => a, onlineActors: () => [PLAYER, GM, LEAD, GUARD], isAdmin, isLeadStaff, ranksOf: (pid) => RANKS[pid] || [],
    giveItem: () => true, makeProp: noop, runCommand: noop, zones: [], zoneOfActor: () => null, cfg: {}, every: noop,
  });
  const lawful = (a) => props.get(`${a}|private.dboLawful`) === true;
  ok(!lawful(GM), 'a GM holding no rank is not lawful (no guard at a cell door, no freeing the bound)');
  ok(lawful(LEAD), 'a Lead GM is lawful');
  ok(lawful(GUARD) && !lawful(PLAYER), 'a guard is lawful and a player is not, as before');
  const instant = globalThis.__dboInstantRestraint;
  ok(typeof instant === 'function', 'the restraint check is installed');
  ok(instant(GM, PLAYER) === false, 'a GM must ask before binding a player');
  ok(instant(LEAD, PLAYER) === true, 'a Lead GM binds without asking');
  ok(instant(GUARD, PLAYER) === true, 'a guard binds without asking, as before');
  ok(instant(GUARD, GM) === false && instant(GUARD, LEAD) === false, 'a staff member is still asked before a guard binds them');
  // jail.js and struggle.js read the same lawful flag and fall back to the Lead GM check
  for (const f of ['jail.js', 'struggle.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(/const lawful = \(a\) => get\(a, 'private\.dboLawful', false\) === true \|\| isLeadStaff\(a\);/.test(src) && !/\|\| isAdmin\(a\);/.test(src), `${f} counts a Lead GM as lawful, not every GM`);
  }
}

console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);
