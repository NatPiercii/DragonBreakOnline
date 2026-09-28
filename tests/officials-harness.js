// Scripted test for /appoint, /dismiss and /officials in gamemode.js. They live inline in the gamemode, so this cuts
// them out (from "const appointCap" to the Scholar section) and runs them against stubs: an online and an offline
// character, a name with spaces, a #TAG, a profile id, an ambiguous name, an account with no characters, telling the
// person only when one of their characters is online, and /officials naming offline officials. Run it from this
// folder's parent with
//
//   node tests\officials-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf('const appointCap = ');
const end = src.indexOf('// ---- Scholar');
if (start < 0 || end < 0 || end < start) { console.log('FAIL the officials section markers are gone from gamemode.js'); process.exit(1); }
const section = src.slice(start, end);

// World: an admin online, Corvus online (profile 11), Marcus Aurelius offline (profile 12, tag KQ7P), two offline
// "Lydia"s, and profile 13 with no characters left
const ADMIN = 0x10, CORVUS = 0x14, MARCUS = 0xff000200, LYDIA1 = 0xff000300, LYDIA2 = 0xff000301;
const OWNER = 0x11, SERANA = 0x15, ULF = 0x16, JZAR = 0xff000400, BLANK = 0x17;
const chars = new Map([[ADMIN, { pid: 1, name: 'Admin', tag: 'AAAA', online: true }], [CORVUS, { pid: 11, name: 'Corvus Direnni II', tag: 'UFSR', online: true }],
  [MARCUS, { pid: 12, name: 'Marcus Aurelius', tag: 'KQ7P', online: false }], [LYDIA1, { pid: 14, name: 'Lydia', tag: 'LYD1', online: false }],
  [LYDIA2, { pid: 15, name: 'Lydia', tag: 'LYD2', online: false }],
  // For the Jarl rule: an Owner, a Nord vampire, a werewolf in beast form who was born a Nord, a Khajiit, no race at all
  [OWNER, { pid: 2, name: 'Owner', tag: 'OWNR', online: true }], [SERANA, { pid: 16, name: 'Serana', tag: 'VAMP', online: true }],
  [ULF, { pid: 17, name: 'Ulf', tag: 'WOLF', online: true }], [JZAR, { pid: 18, name: 'J\'zar', tag: 'JZAR', online: false }],
  [BLANK, { pid: 19, name: 'Blank', tag: 'NONE', online: true }]]);
