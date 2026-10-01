// Faction charters, phase 1 (server\charters.js, with guilds.js and bank.js), as Jake set it (to-do thread, 1 Oct 05:53Z):
// "The GM approves / Up to 5 founders / No fee for now / This must follow the 7 roles as specified on the website", and at
// 05:57Z: "faction must have these roles filled in order to submit a faction request: Founder: this will also be the leader /
// Officer / Sergeant".
// The flow:
//   - a player drafts a charter as its Founder and names an Officer and a Sergeant (up to 5 founding members, further
//     Officers or Sergeants) on different accounts, who confirm within the window;
//   - a GM approves it: the faction is live, in player-factions.json, with the seven roles as its ranks and a treasury key
//     in bank.json; guild-defs.json is untouched;
//   - or a GM denies it with a reason (a cooldown follows), or edits it;
//   - a GM may dissolve a chartered faction.
// Also checked: the name and lore checks, the audit and staff lines, and with a fee configured, the fee held and refunded
// and Lead-GM-only decisions. Live then new: bfb0b652's guilds.js and bank.js know nothing of player factions.
//   node tests/charters-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SERVER = path.resolve(__dirname, '..');
const DATA = ['guild-defs.json', 'name-filter.json', 'zones.json', 'skills.json'];
const LIVE = 'bfb0b652';
let failures = 0, checks = 0;
const check = (label, ok, got) => { checks++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const dirs = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-charters-')); dirs.push(d); for (const f of DATA) fs.copyFileSync(path.join(SERVER, f), path.join(d, f)); process.chdir(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* the OS will */ } });
const resetGlobals = () => { for (const k of Object.keys(globalThis)) if (k.startsWith('__dbo')) delete globalThis[k]; };

let now = Date.parse('2026-10-01T12:00:00Z');
Date.now = () => now;
const HOUR = 3600000, DAY = 24 * HOUR;

// ---- the world: characters, their accounts (FOUNDER and ALT share one), gold, who is online, who is staff ----
const GOLD = 0xf;
const NAMES = ['Aela Stone', 'Aela Alt', 'Brynn Vale', 'Corvus Ash', 'Dagny Holt', 'Pell Poor', 'Gail Mod', 'Lars Lead', 'Olaf Away', 'Ulla Fenn', 'Rolf Gant', 'Siv Mork', 'Tove Ling'];
const A = {}; const NAME = {}; const PROFILE = {};
NAMES.forEach((n, i) => { const id = 0x14 + i; const key = ['FOUNDER', 'ALT', 'CO1', 'CO2', 'CO3', 'POOR', 'GM', 'LEAD', 'OFF', 'U1', 'U2', 'U3', 'U4'][i]; A[key] = id; NAME[id] = n; PROFILE[id] = i + 1; });
PROFILE[A.ALT] = PROFILE[A.FOUNDER];
const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const inv = (id, gold) => set(id, 'inventory', { entries: gold ? [{ baseId: GOLD, count: gold }] : [] });
const goldOf = (id) => ((get(id, 'inventory') || {}).entries || []).filter((e) => e.baseId === GOLD).reduce((s, e) => s + e.count, 0);
for (const a of Object.values(A)) inv(a, 5000);
let online = Object.values(A).filter((a) => a !== A.OFF);
const out = { said: [], audits: [], staff: [], logs: [] };
const cmds = {}; const timers = {};
const api = (cfg) => ({
  mp: { get, set, getIdFromDesc: () => 0 },
  log: (...m) => out.logs.push(m.join(' ')), personal: (a, t) => out.said.push([a, t]), system: (a, t) => out.said.push([a, t]),
  audit: (t) => out.audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, display: (a) => NAME[a] || 'Someone', nameOf: (a) => NAME[a] || '',
  tagOf: () => 'TAG', cfg, registerChatCommand: (n, fn) => { cmds[n] = fn; }, onUi: () => {}, openWidget: () => true, closeWidget: () => true,
  onlineActors: () => online.slice(), isAdmin: (a) => a === A.GM || a === A.LEAD, isLeadStaff: (a) => a === A.LEAD,
  findByName: (q) => Object.keys(NAME).map(Number).find((a) => online.includes(a) && NAME[a].toLowerCase() === String(q).toLowerCase()) || 0,
  profileOf: (a) => (a in PROFILE ? PROFILE[a] : -1),
  takeGold: (a, n) => { if (goldOf(a) < n) return false; inv(a, goldOf(a) - n); return true; },
  giveItem: (a, base, n) => { if (!online.includes(a)) return false; inv(a, goldOf(a) + n); return true; },
  goldOf, depositToTreasury: () => 0, zoneById: () => null, zoneList: () => [], zoneOfActor: () => '', ranksOf: () => [],
  distanceMeters: () => 50, every: (name, ms, fn) => { timers[name] = fn; },
  staffNote: (a, what, detail) => out.staff.push([what, detail, a]),
});
const said = (a) => { const l = out.said.filter((x) => x[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const ch = (a, args) => { cmds.charter(a, args); return said(a); };
const store = () => globalThis.__dboChartersState.store;
const byName = (name) => Object.values(store().charters).find((c) => c.name === name);
const bank = () => { try { return JSON.parse(fs.readFileSync('bank.json', 'utf8')); } catch (e) { return { factions: {} }; } };
const pfile = () => JSON.parse(fs.readFileSync('player-factions.json', 'utf8')).factions;
const g = (a, id) => (globalThis.__dboGuildsOf(a) || []).find((x) => x.id === id);

// ---- live: no charters, and guilds.js ignores a player-factions.json --------------------------------------------------
{
  scratch();
  let liveCharters = true;
  try { execFileSync('git', ['-C', SERVER, 'cat-file', '-e', `${LIVE}:charters.js`], { stdio: 'ignore' }); } catch (e) { liveCharters = false; }
  let liveGuilds = '', liveBank = '';
  try { liveGuilds = execFileSync('git', ['-C', SERVER, 'show', `${LIVE}:guilds.js`], { encoding: 'utf8' }); liveBank = execFileSync('git', ['-C', SERVER, 'show', `${LIVE}:bank.js`], { encoding: 'utf8' }); } catch (e) { /* no git */ }
  if (liveGuilds) {
    check('live: there is no charters.js', !liveCharters);
    fs.writeFileSync('player-factions.json', JSON.stringify({ factions: [{ id: 'pf-test', name: 'Test Company', kind: 'company', ranks: [{ title: 'Leader', role: 'leader' }] }] }));
    fs.writeFileSync('guilds-live.js', liveGuilds); fs.writeFileSync('bank-live.js', liveBank);
    resetGlobals();
    require(path.resolve('guilds-live.js'))(api({})); require(path.resolve('bank-live.js'))(api({}));
    check('live: guilds.js does not read player-factions.json', globalThis.__dboGuildExists('pf-test') === false);
    check('live: no hook founds or dissolves a player faction, and no treasury can be opened', typeof globalThis.__dboGuildFoundPlayer !== 'function' && typeof globalThis.__dboGuildDissolvePlayer !== 'function' && typeof globalThis.__dboTreasury.open !== 'function');
  } else console.log(`skip live: no git or no ${LIVE} here`);
}

// ---- new, with Jake's defaults ----------------------------------------------------------------------------------------
scratch();
const defsHash = () => crypto.createHash('sha256').update(fs.readFileSync('guild-defs.json')).digest('hex');
const defsBefore = defsHash();
const load = (cfg) => { for (const k of Object.keys(cmds)) delete cmds[k]; for (const m of ['guilds.js', 'bank.js', 'charters.js']) { const f = path.join(SERVER, m); delete require.cache[f]; require(f)(api(cfg || {})); } };
resetGlobals();
load({});
check('off unless switched on: a player is told charters are not open', /not open yet/.test(ch(A.FOUNDER, 'found Silver Sparrow Company')));
check('...and the boot line gives Jake\'s defaults: 3-5 founders, no fee, any GM decides', out.logs.some((l) => /^charters off: 0 pending, 0 gathering, 0 player faction\(s\); 3-5 founders, fee 0, approvers gm$/.test(l)), out.logs.filter((l) => /charters/.test(l)));
const ON = { charters: { enabled: true } };
load(ON);

// The seven roles. The source, website/guides/factions.html (live at dragonbreakonline.com/guides/factions.html since
// 04:24Z): <h2 id="roles">The seven roles</h2> "Every rank title, from Harbinger to Footpad, maps to one of seven roles."
// and its roles in order: <h3>Leader</h3> <h3>Officer</h3> <h3>Sergeant</h3> <h3>Mage</h3> <h3>Blacksmith</h3>
// <h3>Tailor</h3> <h3>Member</h3>
const SEVEN = ['Leader', 'Officer', 'Sergeant', 'Mage', 'Blacksmith', 'Tailor', 'Member'];
{
  const forks = [process.env.FORK, path.resolve(SERVER, '..', 'fork'), path.join(os.homedir(), 'dragonbreak', 'fork')].filter(Boolean);
  const page = forks.map((f) => path.join(f, 'website', 'guides', 'factions.html')).find((f) => fs.existsSync(f));
  if (page) {
    const html = fs.readFileSync(page, 'utf8'); const at = html.indexOf('id="roles"');
    const roles = at < 0 ? [] : [...html.slice(at, html.indexOf('</section>', at)).matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    check(`the guide in ${page} still lists these seven roles, in this order`, JSON.stringify(roles) === JSON.stringify(SEVEN), roles);
  } else console.log('skip: no fork checkout with website/guides/factions.html here (the seven roles are quoted above)');
}

// ---- the name and lore checks ----
const refused = (name, re) => { const r = ch(A.POOR, `found ${name}`); return re.test(r) ? true : r; };
for (const [name, re, why] of [
  ['Ab', /3-40 characters/, 'too short'], ['Band 7', /letters, spaces/, 'a digit'], ['IRON WOLVES', /capitals/, 'capitals'], ['Wooolves', /repeats/, 'a letter three times'],
  ['Hentai Traders', /will not do here/, 'a blocked word, folded'], ['H e n t a i', /will not do here/, 'a blocked word spelled out in single letters'], ['Staff Company', /reserved/, 'a reserved word'],
  ['The Companions', /already exists/, 'an existing faction, with "The"'], ['Companions', /already exists/, '...and without'], ['Imperial Legion', /already exists/, 'the Legion'],
  ['Whiterun', /hold or a region/, 'a hold'], ['Bruma', /hold or a region/, 'a region'], ['County of Bruma', /already exists/, 'the County'], ['The Rift', /already exists/, 'a hold\'s faction'],
  ['Azura Traders', /Daedric cults/, 'a Daedric Prince'], ['The Mythic Dawn', /already exists/, 'a Daedric cult faction'],
]) { const got = refused(name, re); check(`a name is refused: ${why} ("${name}")`, got === true, got); }
check('...and nothing was drafted by any of them', Object.keys(store().charters).length === 0);

// ---- drafting: the Founder, an Officer and a Sergeant on different accounts, no fee ----
let r = ch(A.FOUNDER, 'found Bruma Traders Company');
check('a charter is drafted, numbered, with the next steps (no fee)', /^Charter #1 for Bruma Traders Company is drafted, and you are its Founder\. Next: \/charter pitch <its purpose>, then \/charter invite <player> officer and \/charter invite <player> sergeant \(up to 4 co-founders, Officers or Sergeants\).*48 hours\.$/.test(r), r);
const c1 = () => store().charters['1'];
check('...a name with a region in it is drafted but flagged for the GMs', c1().flags.includes('names a hold or region: Bruma'), c1().flags);
check('...one open charter per account: the same player\'s other character cannot draft another', /already on an open charter/.test(ch(A.ALT, 'found Another Company')));
check('...nor can the founder draft a second', /already on an open charter/.test(ch(A.FOUNDER, 'found Second Company')));
check('a co-founder must be online', /must be online/.test(ch(A.FOUNDER, 'invite Olaf Away officer')));
check('...and a different account: the founder\'s own alt is refused', /different players/.test(ch(A.FOUNDER, 'invite Aela Alt officer')));
check('...and only as an Officer or a Sergeant: the other roles start empty', /names only its Officers and Sergeants; the Mage/.test(ch(A.FOUNDER, 'invite Brynn Vale mage')) && /the Member/.test(ch(A.FOUNDER, 'invite Brynn Vale member')) && /the Leader/.test(ch(A.FOUNDER, 'invite Brynn Vale leader')));
check('submitting with the Founder alone is refused: an Officer and a Sergeant are needed', /needs its Founder, an Officer and a Sergeant confirmed.*still needs: Officer, Sergeant/.test(ch(A.FOUNDER, 'submit')));
check('an invitation without a role names the first one still unfilled (Officer)', /to co-found Bruma Traders Company as its Officer/.test(ch(A.FOUNDER, 'invite Brynn Vale')));
check('...and tells the invitee the role and how to confirm', /asks you to co-found Bruma Traders Company \(charter #1\) as its Officer\. Type \/charter confirm 1/.test(said(A.CO1)));
ch(A.FOUNDER, 'pitch Honest traders of furs and salt along the Jerall road.');
check('an Officer invited but not confirmed does not count', /still needs: Officer, Sergeant/.test(ch(A.FOUNDER, 'submit')));
check('someone not invited cannot confirm', /no charter asking you/.test(ch(A.CO2, 'confirm 1')));
check('the Officer confirms', /You are a co-founder of Bruma Traders Company, as its Officer/.test(ch(A.CO1, 'confirm 1')) && c1().founders.length === 1 && c1().founders[0].role === 'officer');
check('...and the Founder hears what is still to fill', /Brynn Vale has confirmed as Bruma Traders Company's Officer; still to fill: Sergeant/.test(said(A.FOUNDER)));
check('submitting without a Sergeant is refused', /still needs: Sergeant/.test(ch(A.FOUNDER, 'submit')));
check('a purpose with a blocked word is refused', /will not do here/.test(ch(A.FOUNDER, 'pitch The hentai traders')));
check('there is no rank-title command: the ranks are the seven roles', /^Usage: \/charter \[found/.test(ch(A.FOUNDER, 'ranks Factor, Clerk')));
ch(A.FOUNDER, 'invite Corvus Ash sergeant');
check('the Sergeant confirms; the three roles are named', /as its Sergeant/.test(ch(A.CO2, 'confirm 1')) && /the Founder, an Officer and a Sergeant are named/.test(said(A.FOUNDER)));
r = ch(A.FOUNDER, 'submit');
check('submitted once all three are confirmed, and no gold taken (no fee)', /^Charter #1 is submitted\.$/.test(r) && goldOf(A.FOUNDER) === 5000 && c1().status === 'pending' && c1().fee.held === 0, r);
check('...the staff Discord log gets the request from the founder, with its roles, purpose and flags', out.staff.some(([w, d, a]) => w === 'charter submitted' && a === A.FOUNDER && /^submitted charter #1 for review: Bruma Traders Company \(company\): Founder Aela Stone, Officer Brynn Vale, Sergeant Corvus Ash\. Purpose: Honest traders.*Flags: names a hold or region: Bruma\. In game: \/charter show 1/.test(d)), out.staff);
check('...and every founder is told', [A.FOUNDER, A.CO1, A.CO2].every((a) => out.said.some((x) => x[0] === a && /is with the GMs/.test(x[1]))));

// Five founding members at most: the three roles and two more Officers or Sergeants
ch(A.U1, 'found Grey Harbour Company');
const c2 = () => store().charters['2'];
ch(A.U1, 'invite Rolf Gant'); ch(A.U1, 'invite Siv Mork'); ch(A.U1, 'invite Tove Ling officer'); ch(A.U1, 'invite Dagny Holt');
for (const a of [A.U2, A.U3, A.U4, A.CO3]) ch(a, 'confirm 2');
check('five founding members: the defaults fill Officer, then Sergeant, then more Sergeants', c2().founders.map((f) => f.role).join() === 'officer,sergeant,officer,sergeant', c2().founders.map((f) => f.role));
check('...a sixth is refused at the invitation', /at most 5 founders/.test(ch(A.U1, 'invite Pell Poor')));
c2().invited[String(A.POOR)] = { at: Date.now(), role: 'sergeant' };
check('...and at the confirmation, however the invitation came', /already has its 5 founders/.test(ch(A.POOR, 'confirm 2')) && c2().founders.length === 4);

// The window: after it the charter cannot be submitted, and the sweep lapses it
now += 49 * HOUR;
check('after the window a charter cannot be submitted', /run out/.test(ch(A.U1, 'submit')));
online = online.filter((a) => a !== A.U1);
timers.charters();
check('the sweep lapses a charter not submitted within 48 hours', c2().status === 'lapsed' && out.audits.some((t) => /CHARTER #2 lapsed/.test(t)));
online.push(A.U1); timers.charters();
check('...and a founder who was away hears of it when back', /charter for Grey Harbour Company lapsed/.test(said(A.U1)));

// ---- GMs: review, edit, approve, deny ----
check('a player cannot use the GMs\' commands', /for the GMs/.test(ch(A.CO1, 'list')));
check('a GM lists the pending charters', /#1 Bruma Traders Company \(company\), pending: Founder Aela Stone, Officer Brynn Vale, Sergeant Corvus Ash \(3 of 3-5\)/.test(ch(A.GM, 'list')), ch(A.GM, 'list'));
check('...and shows one', /Purpose: Honest traders/.test(ch(A.GM, 'show 1')) && /Officer Brynn Vale/.test(ch(A.GM, 'show 1')));
check('an edit to an existing faction\'s name is refused', /already exists/.test(ch(A.GM, 'edit 1 name The Fighters Guild')) && c1().name === 'Bruma Traders Company');
r = ch(A.GM, 'edit 1 name Jerall Road Traders');
check('a GM renames it: the flags are recomputed', /name is now "Jerall Road Traders"/.test(r) && c1().flags.length === 0, [r, c1().flags]);
check('...a kind edit is limited to the chartered kinds and guild; ranks cannot be edited', /one of: company, guild/.test(ch(A.GM, 'edit 1 kind cult')) && /kind is now "guild"/.test(ch(A.GM, 'edit 1 kind guild')) && /Usage: \/charter edit <n> name\|pitch\|seat\|kind/.test(ch(A.GM, 'edit 1 ranks A, B')));
check('...every edit is recorded, audited and sent to staff', c1().edits.length === 2 && out.audits.some((t) => /CHARTER #1 name edited by P1a: "Bruma Traders Company" -> "Jerall Road Traders"/.test(t)) && out.staff.some(([w]) => w === 'charter edited'));
check('a denial needs a reason', /Give the reason/.test(ch(A.GM, 'deny 1')));
r = ch(A.GM, 'approve 1');
check('a GM approves (Jake: "The GM approves"), and the faction is live at once', /Approved: Jerall Road Traders is faction pf-jerall-road-traders, led by Aela Stone/.test(r) && globalThis.__dboGuildExists('pf-jerall-road-traders'), r);
const pf = pfile();
check('...its ranks are the seven roles of the guide, in order, with their role keys', JSON.stringify(pf[0].ranks.map((x) => x.title)) === JSON.stringify(SEVEN) && pf[0].ranks.every((x) => x.role === x.title.toLowerCase()), pf[0].ranks);
check('...the Founder is its Leader, the Officer its Officer and the Sergeant its Sergeant', g(A.FOUNDER, 'pf-jerall-road-traders').role === 'leader' && g(A.FOUNDER, 'pf-jerall-road-traders').title === 'Leader' && g(A.CO1, 'pf-jerall-road-traders').title === 'Officer' && g(A.CO2, 'pf-jerall-road-traders').title === 'Sergeant' && g(A.FOUNDER, 'pf-jerall-road-traders').player === true && g(A.FOUNDER, 'pf-jerall-road-traders').kind === 'guild', [g(A.CO1, 'pf-jerall-road-traders'), g(A.CO2, 'pf-jerall-road-traders')]);
check('...player-factions.json holds it (charter, founder\'s account, purpose)', pf.length === 1 && pf[0].id === 'pf-jerall-road-traders' && pf[0].charter === 1 && pf[0].leaderProfile === 1 && /Honest traders/.test(pf[0].pitch), pf);
check('...guild-defs.json is untouched', defsHash() === defsBefore);
check('...its treasury is a bank.json key, at 0', bank().factions['pf-jerall-road-traders'] === 0 && globalThis.__dboTreasury.balance('pf-jerall-road-traders') === 0, bank());
check('...audited, sent to staff in the GM\'s name, and the founders told', out.audits.some((t) => /CHARTER #1 approved by P1a: Jerall Road Traders is faction pf-jerall-road-traders/.test(t)) && out.audits.some((t) => /BANK treasury of pf-jerall-road-traders opened with 0 gold/.test(t)) && out.staff.some(([w, d, a]) => w === 'charter approved' && a === A.GM && /^approved charter #1: Jerall Road Traders is now faction pf-jerall-road-traders, led by Aela Stone\.$/.test(d)) && /The GMs approved the charter\. Jerall Road Traders is founded/.test(said(A.CO1)));
check('...a decided charter cannot be approved again', /Only a pending charter/.test(ch(A.GM, 'approve 1')));
check('...and its founder\'s account cannot charter a second faction while leading one', /already leads a faction founded by charter/.test(ch(A.ALT, 'found Third Company')));
load(ON);
check('a reload keeps the faction, its roster and the charters', globalThis.__dboGuildExists('pf-jerall-road-traders') && g(A.FOUNDER, 'pf-jerall-road-traders').role === 'leader' && c1().status === 'approved');

ch(A.CO3, 'found Ashen Lantern Company'); ch(A.CO3, 'invite Pell Poor officer'); ch(A.POOR, 'confirm 3'); ch(A.CO3, 'invite Ulla Fenn sergeant'); ch(A.U1, 'confirm 3');
check('with the three roles filled, a charter still needs its purpose', /Give its purpose first/.test(ch(A.CO3, 'submit')));
ch(A.CO3, 'pitch Lamplighters and night watch for the Bruma road.');
check('"night watch" in a purpose is fine: no blocked word is made across two words', /submitted/.test(ch(A.CO3, 'submit')));
r = ch(A.GM, 'deny 3 The road watch is the County guard\'s duty in Bruma.');
check('denied with a reason; nothing to refund with no fee', /Denied; 0 gold refunded/.test(r) && store().charters['3'].status === 'denied' && goldOf(A.CO3) === 5000, r);
check('...the founders read why, it is audited and sent to staff', /denied the charter for Ashen Lantern Company: The road watch/.test(said(A.POOR)) && out.audits.some((t) => /CHARTER #3 denied by P1a: The road watch/.test(t)) && out.staff.some(([w]) => w === 'charter denied'));
check('...and that account waits 7 days before another charter', /may file another in 7 day\(s\)/.test(ch(A.CO3, 'found Ashen Lantern Company')));
now += 7 * DAY + HOUR;
check('...after which it may', /Charter #4 for Ashen Lantern Company is drafted/.test(ch(A.CO3, 'found Ashen Lantern Company')));
check('withdrawing a gathering charter costs nothing', /Charter #4 is withdrawn\.$/.test(ch(A.CO3, 'withdraw')));

// ---- with a fee configured (the hold and refund code, off by default) and Lead-GM-only decisions ----
load({ charters: { enabled: true, fee: 1000, filingFee: 100, approvers: 'lead' } });
ch(A.CO3, 'found Ninefold Lantern Company'); ch(A.CO3, 'pitch Lamplighters.'); ch(A.CO3, 'invite Pell Poor'); ch(A.POOR, 'confirm 5'); ch(A.CO3, 'invite Rolf Gant'); ch(A.U2, 'confirm 5');
inv(A.CO3, 500);
check('fee 1000: refused when not carried, and no gold taken', /fee is 1000 gold, and you do not carry it/.test(ch(A.CO3, 'submit')) && goldOf(A.CO3) === 500 && store().charters['5'].status === 'gathering');
inv(A.CO3, 5000);
check('...submitted with the fee held', /submitted; 1000 gold is held/.test(ch(A.CO3, 'submit')) && goldOf(A.CO3) === 4000 && store().charters['5'].fee.held === 1000);
check('...a GM who is not a Lead GM cannot decide with approvers "lead"', /Lead GM and above/.test(ch(A.GM, 'approve 5')) && store().charters['5'].status === 'pending');
online = online.filter((a) => a !== A.CO3);
r = ch(A.LEAD, 'deny 5 Too close to the Ashen Lantern.');
check('...a Lead GM denies: 900 refunded (the 100 filing fee kept)', /Denied; 900 gold refunded to Dagny Holt/.test(r), r);
check('...the founder was away: the 900 is owed, not paid yet', goldOf(A.CO3) === 4000 && store().owed[String(A.CO3)] === 900);
online.push(A.CO3); timers.charters();
check('...and paid at the sweep once they are online', goldOf(A.CO3) === 4900 && !store().owed[String(A.CO3)] && out.audits.some((t) => /CHARTER refund 900 gold paid to P18/.test(t)));
load({ charters: { enabled: true, fee: 1000, approvers: 'lead', feeOnApproval: 'treasury', cooldownDays: 0 } });
ch(A.U1, 'found Silver Sparrow Company'); ch(A.U1, 'pitch Couriers.'); ch(A.U1, 'invite Rolf Gant'); ch(A.U2, 'confirm 6'); ch(A.U1, 'invite Siv Mork'); ch(A.U3, 'confirm 6'); ch(A.U1, 'submit');
check('a pending charter withdrawn gives the whole fee back', /withdrawn; your 1000 gold is returned/.test(ch(A.U1, 'withdraw')) && goldOf(A.U1) === 5000);
ch(A.U1, 'found Silver Sparrow Company'); ch(A.U1, 'pitch Couriers.'); ch(A.U1, 'invite Rolf Gant'); ch(A.U2, 'confirm 7'); ch(A.U1, 'invite Siv Mork'); ch(A.U3, 'confirm 7'); ch(A.U1, 'submit');
check('feeOnApproval "treasury" seeds the new treasury with the fee', /Approved: Silver Sparrow Company/.test(ch(A.LEAD, 'approve 7')) && bank().factions['pf-silver-sparrow-company'] === 1000 && goldOf(A.U1) === 4000, bank());

// ---- flags a GM weighs, never refusals ----
load(ON);
online.push(A.OFF);
const flagsOf = (name) => { ch(A.OFF, 'withdraw'); ch(A.OFF, `found ${name}`); const c = byName(name); return c ? c.flags : null; };
check('a canon faction not in the game is flagged for a lore decision', (flagsOf('Penitus Oculatus Veterans') || []).includes('canon, needs a lore decision: Penitus Oculatus'));
check('...a deity\'s name is flagged ("Sons of Talos")', (flagsOf('Sons of Talos') || []).includes('names a deity: Talos'));
check('...an existing faction inside a longer name is flagged ("Legion of the Thalmor Hunters")', (flagsOf('Legion of the Thalmor Hunters') || []).includes('names an existing faction: Thalmor'));
check('..."The Night Watch" is a name: no blocked word is made across two words', Array.isArray(flagsOf('The Night Watch')));
ch(A.OFF, 'withdraw');

// ---- dissolving ----
check('dissolving needs a chartered faction and a reason', /Only a faction founded by charter/.test(ch(A.GM, 'dissolve fighters-guild gone')) && /Give the reason/.test(ch(A.GM, 'dissolve pf-jerall-road-traders')));
r = ch(A.GM, 'dissolve pf-jerall-road-traders Inactive since the alpha opened.');
check('a GM dissolves a chartered faction: gone from the factions, player-factions.json and its roster', /Jerall Road Traders is dissolved; its treasury stays in bank.json/.test(r) && !globalThis.__dboGuildExists('pf-jerall-road-traders') && !g(A.FOUNDER, 'pf-jerall-road-traders') && !pfile().some((f) => f.id === 'pf-jerall-road-traders'), r);
check('...its treasury key stays for Nate\'s decision, guild-defs.json is still untouched, and it is audited', 'pf-jerall-road-traders' in bank().factions && defsHash() === defsBefore && out.audits.some((t) => /CHARTER faction pf-jerall-road-traders \(Jerall Road Traders\) dissolved by P1a: Inactive since the alpha opened\.; its treasury is left in bank\.json/.test(t)));
check('...a canon faction can never be dissolved this way', globalThis.__dboGuildDissolvePlayer('fighters-guild') === false && globalThis.__dboGuildExists('fighters-guild'));
check('every step left a CHARTER audit line', out.audits.filter((t) => /^CHARTER /.test(t)).length >= 40, out.audits.filter((t) => /^CHARTER /.test(t)).length);

console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
