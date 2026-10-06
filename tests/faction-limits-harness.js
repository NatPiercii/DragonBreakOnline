// Faction membership limits (guilds.js, config factions.limits, Nate 6 Oct): one faction per category (allegiance counts
// a hold's court officials only), the hard conflicts, every join path (invite/accept, Add member, set rank, /faction
// leader, the court seat check), secret and supernatural refusals kept from the inviter, the Lead GM override (once,
// audited), grandfathered members kept, enabled false. Real guilds.js, guild-defs.json and gamemode-config.json, stub
// api, in a temp folder.
//
//   node tests/faction-limits-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUILDS = path.join(ROOT, 'guilds.js');
if (!/__dboFactionLimitSeat/.test(fs.readFileSync(GUILDS, 'utf8'))) { require('./expect')('faction-limits', 'guilds.js has no faction limits'); console.log('ok   skipped: guilds.js has no faction limits'); process.exit(0); }
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const DEFS = JSON.parse(fs.readFileSync(path.join(ROOT, 'guild-defs.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-faction-limits-'));
fs.copyFileSync(path.join(ROOT, 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
process.chdir(dir);

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

// ---- the config itself ---------------------------------------------------------------------------------------------
const L = (CFG.factions || {}).limits || {};
const ids = new Set(DEFS.factions.map((f) => f.id));
const placed = [].concat(...Object.values(L.categories || {}).map((c) => c.ids || []));
ok('factions.limits is on', L.enabled === true);
ok('every category and conflict id is a faction in guild-defs.json', placed.concat(...(L.conflicts || []).map((c) => [...c.a, ...c.b])).every((id) => ids.has(id)), placed.filter((id) => !ids.has(id)));
ok('no faction sits in two categories', new Set(placed).size === placed.length);
ok('every Daedric cult is secret', DEFS.factions.filter((f) => f.kind === 'cult').every((f) => L.categories.secret.ids.includes(f.id)));
ok('every hold and the county are allegiance, officials only', DEFS.factions.filter((f) => f.kind === 'hold').every((f) => L.categories.allegiance.ids.includes(f.id) && L.categories.allegiance.officialsOnly.includes(f.id)));
ok('the Legion (kind "guild") and the Blades are allegiance', ['imperial-legion', 'blades'].every((id) => L.categories.allegiance.ids.includes(id)));

// ---- the stub server ------------------------------------------------------------------------------------------------
const LEAD = 0x10, GM = 0x11;
const LEG = 0x20, STORM = 0x21, COUNT = 0x22, CIT = 0x23, SYN = 0x24, WHIS = 0x25, THIEF = 0x26, DB = 0x27, CULT = 0x28,
  VIG = 0x29, VAMP = 0x2a, DG = 0x2b, VOLK = 0x2c, FG = 0x2d, KOJUS = 0x2e, BOSS = 0x2f;
const names = { [LEAD]: 'Lead', [GM]: 'Plain GM', [LEG]: 'Legionary', [STORM]: 'Stormy', [COUNT]: 'Count', [CIT]: 'Citizen', [SYN]: 'Synodic',
  [WHIS]: 'Whisperer', [THIEF]: 'Thief', [DB]: 'Assassin', [CULT]: 'Cultist', [VIG]: 'Vigilant', [VAMP]: 'Vampire', [DG]: 'Guardian',
  [VOLK]: 'Volkihar', [FG]: 'Fighter', [KOJUS]: 'Kojus', [BOSS]: 'Boss' };
const chars = new Map(Object.entries(names).map(([k, v]) => [Number(k), v]));
const told = [], audits = [], said = [];
const handlers = {}, commands = {};
const props = new Map();
const api = {
  mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v) },
  log: () => {}, personal: (a, t) => said.push({ a, t }), system: (a, t) => told.push({ a, t }), audit: (t) => audits.push(t),
  registerChatCommand: (n, f) => { commands[n] = f; }, onUi: (e, f) => { (handlers[e] = handlers[e] || []).push(f); },
  openWidget: (a, p) => { if (process.env.DBG) console.log('widget', p.result); }, closeWidget: () => {},
  display: (a) => `${chars.get(a)} #T${a.toString(16)}`, nameOf: (a) => chars.get(a) || 'Stranger', tagOf: (a) => `T${a.toString(16)}`,
  onlineActors: () => [...chars.keys()], isAdmin: (a) => a === LEAD || a === GM, isLeadStaff: (a) => a === LEAD,
  findByName: (q) => [...chars.entries()].find(([id, n]) => n.toLowerCase() === String(q).toLowerCase() || `#t${id.toString(16)}` === String(q).toLowerCase())?.[0] || 0,
  findAnyByName: (q) => [...chars.entries()].find(([id, n]) => n.toLowerCase() === String(q).toLowerCase() || `#t${id.toString(16)}` === String(q).toLowerCase())?.[0] || 0,
  who: (a) => `${chars.get(a)} (profile ${a})`, cfg: CFG, profileOf: (a) => a,
};
const kinds = { [VAMP]: 'vampire', [VOLK]: 'vampire' };
globalThis.__dboSuperKind = (a) => kinds[a] || null;

// Kojus today: Steward of Bruma and leader of the Legion, from before the rule (grandfathered)
fs.writeFileSync(path.join(dir, 'guilds.json'), JSON.stringify({
  'county-bruma': { [KOJUS]: { rank: 1, name: 'Kojus', tag: 'Tkojus', since: 1 } },
  'imperial-legion': { [KOJUS]: { rank: 0, name: 'Kojus', tag: 'Tkojus', since: 1 } },
}));
const load = (cfg) => { delete require.cache[GUILDS]; delete globalThis.__dboGuildState; api.cfg = cfg || CFG; require(GUILDS)(api); };
load();
const M = () => globalThis.__dboGuildState.members;
const inF = (fid, a) => !!(M()[fid] || {})[String(a)];
const put = (fid, a, rank) => { const f = globalThis.__dboGuildRankList(fid); M()[fid] = M()[fid] || {}; M()[fid][String(a)] = { rank: rank === undefined ? f.length - 1 : rank, name: names[a], tag: `T${a.toString(16)}`, since: 1 }; };
const chat = (a, line) => { said.length = 0; commands.faction(a, line); return (said[said.length - 1] || {}).t || ''; };
const invite = (a, t, fid) => globalThis.__dboGuildInvite(a, t, fid);
const accept = (t, fid) => chat(t, `accept ${fid}`);
const brumaRank = (title) => globalThis.__dboGuildRankList('county-bruma').findIndex((r) => r.title === title);

// ---- grandfathered ------------------------------------------------------------------------------------------------
ok('Kojus keeps both memberships at load', inF('county-bruma', KOJUS) && inF('imperial-legion', KOJUS));
const br = globalThis.__dboFactionLimitBreaches();
ok('Kojus is listed as breaking the allegiance rule', br.some((b) => b.actor === KOJUS && b.why === 'allegiance'), br);

// ---- setup -----------------------------------------------------------------------------------------------------
put('imperial-legion', LEG); put('imperial-legion', BOSS, 0); put('county-bruma', COUNT, 0); put('stormcloaks', STORM, 0);
put('synod', SYN, 0); put('college-of-whispers', WHIS, 0); put('thieves-guild', THIEF); put('dark-brotherhood', DB, 0);
put('cult-boethiah', CULT); put('vigil-of-stendarr', VIG, 0); put('dawnguard', DG, 0); put('clan-volkihar', VOLK, 0); put('fighters-guild', FG, 0);

// ---- allegiance ----------------------------------------------------------------------------------------------------
let r = invite(STORM, LEG, 'stormcloaks');
ok('a Legion soldier cannot be invited to the Stormcloaks, and the refusal names the Legion', r.error && /already serves the Imperial Legion; they must leave it first/.test(r.error), r);
r = invite(COUNT, LEG, 'county-bruma');
ok('a Legion soldier may be invited to Bruma (as a Citizen)', !r.error, r);
ok('and accepts', /You are now/.test(accept(LEG, 'county-bruma')) && inF('county-bruma', LEG));
r = globalThis.__dboGuildSetRank(COUNT, 'county-bruma', LEG, brumaRank('Guard'));
ok('made a Guard: still no court office, allowed', !r.error && M()['county-bruma'][String(LEG)].rank === brumaRank('Guard'), r);
r = globalThis.__dboGuildSetRank(COUNT, 'county-bruma', LEG, brumaRank('Steward'));
ok('promoting the Legion soldier to Steward is refused', r.error && /Legionary already serves the Imperial Legion/.test(r.error) && M()['county-bruma'][String(LEG)].rank === brumaRank('Guard'), r);
r = globalThis.__dboGuildSetRank(COUNT, 'county-bruma', KOJUS, brumaRank('Knight'));
ok('grandfathered Kojus moves between court ranks (already holds the slot)', !r.error && M()['county-bruma'][String(KOJUS)].rank === brumaRank('Knight'), r);
// The court seat check (appointCheck through court.js): a Legion soldier's office
ok('the court seat check refuses a Steward\'s office for a Legion soldier', /already serves the Imperial Legion/.test(globalThis.__dboFactionLimitSeat(COUNT, 'bruma', LEG, ['Steward']) || ''));
ok('the court seat check allows a Guard\'s office', globalThis.__dboFactionLimitSeat(COUNT, 'bruma', LEG, ['Guard']) === null);
ok('the court seat check allows Kojus, who holds office already', globalThis.__dboFactionLimitSeat(COUNT, 'bruma', KOJUS, ['Steward']) === null);
ok('the court sync itself refuses a Legion soldier\'s Steward rank', /Imperial Legion/.test(globalThis.__dboCourtSync('bruma', LEG, ['Steward'], true) || '') && M()['county-bruma'][String(LEG)].rank === brumaRank('Guard'));
put('county-bruma', CIT, brumaRank('Steward'));
r = invite(BOSS, CIT, 'imperial-legion');
ok('Bruma\'s Steward cannot be invited to the Legion: "holds office in the County of Bruma"', r.error && /Citizen already holds office in the County of Bruma; they must leave it first/.test(r.error), r);

// ---- guild ---------------------------------------------------------------------------------------------------------
r = invite(WHIS, SYN, 'college-of-whispers');
ok('the Synod and the College of Whispers: refused', r.error && /Synodic already serves the Synod/.test(r.error), r);
r = invite(FG, WHIS, 'fighters-guild');
ok('one guild only: a Whisperer cannot join the Fighters Guild', r.error && /College of Whispers/.test(r.error), r);
r = invite(WHIS, LEG, 'college-of-whispers');
ok('the College of Whispers with the Legion is allowed (guild + allegiance)', !r.error, r);
ok('and accepted', /You are now/.test(accept(LEG, 'college-of-whispers')));

// ---- secret and supernatural: kept from the inviter, refused at accept in the character's own words ---------------------
r = invite(DB, THIEF, 'dark-brotherhood');
ok('the Brotherhood inviting a Thief: the invite goes out (no secret told)', !r.error, r);
let t = accept(THIEF, 'dark-brotherhood');
ok('the Thief is refused at accept: "You already serve the Thieves Guild; leave it first."', t === 'You already serve the Thieves Guild; leave it first.' && !inF('dark-brotherhood', THIEF), t);
r = invite(VIG, CULT, 'vigil-of-stendarr');
ok('the Vigil inviting a secret cultist: the invite goes out', !r.error, r);
t = accept(CULT, 'vigil-of-stendarr');
ok('the cultist is refused at accept, naming the cult', /^The Vigil of Stendarr will never take one who serves the Cult of Boethiah; leave it first\.$/.test(t) && !inF('vigil-of-stendarr', CULT), t);
r = invite(DG, VAMP, 'dawnguard');
ok('the Dawnguard inviting a vampire: the invite goes out (nature not told)', !r.error, r);
t = accept(VAMP, 'dawnguard');
ok('the vampire is refused at accept', /^The Dawnguard will never take a vampire\.$/.test(t) && !inF('dawnguard', VAMP), t);
chars.set(FG + 0x100, 'Hunter'); names[FG + 0x100] = 'Hunter'; put('dawnguard', FG + 0x100, 0);
r = invite(VOLK, FG + 0x100, 'clan-volkihar');
ok('Clan Volkihar inviting a Dawnguard: refused openly (Dawnguard is not secret)', r.error && /Clan Volkihar will never take one who serves the Dawnguard; Hunter must leave it first/.test(r.error), r);
r = invite(VIG, THIEF, 'vigil-of-stendarr');
ok('a Thief may join the Vigil (secret + guild, no conflict)', !r.error && /You are now/.test(accept(THIEF, 'vigil-of-stendarr')), r);

// ---- staff: Add member, the override, /faction leader ---------------------------------------------------------------
globalThis.__dboGuildState.nonces.set(LEAD, 'n');
const add = (fid, who) => { for (const f of handlers.factionAdd) f(LEAD, [globalThis.__dboGuildState.nonces.get(LEAD), fid, who]); };
// Add member through the panel handler: read the outcome from the roster and the audit
add('stormcloaks', 'Legionary');
ok('a Lead GM\'s Add member is refused too', !inF('stormcloaks', LEG));
t = chat(GM, 'override Legionary stormcloaks');
ok('a plain GM cannot override', /Only a Lead GM/.test(t), t);
t = chat(LEAD, 'override Legionary stormcloaks');
ok('a Lead GM arms the override, and is told what it lifts', /lifted once/.test(t) && /Imperial Legion/.test(t) && audits.some((x) => /FACTION-LIMIT OVERRIDE armed by Lead/.test(x)), t);
add('stormcloaks', 'Legionary');
ok('the override lets the add through, audited', inF('stormcloaks', LEG) && audits.some((x) => /FACTION-LIMIT OVERRIDE by Lead .*Legionary .*into Stormcloaks despite/.test(x)), audits.slice(-2));
add('companions', 'Synodic');
ok('the override is spent: the next one is refused', !inF('companions', SYN));
t = chat(LEAD, 'leader Fighter synod');
ok('/faction leader is refused for a Fighters Guild leader to the Synod, nobody stepped down', /already serves the Fighters Guild/.test(t) && M().synod[String(SYN)].rank === 0, t);

// ---- off --------------------------------------------------------------------------------------------------------
const off = JSON.parse(JSON.stringify(CFG)); off.factions.limits.enabled = false;
const keep = JSON.parse(JSON.stringify(M()));
load(off); Object.assign(globalThis.__dboGuildState.members, keep);
r = invite(STORM, BOSS, 'stormcloaks');
ok('enabled false: no limits', !r.error, r);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