const RACES = { 1: 'NordRace', 2: 'ImperialRace', 3: 'BretonRace', 4: 'NordRaceVampire', 5: 'WerewolfBeastRace', 6: 'KhajiitRace' };
const raceOf = new Map([[ADMIN, 1], [OWNER, 1], [CORVUS, 3], [MARCUS, 2], [LYDIA1, 1], [LYDIA2, 1], [SERANA, 4], [ULF, 5], [JZAR, 6]]);
globalThis.__dboBeastOriginalRace = (a) => (a === ULF ? 1 : 0);
const byName = (q) => [...chars.entries()].filter(([, c]) => c.name.toLowerCase() === q.toLowerCase()).map(([id]) => id);
const byTag = (q) => [...chars.entries()].filter(([, c]) => c.tag.toLowerCase() === q.toLowerCase()).map(([id]) => id);
const findByName = (q) => { const s = String(q).trim().replace(/^#/, ''); const t = byTag(s).concat(byName(q.trim())).filter((id) => chars.get(id).online); return t[0] || 0; };
const findAnyByName = (q) => {
  const online = findByName(q); if (online) return online;
  const s = String(q).trim(); const tag = s.match(/#([A-Za-z0-9]{4})$/);
  if (tag) { const r = byTag(tag[1]); return r[0] || 0; }
  const r = byName(s); return r.length === 1 ? r[0] : r.length > 1 ? -r.length : 0;
};
let officials = {};
const zones = [{ id: 'bruma', name: 'Bruma', officials: ['ruler', 'steward', 'guard'] }, { id: 'whiterun', name: 'Whiterun', officials: ['jarl', 'steward'] }];
const told = []; const said = []; const audits = [];
const stubs = {
  mp: { getActorsByProfileId: (pid) => [...chars.entries()].filter(([, c]) => c.pid === pid).map(([id]) => id),
    get: (a, prop) => (prop === 'appearance' && raceOf.has(a) ? { raceId: raceOf.get(a) } : null),
    lookupEspmRecordById: (id) => (RACES[id] ? { record: { editorId: RACES[id] } } : { record: null }) },
  isAdmin: (a) => a === ADMIN || a === OWNER,
  tierOf: (a) => (a === OWNER ? 'senior' : a === ADMIN ? 'developer' : null),
  ranksOf: (pid) => { const out = []; for (const z of zones) for (const r of Object.keys(officials[z.id] || {})) if ((officials[z.id][r] || []).includes(pid)) out.push({ zone: z, rank: r }); return out; },
  profileOf: (a) => (chars.has(a) ? chars.get(a).pid : -1),
  APPOINT_RULES: { ruler: { steward: 5, guard: 20 } },
  userOf: (a) => (chars.has(a) && chars.get(a).online ? 1 : -1),
  findAnyByName, findByName,
  onlineActors: () => [...chars.entries()].filter(([, c]) => c.online).map(([id]) => id),
  display: (a) => `${chars.get(a).name} #${chars.get(a).tag}`,
  who: (a) => `${chars.get(a).name} #${chars.get(a).tag} (profile ${chars.get(a).pid})`,
  nameOf: (a) => chars.get(a).name,
  seen: new Map([[11, { name: 'Corvus Direnni II' }]]),
  zoneList: () => zones, zoneById: (id) => zones.find((z) => z.id === String(id).toLowerCase()) || null,
  rankTitle: (r) => r[0].toUpperCase() + r.slice(1),
  readOfficials: () => JSON.parse(JSON.stringify(officials)), writeOfficials: (o) => { officials = JSON.parse(JSON.stringify(o)); },
  personal: (a, text) => said.push(text), system: (a, text) => told.push({ a, text }), audit: (t) => audits.push(t),
};
const commands = new Map();
stubs.registerChatCommand = (name, fn) => commands.set(name, fn);
new Function(...Object.keys(stubs), section)(...Object.values(stubs));
const run = (cmd, a, args) => { said.length = 0; told.length = 0; commands.get(cmd)(a, args); return said.join(' | '); };

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const ranks = () => JSON.stringify(officials);

let out = run('appoint', ADMIN, 'Corvus Direnni II bruma steward');
check('appoint by a full name with spaces, online: saved and told', (officials.bruma.steward || []).includes(11) && told.length === 1 && told[0].a === CORVUS && !/offline/.test(out), out);
out = run('appoint', ADMIN, 'Marcus Aurelius bruma guard');
check('appoint an offline character by name: saved, admin told they were not', (officials.bruma.guard || []).includes(12) && told.length === 0 && /offline and were not told/.test(out), out);
check('the audit marks it offline', /appointed Marcus Aurelius #KQ7P \(profile 12\) Guard of Bruma \(offline\)/.test(audits[audits.length - 1]), audits[audits.length - 1]);
out = run('appoint', ADMIN, 'Lydia bruma guard');
check('an ambiguous name asks for the #TAG or profile id', /2 characters are called Lydia\. Use their #TAG or profile id/.test(out) && !JSON.stringify(officials).includes('14'), out);
out = run('appoint', ADMIN, 'Lydia #LYD2 bruma guard');
check('a name with its #TAG picks the right one, offline', (officials.bruma.guard || []).includes(15), out);
out = run('appoint', ADMIN, '13 bruma guard');
check('a profile id with no characters is refused for appoint', /Profile 13 has no characters/.test(out), out);
out = run('appoint', ADMIN, 'Nobody bruma guard');
check('an unknown name says so', /No character called Nobody/.test(out), out);

out = run('officials', ADMIN, '');
check('/officials names offline officials, not profile ids', /Guard: Marcus Aurelius, Lydia/.test(out) && !/profile 1[25]/.test(out), out);

out = run('dismiss', ADMIN, 'Marcus Aurelius bruma');
check('dismiss an offline official by name', !(officials.bruma.guard || []).includes(12) && /no longer Guard of Bruma\. They are offline and were not told/.test(out), out);
out = run('dismiss', ADMIN, '#LYD2 bruma');
check('dismiss by #TAG alone', !(officials.bruma.guard || []).includes(15), out);
officials.bruma.guard = [13];
out = run('dismiss', ADMIN, '13 bruma');
check('dismiss by profile id even when the account has no characters', !(officials.bruma.guard || []).includes(13) && /profile 13 is no longer Guard/.test(out), out);
out = run('dismiss', ADMIN, 'Corvus Direnni II bruma');
check('dismiss an online official: told', !(officials.bruma.steward || []).includes(11) && told.length === 1 && told[0].text === 'You are no longer Steward of Bruma.', out);
out = run('dismiss', ADMIN, 'Corvus Direnni II bruma');
check('dismissing someone with no rank says so', /holds no rank in Bruma/.test(out), out);

// An official's own powers still apply offline: a Steward cannot dismiss a guard, a ruler can
officials = { bruma: { ruler: [11], guard: [12] } };
out = run('dismiss', CORVUS, 'Marcus Aurelius bruma');
check('a ruler dismisses a guard who is offline', !(officials.bruma.guard || []).includes(12), out);
officials = { bruma: { steward: [11], guard: [12] } };
out = run('dismiss', CORVUS, 'Marcus Aurelius bruma');
check('a steward cannot dismiss a guard', (officials.bruma.guard || []).includes(12) && /cannot dismiss a Guard/.test(out), out);
out = run('appoint', CORVUS, 'Marcus Aurelius bruma guard');
check('a steward cannot appoint either', /Only an admin, or a seat that may name/.test(out), out);
out = run('dismiss', ADMIN, 'Corvus Direnni II');
check('usage when the zone is missing is not mistaken for a name', /No such zone|Usage/.test(out), out);

// The Jarl rule: a Nord or an Imperial only, unless an Owner adds "override"
officials = {};
out = run('appoint', ADMIN, 'Corvus Direnni II whiterun jarl');
check('a Breton cannot be made Jarl', !(officials.whiterun && officials.whiterun.jarl) && /is a Breton\. By Skyrim's law only a Nord or an Imperial may sit as Jarl\.$/.test(out), out);
out = run('appoint', ADMIN, 'Corvus Direnni II whiterun jarl override');
check('staff below the Owners cannot override', !(officials.whiterun && officials.whiterun.jarl) && /Only the Owners can override/.test(out), out);
out = run('appoint', ADMIN, 'Marcus Aurelius whiterun jarl');
check('an Imperial can be Jarl, offline too', (officials.whiterun.jarl || []).includes(12), out);
out = run('appoint', ADMIN, 'Serana whiterun jarl');
check('a Nord vampire is still a Nord', (officials.whiterun.jarl || []).includes(16), out);
out = run('appoint', ADMIN, 'Ulf whiterun jarl');
check('a werewolf in beast form counts by the race they were born', (officials.whiterun.jarl || []).includes(17), out);
out = run('appoint', ADMIN, 'Blank whiterun jarl');
check('no known race is refused', !(officials.whiterun.jarl || []).includes(19) && /is of no known race/.test(out), out);
out = run('appoint', OWNER, 'J\'zar whiterun jarl');
check('an Owner is refused too, and told about override', !(officials.whiterun.jarl || []).includes(18) && /is a Khajiit\..*add "override"/.test(out), out);
out = run('appoint', OWNER, 'J\'zar whiterun jarl override');
check('an Owner\'s override seats them', (officials.whiterun.jarl || []).includes(18) && /is now Jarl of Whiterun/.test(out), out);
check('the override is in the audit', /appointed J'zar #JZAR \(profile 18\) Jarl of Whiterun \(offline\) \(Jarl rule overridden by an Owner: a Khajiit\)/.test(audits[audits.length - 1]), audits[audits.length - 1]);
out = run('appoint', ADMIN, 'Corvus Direnni II whiterun steward');
check('other ranks take any race', (officials.whiterun.steward || []).includes(11), out);
out = run('appoint', OWNER, 'Lydia #LYD1 bruma guard override');
check('an Owner\'s override on another rank changes nothing', (officials.bruma.guard || []).includes(14) && !/overridden/.test(audits[audits.length - 1]), out);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
