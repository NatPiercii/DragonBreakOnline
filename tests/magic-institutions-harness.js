// Scripted test for the magic institutions rules (Elion and Aldemar's proposal for the College of Whispers, approved by
// Nate 11 Oct): tomes by college rank (spells.shopRankByRole), a Senior's two tomes a week (shopSeniorPerWeek), the
// restricted arts sold only to Senior ranks (spells.seniorOnlyTomes), teaching a spell at a college's own ledger or
// lectern (spells.collegeTeach), a Class Lectern teacher qualified by Arcane Arts 75, and a class paying students short
// of their first spell Arcane Arts through the Wheel's award at the class's rate (schools.classes.first*, skillrates.js).
// Loads the real spells.js, schools.js, salvage.js and skillrates.js against one stub mp, with gamemode-config.json's
// own settings.
//
//   node tests/magic-institutions-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const F = (n) => path.join(SERVER, n);
const CONFIG = JSON.parse(fs.readFileSync(F('gamemode-config.json'), 'utf8'));
const GUILDS = JSON.parse(fs.readFileSync(F('guild-defs.json'), 'utf8')).factions;
const TOMES = JSON.parse(fs.readFileSync(F('spell-tomes.json'), 'utf8')).tomes;

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-magicinst-'));
process.chdir(dir);
for (const f of ['skills.json', 'spell-tomes.json', 'salvage.json']) fs.copyFileSync(F(f), f);

let wallClock = Date.parse('2026-10-12T09:00:00Z');
Date.now = () => wallClock;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };

const PLUGINS = { 'Skyrim.esm': 0x00, 'Dawnguard.esm': 0x02, 'HearthFires.esm': 0x03, 'Dragonborn.esm': 0x04, 'ccBGSSSE025-AdvDSGS.esm': 0x09, 'BSAssets.esm': 0x0a, 'BSHeartland.esm': 0x0b, 'SurWR.esp': 0x20, 'Gray Fox Cowl.esm': 0x30, 'DragonBreak.esp': 0x3b, 'DragonBreak Online Edits.esp': 0x3c };
const BY_INDEX = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in PLUGINS)) throw new Error(`no plugin ${plugin}`); return ((PLUGINS[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const descOf = (id) => { const p = BY_INDEX[id >>> 24]; if (!p) throw new Error('no plugin ' + (id >>> 0).toString(16)); return `${(id & 0xffffff).toString(16)}:${p}`; };
const canon = (c) => { const i = c.lastIndexOf(':'); return `${parseInt(c.slice(i + 1), 16).toString(16)}:${c.slice(0, i)}`; };
const tome = (edid) => { const t = TOMES.find((x) => x.name === edid); return { book: canon(t.id), spell: canon(t.spellId), rank: t.rank }; };
const FLAMES = tome('SpellTomeFlames'), SPARKS = tome('SpellTomeSparks'), FIREBOLT = tome('SpellTomeFirebolt'), FIREBALL = tome('SpellTomeFireball');
const REANIMATE = tome('SpellTomeReanimateCorpse'), RAISE = tome('SpellTomeRaiseZombie');

// Places: the Synod Conclave (the Synod's hall), Frostcrag Spire (the College of Whispers'), Bruma outside
const SYNOD = '20ff:BSHeartland.esm', FROSTCRAG = '6ff7d:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';
const SCHOLARS_BASE = 'dcf0f:BSHeartland.esm', LECTERN_BASE = '15e4b7:DragonBreak Online Edits.esp';
const LEDGER = idOf('13f774:DragonBreak Online Edits.esp'), CRAG_LEDGER = idOf('13f775:DragonBreak Online Edits.esp');
const LECTERN = idOf('15e4bb:DragonBreak Online Edits.esp');
const RECORDS = {
  [idOf(SCHOLARS_BASE)]: { type: 'ACTI', editorId: 'BookBreakdown', fields: [] },
  [idOf(LECTERN_BASE)]: { type: 'ACTI', editorId: 'ClassLectern', fields: [] },
};
const GOLD = 0xf;

const SENIOR = 0x14, ASSOC = 0x15, WHISPER = 0x16, INITIATE = 0x17, SMITH = 0x18, TEACHER = 0x19, BEGIN = 0x1a, BEGIN2 = 0x1b, FAR = 0x1c, PLAINT = 0x1d;
const NAMES = { [SENIOR]: 'Senior', [ASSOC]: 'Assoc', [WHISPER]: 'Whisper', [INITIATE]: 'Initiate', [SMITH]: 'Smith', [TEACHER]: 'Teacher', [BEGIN]: 'Begin', [BEGIN2]: 'Begintwo', [FAR]: 'Far', [PLAINT]: 'Plainteacher' };
const props = new Map();
const put = (id, p, v) => props.set((id >>> 0) + '|' + p, v === undefined ? v : JSON.parse(JSON.stringify(v)));
const getp = (id, p) => props.get((id >>> 0) + '|' + p);
const at = (id, cell, pos) => { put(id, 'worldOrCellDesc', cell); put(id, 'pos', pos || [0, 0, 0]); };
const tierOfLevel = (l) => (l >= 90 ? 4 : l >= 75 ? 3 : l >= 50 ? 2 : l >= 25 ? 1 : 0);
const skillAt = (a, skill, level) => {
  const r = getp(a, 'private.mastery') || { v: 2, skills: {}, order: [] };
  r.skills[skill] = { level, xp: 0, rank: tierOfLevel(level) };
  if (!r.order.includes(skill)) r.order.push(skill);
  put(a, 'private.mastery', r);
};
const arcaneLevel = (a) => { const r = getp(a, 'private.mastery'); return r && r.skills.arcane ? r.skills.arcane.level : 0; };
const gold = (a, n) => put(a, 'inventory', { entries: n ? [{ baseId: GOLD, count: n }] : [] });
const count = (a, baseId) => ((getp(a, 'inventory') || { entries: [] }).entries.filter((e) => e.baseId === baseId).reduce((n, e) => n + e.count, 0));
put(LEDGER, 'baseDesc', SCHOLARS_BASE); at(LEDGER, SYNOD, [0, 0, 0]);
put(CRAG_LEDGER, 'baseDesc', SCHOLARS_BASE); at(CRAG_LEDGER, FROSTCRAG, [0, 0, 0]);
put(LECTERN, 'baseDesc', LECTERN_BASE); at(LECTERN, SYNOD, [300, 0, 0]);

// guilds.js stand-ins: memberships by title, the rank lists of guild-defs.json, the halls by cell
const MEMBERS = {};
const member = (a, fid, title) => {
  const f = GUILDS.find((x) => x.id === fid);
  const r = f.ranks.find((x) => x.title === title);
  if (!r) throw new Error(`no rank ${title} in ${fid}`);
  MEMBERS[a] = [{ id: fid, name: f.name, title, role: r.role }];
  put(a, 'private.dboGuilds', [{ id: fid, rank: f.ranks.indexOf(r) }]);
};
globalThis.__dboGuildsOf = (a) => MEMBERS[a >>> 0] || [];
globalThis.__dboGuildRankList = (id) => { const f = GUILDS.find((x) => x.id === String(id)); return f ? f.ranks.map((r) => ({ title: r.title, role: r.role })) : null; };
globalThis.__dboHallFactionAt = (cell) => ({ [SYNOD.toLowerCase()]: { id: 'synod', name: 'The Synod' }, [FROSTCRAG.toLowerCase()]: { id: 'college-of-whispers', name: 'College of Whispers' } }[String(cell).toLowerCase()] || null);

// The engine's spells per actor
const learned = new Map();
const known = (a) => learned.get(a >>> 0) || (learned.set(a >>> 0, new Set()), learned.get(a >>> 0));
const mp = {
  getIdFromDesc: idOf, getDescFromId: descOf,
  get: (id, p) => getp(id, p),
  set: (id, p, v) => put(id, p, v),
  lookupEspmRecordById: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (l) => l } : null),
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    if (cls === 'Debug') return null;
    const a = idOf(self.desc); const s = known(a);
    if (fn === 'GetSpellCount') return s.size;
    if (fn === 'GetNthSpell') { const id = [...s][args[0]]; return id === undefined ? null : { type: 'espm', desc: descOf(id) }; }
    const spell = idOf(args[0].desc);
    if (fn === 'AddSpell') { if (s.has(spell)) return false; s.add(spell); return true; }
    if (fn === 'RemoveSpell') return s.delete(spell);
    return false;
  },
};
mp.onReadBook = () => undefined;

// The Wheel, as masterySystem meters an award: the repeat ring (w / (1 + k/8) for the k-th same key within the hour, 16
// kept), the hourly bucket (bucketBurst 13, bucketPerHour 20 from skills.json), then the gameplay's rate (skillrates.js
// __dboSkillRate) on what got through. 10 xp a unit below 25: a level is 10 units of worth.
const PS = JSON.parse(fs.readFileSync('skills.json', 'utf8')).pointSystem;
const wheel = new Map(); // actor -> { ring: [{ h, at }], tokens, at }
const awards = [];
let touchAnswer = 'ok';
globalThis.__alduinakMasteryFirstTouch = (a, skill) => { if (touchAnswer === 'ok') skillAt(a, skill, 1); return touchAnswer; };
globalThis.__alduinakMasteryEvent = () => {};
globalThis.__alduinakMasteryAward = (a, skill, weight, key) => {
  const r = getp(a, 'private.mastery');
  if (!r || !r.skills[skill] || !(r.skills[skill].level >= 1)) return 0;
  const w = wheel.get(a) || { ring: [], tokens: PS.bucketBurst, at: wallClock };
  w.tokens = Math.min(PS.bucketBurst, w.tokens + ((wallClock - w.at) / HOUR) * PS.bucketPerHour); w.at = wallClock;
  w.ring = w.ring.filter((e) => wallClock - e.at < HOUR);
  const k = w.ring.filter((e) => e.h === key).length;
  w.ring = w.ring.concat([{ h: key, at: wallClock }]).slice(-16);
  const raw = Math.min(3, weight) / (1 + k / 8);
  const units = Math.max(0, Math.min(raw, w.tokens));
  w.tokens -= units;
  wheel.set(a, w);
  const rate = typeof globalThis.__dboSkillRate === 'function' ? globalThis.__dboSkillRate(a, skill, 'award', { key }) : 1;
  const s = r.skills[skill];
  const xp = s.level * 10 + (s.xp || 0) / 10 + units * rate; // levels below 25 at 10 units each
  s.level = Math.floor(xp / 10); s.xp = Math.round((xp % 10) * 10); s.rank = tierOfLevel(s.level);
  put(a, 'private.mastery', r);
  awards.push({ a, skill, weight, key, units, rate, at: wallClock });
  return units;
};
globalThis.__dboWheelRoom = (a) => (dailyFull.has(a >>> 0) ? { why: 'daily' } : null);
const dailyFull = new Set();

let online = [SENIOR, ASSOC, WHISPER, INITIATE, SMITH, TEACHER, BEGIN, BEGIN2, FAR, PLAINT];
for (const a of online) { at(a, BRUMA); put(a, 'profileId', a); gold(a, 0); }
const out = { widgets: [], closed: [], said: [], audits: [], logs: [], seq: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
const baseCfg = () => ({
  spells: Object.assign({}, CONFIG.spells, { shopStock: 999 }),
  schools: Object.assign({}, CONFIG.schools, { enabled: true }),
  salvage: CONFIG.salvage, skillRates: CONFIG.skillRates,
});
const api = {
  mp, cfg: baseCfg(),
  log: (...a) => out.logs.push(a.join(' ')), personal: (a, t) => out.said.push([a >>> 0, t]), system: (a, t) => out.said.push([a >>> 0, t]),
  audit: (t) => out.audits.push(t), who: (a) => `P${(a >>> 0).toString(16)}`, display: (a) => NAMES[a >>> 0] || `P${(a >>> 0).toString(16)}`,
  giveItem: (a, baseId, n) => { const e = (getp(a, 'inventory') || { entries: [] }).entries; const h = e.find((x) => x.baseId === baseId); if (h) h.count += n; else e.push({ baseId, count: n }); put(a, 'inventory', { entries: e }); return true; },
  takeGold: (a, n) => { const e = (getp(a, 'inventory') || { entries: [] }).entries; const g = e.find((x) => x.baseId === GOLD); if (!g || g.count < n) return false; g.count -= n; put(a, 'inventory', { entries: e.filter((x) => x.count > 0) }); return true; },
  depositToTreasury: (zone, n) => n,
  registerChatCommand: (name, fn, opts) => commands.set(name, { fn, opts }),
  onlineActors: () => online.slice(),
  every: (name, ms, fn) => timers.set(name, fn),
  openWidget: (a, w, focus) => { out.widgets.push({ a: a >>> 0, w, focus }); out.seq.push(['open', a >>> 0, w.id]); return true; },
  closeWidget: (a, id) => { out.closed.push([a >>> 0, id]); out.seq.push(['close', a >>> 0, id]); return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  distanceMeters: (a, b) => { if (getp(a, 'worldOrCellDesc') !== getp(b, 'worldOrCellDesc')) return Infinity; const p = getp(a, 'pos'), q = getp(b, 'pos'); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 70; },
  sendPacket: () => true, isAdmin: () => false, findByName: () => null, isWorldspace: (d) => d === BRUMA,
  profileOf: (a) => { const v = getp(a, 'profileId'); return v === undefined ? -1 : v; },
  masteryOf: (a) => getp(a, 'private.mastery') || null,
  recordOf: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0], toGlobalRecordId: (l) => l } : null),
  fieldsOf: (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t),
  itemName: () => 'something', inBeastForm: () => false,
};
const MODULES = ['spells.js', 'schools.js', 'salvage.js', 'skillrates.js'].map(F);
const load = (cfg) => { api.cfg = cfg || baseCfg(); handlers.clear(); commands.clear(); for (const f of MODULES) delete require.cache[f]; for (const f of MODULES) require(f)(api); };
load();
const ui = (ev, a, args, widgetId) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widgetId || 0));
const lastWidget = (a, type) => { const l = out.widgets.filter((w) => w.a === (a >>> 0) && (!type || w.w.type === type)); return l.length ? l[l.length - 1].w : null; };
const said = (a) => { const l = out.said.filter((p) => p[0] === (a >>> 0)); return l.length ? l[l.length - 1][1] : ''; };
const saidAny = (a, re) => out.said.some((p) => p[0] === (a >>> 0) && re.test(p[1]));
const lastAudit = (re) => out.audits.slice().reverse().find((t) => re.test(t)) || '';
const studiedAll = (a) => [].concat(...Object.values(getp(a, 'private.dboStudied') || {}));
const shop = (a) => { commands.get('tomes').fn(a, ''); return lastWidget(a, 'tomeShop'); };
const buy = (a, book) => { const w = shop(a); ui('tomeBuy', a, [w.nonce, book], 44); return lastWidget(a, 'tomeShop'); };
const ranksOn = (w) => [...new Set(w.tomes.map((t) => t.rank))].sort().join();
const hasTome = (w, t) => w.tomes.some((x) => x.id === t.book);

// ---- 1. tomes by college rank ---------------------------------------------------------------------------------------
check('every seniorOnlyTomes editor id is a tome in spell-tomes.json', CONFIG.spells.seniorOnlyTomes === undefined || CONFIG.spells.seniorOnlyTomes.every((e) => TOMES.some((t) => t.name === e)));
const DEFAULT_RESTRICTED = (() => { const src = fs.readFileSync(F('spells.js'), 'utf8'); const m = src.match(/seniorOnlyTomes: \[([\s\S]*?)\]/); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []; })();
check('...and so is every one of the defaults in spells.js (19, with the Soul Cairn\'s Boneman, Mistman, Wrathman and Command Daedra)', DEFAULT_RESTRICTED.length === 19 && ['DLC1SpellTomeConjureBoneman', 'DLC1SpellTomeConjureMistman', 'DLC1SpellTomeConjureWrathman', 'SpellTomeCommandDaedra'].every((e) => DEFAULT_RESTRICTED.includes(e)) && DEFAULT_RESTRICTED.every((e) => TOMES.some((t) => t.name === e)), DEFAULT_RESTRICTED.filter((e) => !TOMES.some((t) => t.name === e)));
for (const a of [SENIOR, ASSOC, WHISPER, INITIATE, SMITH]) { at(a, SYNOD, [0, 0, 0]); gold(a, 100000); skillAt(a, 'arcane', 80); skillAt(a, 'priest', 80); }
member(SENIOR, 'synod', 'Senior Magister'); member(ASSOC, 'synod', 'Associate'); member(WHISPER, 'college-of-whispers', 'Whisperer');
member(INITIATE, 'synod', 'Initiate'); member(SMITH, 'synod', 'Synod Artificer');
let w = shop(ASSOC);
check('an Associate (a plain member) is shown tomes up to Apprentice only', w.canBuy === true && w.tomes.length > 0 && ranksOn(w) === '0,1', ranksOn(w));
w = shop(WHISPER);
check('...as is a Whisperer (a mage of the College of Whispers)', w.canBuy === true && ranksOn(w) === '0,1', ranksOn(w));
w = shop(SENIOR);
check('a Senior Magister is shown up to Expert, never Master', w.canBuy === true && ranksOn(w) === '0,1,2,3', ranksOn(w));
check('an Initiate still buys none', shop(INITIATE).canBuy === false && /above Initiate/.test(shop(INITIATE).whyNot), shop(INITIATE).whyNot);
check('...nor the Synod Artificer (a crafting post)', shop(SMITH).canBuy === false && /above Initiate/.test(shop(SMITH).whyNot), shop(SMITH).whyNot);
w = buy(ASSOC, FIREBALL.book);
check('an Associate cannot buy an Adept tome: the rank line, no gold taken', w.resultKind === 'refused' && /At your rank the college sells tomes up to Apprentice; Adept tomes are for Senior ranks and above/.test(w.result) && count(ASSOC, GOLD) === 100000, w.result);

// With the primary-school shelf (de99ca37): an Associate of Destruction gets 3 of 4 places in Destruction, all within their rank
load(Object.assign(baseCfg(), { spells: Object.assign({}, baseCfg().spells, { shopStock: 4 }) }));
ui('uiCaps', ASSOC, ['spellbook', 'schools']);
put(ASSOC, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, levels: { Destruction: { level: 30, xp: 0 } }, grandfathered: [], picks: { Destruction: { spell: '', how: 'none', at: 1 } }, pickTold: {}, firstOffered: 1 });
w = shop(ASSOC);
check('the shelf leads with the primary school and keeps to the rank: 4 tomes, 3+ Destruction, none above Apprentice', w.tomes.length === 4 && w.tomes.filter((t) => t.school === 'Destruction').length >= 3 && w.tomes.every((t) => t.rank <= 1), w.tomes.map((t) => [t.school, t.rank]));
ui('uiCaps', ASSOC, ['spellbook']); put(ASSOC, 'private.dboSchools', undefined);
load();

// ---- 2. two a week for a Senior (rolling 7 days), one a week for the rest (Nate, 11 Oct) ----------------------------
const t0 = wallClock;
w = buy(SENIOR, FIREBALL.book);
check('a Senior buys an Adept tome, and the next is a day away (Nate, 11 Oct: one a day)', w.resultKind === 'ok' && count(SENIOR, idOf(FIREBALL.book)) === 1 && /Your next tome is 1 day away/.test(w.result) && w.canBuy === false && w.nextPurchaseAt === t0 + DAY, [w.result, w.nextPurchaseAt - t0]);
wallClock += HOUR;
w = buy(SENIOR, FIREBOLT.book);
check('...a second an hour later is refused, said "today", no gold taken', w.resultKind === 'refused' && count(SENIOR, idOf(FIREBOLT.book)) === 0 && /You have had your tome today \(bought, or taught with\)/.test(w.whyNot || w.result), [w.result, w.whyNot]);
w = buy(ASSOC, FIREBOLT.book);
check('an Associate buys an Apprentice tome and waits a week', w.resultKind === 'ok' && w.nextPurchaseAt === wallClock + 7 * DAY && /Your next tome is 7 days away/.test(w.result), [w.result, w.nextPurchaseAt - wallClock]);
wallClock = t0 + DAY + MIN;
check('a day after the first, the Senior may buy again', shop(SENIOR).canBuy === true && buy(SENIOR, FIREBOLT.book).resultKind === 'ok', shop(SENIOR).whyNot);
check('...the Associate still waits the week', shop(ASSOC).canBuy === false && /this week/.test(shop(ASSOC).whyNot), shop(ASSOC).whyNot);
load(Object.assign(baseCfg(), { spells: Object.assign({}, baseCfg().spells, { shopSeniorWindowDays: 7, shopSeniorPerWindow: 2 }) }));
put(SENIOR, 'private.dboTomeBoughtAt', 0); put(SENIOR, 'private.dboTomeBuys', []);
w = buy(SENIOR, SPARKS.book);
check('shopSeniorWindowDays 7 with shopSeniorPerWindow 2 is the two-a-week rule', w.resultKind === 'ok' && w.canBuy === true && /1 more tome this week/.test(w.result), w.result);
put(SENIOR, 'private.dboTomeBoughtAt', 0); put(SENIOR, 'private.dboTomeBuys', []);
load();

// ---- 3. the restricted arts ------------------------------------------------------------------------------------------
put(ASSOC, 'private.dboTomeBoughtAt', 0);
w = shop(ASSOC);
check('raising the dead is not on an Associate\'s shelf (Raise Zombie, Reanimate Corpse)', !hasTome(w, RAISE) && !hasTome(w, REANIMATE) && w.tomes.some((t) => t.school === 'Conjuration'), w.tomes.filter((t) => t.school === 'Conjuration').map((t) => t.spell));
const BONEMAN = tome('DLC1SpellTomeConjureBoneman'), ATRONACH = tome('SpellTomeConjureFlameAtronach');
check('...nor the Soul Cairn\'s dead (Conjure Boneman), while an atronach stays open', !hasTome(w, BONEMAN) && hasTome(w, ATRONACH), w.tomes.filter((t) => t.school === 'Conjuration').map((t) => t.spell));
check('...and a Senior sees Conjure Boneman', hasTome(shop(SENIOR), BONEMAN));
w = buy(ASSOC, REANIMATE.book);
check('...and cannot be bought by one', w.resultKind === 'refused' && /restricted arts, taught and sold only to Senior ranks and above/.test(w.result) && count(ASSOC, idOf(REANIMATE.book)) === 0, w.result);
w = shop(SENIOR);
check('a Senior sees them', hasTome(w, RAISE) && hasTome(w, REANIMATE));
w = buy(SENIOR, REANIMATE.book);
check('...and buys one', w.resultKind === 'ok' && count(SENIOR, idOf(REANIMATE.book)) === 1, w.result);
put(SENIOR, 'private.dboTomeBoughtAt', 0);
load(Object.assign(baseCfg(), { spells: Object.assign({}, baseCfg().spells, { seniorOnlyTomes: [] }) }));
check('an empty seniorOnlyTomes opens them to every member', hasTome(shop(ASSOC), RAISE));
load();

// ---- 4. teaching at a college's ledger ---------------------------------------------------------------------------------
for (const a of online) put(a, 'private.dboTomeBoughtAt', 0);
for (const a of [SENIOR, ASSOC, WHISPER, INITIATE, SMITH, FAR]) put(a, 'private.dboStudied', {});
for (const a of [SENIOR, ASSOC, WHISPER, INITIATE, SMITH, FAR]) known(a).clear();
for (const a of [SENIOR, ASSOC, WHISPER, INITIATE, SMITH, FAR]) gold(a, 1000); // no tomes carried
put(SENIOR, 'private.dboTomeBoughtAt', wallClock - DAY); put(SENIOR, 'private.dboTomeBuys', [wallClock - DAY]); // one of the two used
known(SENIOR).add(idOf(FIREBOLT.spell)); known(SENIOR).add(idOf(FIREBALL.spell)); known(SENIOR).add(idOf(REANIMATE.spell)); known(SENIOR).add(idOf(SPARKS.spell));
skillAt(ASSOC, 'arcane', 30); // Apprentice: may hold an Apprentice spell
at(SENIOR, SYNOD, [70, 0, 0]); at(ASSOC, SYNOD, [400, 0, 0]); at(INITIATE, SYNOD, [-400, 0, 0]); at(WHISPER, SYNOD, [0, 400, 0]);
member(FAR, 'synod', 'Associate'); skillAt(FAR, 'arcane', 30); at(FAR, SYNOD, [20 * 70, 0, 0]);
check('a Senior at their own college\'s ledger is offered the teaching row', globalThis.__dboTeachLedgerActions(SENIOR, LEDGER).some((r) => r.id === 'teach'));
check('...an Associate is not', globalThis.__dboTeachLedgerActions(ASSOC, LEDGER).length === 0);
check('...nor is the Senior at another college\'s ledger (Frostcrag Spire)', globalThis.__dboTeachLedgerActions(SENIOR, CRAG_LEDGER).length === 0);
// Through the Scholars' Ledger's own menu (salvage.js)
globalThis.__dboSalvageActivate(LEDGER, SENIOR);
const ledgerMenu = lastWidget(SENIOR, 'contextMenu');
check('the Scholars\' Ledger lists "Teach a spell to a student"', ledgerMenu.id === 66 && ledgerMenu.actions.some((x) => x.id === 'teach' && x.label === 'Teach a spell to a student'), ledgerMenu.actions.map((x) => x.id));
const seq0 = out.seq.length;
ui('salvageChoose', SENIOR, ['teach'], 66);
w = lastWidget(SENIOR, 'contextMenu');
check('...it opens the teaching menu (widget 45) before the ledger menu closes (panel handoff)', w.id === 45 && JSON.stringify(out.seq.slice(seq0)) === JSON.stringify([['open', SENIOR, 45], ['close', SENIOR, 66]]), out.seq.slice(seq0));
check('...listing the college\'s members within 15 m, its Initiate and smith too: not the Whisperer nor one 20 m off', w.actions.map((x) => x.id).join() === `cstudent:${ASSOC.toString(16)},cstudent:${INITIATE.toString(16)},cstudent:${SMITH.toString(16)},cancel`, w.actions);
ui('spellsChoose', SENIOR, [`cstudent:${ASSOC.toString(16)}`], 45);
w = lastWidget(SENIOR, 'contextMenu');
check('choosing the student lists the Senior\'s spells up to Expert', w.actions.some((x) => /Firebolt/.test(x.label)) && w.actions.some((x) => /Fireball/.test(x.label)) && w.actions.some((x) => /Reanimate Corpse/.test(x.label)), w.actions.map((x) => x.label));
// The teacher's menu closes once a lesson is offered, so each lesson starts at the ledger again
const pick = (a, place, student) => { globalThis.__dboTeachOpen(a, place); ui('spellsChoose', a, [`cstudent:${student.toString(16)}`], 45); };
const lesson = (a, student, t, place) => { if (place) pick(a, place, student); ui('spellsChoose', a, [`clesson:${student.toString(16)}:${t.spell}`], 45); };
lesson(SENIOR, ASSOC, FIREBALL);
check('an Adept spell for an Associate is refused, in the menu\'s title', /At Assoc's rank they may be taught spells up to Apprentice; Fireball is an Adept spell/.test(lastWidget(SENIOR, 'contextMenu').targetName), lastWidget(SENIOR, 'contextMenu').targetName);
lesson(SENIOR, ASSOC, REANIMATE);
check('a restricted art for an Associate is refused', /restricted arts.*Assoc is not/.test(lastWidget(SENIOR, 'contextMenu').targetName), lastWidget(SENIOR, 'contextMenu').targetName);
lesson(SENIOR, ASSOC, FIREBOLT);
let offer = lastWidget(ASSOC, 'contextMenu');
check('Firebolt is offered to the student, who is asked', offer && offer.id === 45 && /Senior offers to teach you Firebolt \(Destruction, Apprentice\)/.test(offer.targetName) && /Your tome purchase today is used when they accept/.test(said(SENIOR)), [offer && offer.targetName, said(SENIOR)]);
ui('spellsOffer', ASSOC, ['decline'], 45);
check('a declined lesson spends nothing', getp(SENIOR, 'private.dboTomeBoughtAt') === wallClock - DAY && !studiedAll(ASSOC).length && /declines the lesson/.test(said(SENIOR)));
lesson(SENIOR, ASSOC, FIREBOLT, LEDGER);
ui('spellsOffer', ASSOC, ['accept'], 45);
check('accepted: the student learns Firebolt, no book changes hands', studiedAll(ASSOC).includes(FIREBOLT.spell) && count(ASSOC, idOf(FIREBOLT.book)) === 0 && /Senior teaches you Firebolt/.test(said(ASSOC)), [studiedAll(ASSOC), said(ASSOC)]);
check('...the day\'s purchase is spent (yesterday\'s no longer counts)', getp(SENIOR, 'private.dboTomeBoughtAt') === wallClock && getp(SENIOR, 'private.dboTomeBuys').length === 1 && /That used your tome purchase today; the next is yours in 1 day/.test(said(SENIOR)), said(SENIOR));
check('...audited as TEACH', /^TEACH P14 taught 12fd0:Skyrim.esm Firebolt to P15 at 13f774:DragonBreak Online Edits.esp for synod \(a tome purchase;/.test(lastAudit(/^TEACH/)), lastAudit(/^TEACH/));
check('...and the Senior\'s shop is spent for the day: a lesson shares the quota', shop(SENIOR).canBuy === false && /taught with/.test(shop(SENIOR).whyNot), shop(SENIOR).whyNot);
skillAt(INITIATE, 'arcane', 30);
lesson(SENIOR, INITIATE, SPARKS, LEDGER);
check('a further lesson that day is refused without a tome', /You have had your tome today.*or teach from a tome of the spell you carry/.test(lastWidget(SENIOR, 'contextMenu').targetName) && !studiedAll(INITIATE).length, lastWidget(SENIOR, 'contextMenu').targetName);
api.giveItem(SENIOR, idOf(SPARKS.book), 1);
globalThis.__dboTeachOpen(SENIOR, LEDGER); ui('spellsChoose', SENIOR, [`cstudent:${INITIATE.toString(16)}`], 45);
check('...a tome of the spell carried is named on its row', lastWidget(SENIOR, 'contextMenu').actions.some((x) => /Sparks.*uses your tome of it/.test(x.label)));
lesson(SENIOR, INITIATE, SPARKS); ui('spellsOffer', INITIATE, ['accept'], 45);
check('...and teaching from it uses the tome up, not the quota: an Initiate may be taught a Novice spell', studiedAll(INITIATE).includes(SPARKS.spell) && count(SENIOR, idOf(SPARKS.book)) === 0 && /\(tome 9cd53:Skyrim.esm;/.test(lastAudit(/^TEACH/)), [studiedAll(INITIATE), lastAudit(/^TEACH/)]);
put(SENIOR, 'private.dboTomeBoughtAt', 0);
lesson(SENIOR, ASSOC, FIREBOLT, LEDGER);
check('a spell the student knows is refused', /Assoc already knows Firebolt/.test(lastWidget(SENIOR, 'contextMenu').targetName), lastWidget(SENIOR, 'contextMenu').targetName);
// The student's own gates: Arcane Arts at Novice holds Novice spells only
skillAt(INITIATE, 'arcane', 10);
lesson(SENIOR, INITIATE, FIREBOLT, LEDGER);
check('a student whose skill is short of the rank is "not ready", with the reason', /Initiate is not ready for Firebolt: Firebolt is an Apprentice spell\. Arcane Arts at Novice allows up to Novice spells/.test(lastWidget(SENIOR, 'contextMenu').targetName), lastWidget(SENIOR, 'contextMenu').targetName);
// The schools of magic gate a student whose client draws them: an Illusionist is not taught Destruction
ui('uiCaps', INITIATE, ['spellbook', 'schools']);
skillAt(INITIATE, 'arcane', 30);
put(INITIATE, 'private.dboSchools', { v: 1, primary: 'Illusion', secondary: null, levels: { Illusion: { level: 30, xp: 0 } }, grandfathered: [], picks: { Illusion: { spell: '', how: 'none', at: 1 } }, pickTold: {}, firstOffered: 1 });
lesson(SENIOR, INITIATE, FIREBOLT, LEDGER);
check('...and the student\'s school gate holds (Destruction is not one of their schools)', /Initiate is not ready for Firebolt: Destruction is not one of Initiate's schools of magic/.test(lastWidget(SENIOR, 'contextMenu').targetName), lastWidget(SENIOR, 'contextMenu').targetName);
ui('uiCaps', INITIATE, ['spellbook']);
// The offer is checked again on acceptance: the student walked off
lesson(SENIOR, ASSOC, SPARKS, LEDGER);
offer = lastWidget(ASSOC, 'contextMenu');
at(ASSOC, BRUMA);
ui('spellsOffer', ASSOC, ['accept'], 45);
check('a student who walked off before accepting is refused, nothing spent', !studiedAll(ASSOC).includes(SPARKS.spell) && !getp(SENIOR, 'private.dboTomeBoughtAt') && /must stand within 15 m/.test(said(ASSOC)), said(ASSOC));
at(ASSOC, SYNOD, [400, 0, 0]);
// A Senior of the College of Whispers teaches at Frostcrag Spire, not at the Synod
const CRAGSENIOR = 0x1e; NAMES[CRAGSENIOR] = 'Cragsenior'; online.push(CRAGSENIOR); put(CRAGSENIOR, 'profileId', CRAGSENIOR);
member(CRAGSENIOR, 'college-of-whispers', 'Senior Whisperer'); skillAt(CRAGSENIOR, 'arcane', 80); known(CRAGSENIOR).add(idOf(SPARKS.spell));
at(CRAGSENIOR, SYNOD, [70, 0, 0]);
check('a Senior Whisperer gets no teaching row at the Synod\'s ledger', globalThis.__dboTeachLedgerActions(CRAGSENIOR, LEDGER).length === 0);
at(CRAGSENIOR, FROSTCRAG, [70, 0, 0]); at(WHISPER, FROSTCRAG, [300, 0, 0]); put(WHISPER, 'private.dboStudied', {}); known(WHISPER).clear();
check('...but does at Frostcrag Spire\'s', globalThis.__dboTeachLedgerActions(CRAGSENIOR, CRAG_LEDGER).length === 1);
globalThis.__dboTeachOpen(CRAGSENIOR, CRAG_LEDGER);
check('...where the College of Whispers\' members are listed', lastWidget(CRAGSENIOR, 'contextMenu').actions.map((x) => x.id).join() === `cstudent:${WHISPER.toString(16)},cancel` && /College of Whispers/.test(lastWidget(CRAGSENIOR, 'contextMenu').targetName), lastWidget(CRAGSENIOR, 'contextMenu'));
ui('spellsChoose', CRAGSENIOR, [`cstudent:${WHISPER.toString(16)}`], 45);
lesson(CRAGSENIOR, WHISPER, SPARKS); ui('spellsOffer', WHISPER, ['accept'], 45);
check('...and taught', studiedAll(WHISPER).includes(SPARKS.spell) && / for college-of-whispers /.test(lastAudit(/^TEACH/)), lastAudit(/^TEACH/));
load(Object.assign(baseCfg(), { spells: Object.assign({}, baseCfg().spells, { collegeTeach: { enabled: false } }) }));
check('collegeTeach.enabled false takes the row away', globalThis.__dboTeachLedgerActions(SENIOR, LEDGER).length === 0);
load();

// ---- 5. the Class Lectern: a Senior chooses first, and a teacher qualified by Arcane Arts 75 -----------------------
for (const a of [SENIOR, TEACHER, PLAINT, BEGIN, BEGIN2, ASSOC]) ui('uiCaps', a, ['spellbook', 'schools']);
at(SENIOR, SYNOD, [300, 70, 0]);
put(SENIOR, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, levels: { Destruction: { level: 80, xp: 0 } }, grandfathered: [], picks: { Destruction: { spell: '', how: 'none', at: 1 } }, pickTold: {}, teacher: { by: 'staff', at: 1 }, firstOffered: 1 });
const seq1 = out.seq.length;
globalThis.__dboSchoolsActivate(LECTERN, SENIOR);
w = lastWidget(SENIOR);
check('a Senior at their college\'s Class Lectern chooses first: a class or teaching', w.type === 'contextMenu' && w.id === 45 && w.targetName === 'Class Lectern' && w.actions.map((x) => x.id).join() === 'lectern,teach,cancel', w);
ui('spellsChoose', SENIOR, ['lectern'], 45);
check('..."Hold or join a class" opens the lectern panel, then closes the menu (panel handoff)', lastWidget(SENIOR).type === 'classLectern' && JSON.stringify(out.seq.slice(seq1 + 1)) === JSON.stringify([['open', SENIOR, 72], ['close', SENIOR, 45]]), out.seq.slice(seq1));
globalThis.__dboSchoolsActivate(LECTERN, SENIOR); ui('spellsChoose', SENIOR, ['teach'], 45);
check('..."Teach a spell" opens the student list', /which student of The Synod/.test(lastWidget(SENIOR, 'contextMenu').targetName), lastWidget(SENIOR, 'contextMenu').targetName);
ui('spellsChoose', SENIOR, ['cancel'], 45);
at(ASSOC, SYNOD, [300, 70, 0]);
globalThis.__dboSchoolsActivate(LECTERN, ASSOC);
check('anyone else gets the lectern panel at once', lastWidget(ASSOC).type === 'classLectern');
// Qualification: Arcane Arts 75, or Expert study in a school
member(TEACHER, 'synod', 'Mage of the Synod'); member(PLAINT, 'synod', 'Mage of the Synod');
for (const a of [TEACHER, PLAINT]) at(a, SYNOD, [300, 70, 0]);
skillAt(TEACHER, 'arcane', 78); skillAt(PLAINT, 'arcane', 60);
const adeptSchool = (a) => put(a, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, levels: { Destruction: { level: 55, xp: 0 } }, grandfathered: [], picks: { Destruction: { spell: '', how: 'none', at: 1 } }, pickTold: {}, teacher: { by: 'staff', at: 1 }, firstOffered: 1 });
adeptSchool(TEACHER); adeptSchool(PLAINT);
for (const a of [TEACHER, PLAINT]) { known(a).add(idOf(FLAMES.spell)); known(a).add(idOf(FIREBALL.spell)); known(a).add(idOf(tome('SpellTomeIncinerate').spell)); }
globalThis.__dboSchoolsActivate(LECTERN, PLAINT);
w = lastWidget(PLAINT, 'classLectern');
check('Adept study and Arcane Arts 60: not qualified, and told both ways in', w.canTeach === false && /Teaching a class takes Arcane Arts at 75 or Expert study in one of your schools/.test(w.whyNot), w.whyNot);
globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
w = lastWidget(TEACHER, 'classLectern');
check('Adept study and Arcane Arts 78: qualified, by spells up to their study (Flames, Fireball; not Incinerate)', w.canTeach === true && w.spells.map((x) => x.name).join() === 'Flames,Fireball', [w.whyNot, w.spells]);
load(Object.assign(baseCfg(), { schools: Object.assign({}, baseCfg().schools, { classes: Object.assign({}, CONFIG.schools.classes, { teacherArcaneLevel: 101 }) }) }));
globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
check('teacherArcaneLevel above 100 brings back the old rule (Expert study only)', lastWidget(TEACHER, 'classLectern').canTeach === false);
load();

// ---- 6. a class for students before their first spell ----------------------------------------------------------------
for (const a of [BEGIN, BEGIN2]) { at(a, SYNOD, [300, 140, 0]); member(a, 'synod', 'Initiate'); put(a, 'private.mastery', { v: 2, skills: {}, order: [] }); }
globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, FIREBALL.spell]);
globalThis.__dboSchoolsActivate(LECTERN, BEGIN);
w = lastWidget(BEGIN, 'classLectern');
check('an Adept class teaches a beginner nothing, and says so', w.canJoin === false && /Before your first spell a class teaches you only when it is set by a Novice or Apprentice spell; this one is Adept/.test(w.whyNot), w.whyNot);
ui('lecternCancel', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);
put(TEACHER, 'private.dboSchools', Object.assign(getp(TEACHER, 'private.dboSchools'), { classAt: 0 }));
globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, FLAMES.spell]);
globalThis.__dboSchoolsActivate(LECTERN, BEGIN);
w = lastWidget(BEGIN, 'classLectern');
check('a Novice class (Flames) is open to a beginner: Arcane Arts, paid as they sit', w.canJoin === true && /Before your first spell this class teaches you Arcane Arts: you would take the full lesson, paid as you sit/.test(w.gain), [w.whyNot, w.gain]);
ui('lecternJoin', BEGIN, [w.nonce]);
check('joining takes Arcane Arts up (as a first Study Magic sitting does)', arcaneLevel(BEGIN) === 1 && /took up Arcane Arts by joining a class/.test(lastAudit(/took up Arcane Arts/)), arcaneLevel(BEGIN));
dailyFull.add(BEGIN2 >>> 0); skillAt(BEGIN2, 'arcane', 5);
globalThis.__dboSchoolsActivate(LECTERN, BEGIN2); ui('lecternJoin', BEGIN2, [lastWidget(BEGIN2, 'classLectern').nonce]);
check('a beginner whose Wheel has no room today is refused, with the Wheel\'s line', !globalThis.__dboSchoolsState.classes.get(LECTERN).students.has(BEGIN2) && /You have learned all you can of Arcane Arts today/.test(lastWidget(BEGIN2, 'classLectern').result), lastWidget(BEGIN2, 'classLectern').result);
dailyFull.delete(BEGIN2 >>> 0);
const a0 = awards.length;
for (let m = 0; m < 30; m++) { wallClock += MIN; timers.get('schools.classes')(); }
const paid = awards.slice(a0).filter((x) => x.a === BEGIN);
const metered = paid.reduce((n, x) => n + x.units, 0), worth = paid.reduce((n, x) => n + x.units * x.rate, 0);
check('a 30-minute class pays the beginner each minute through the Wheel\'s award: 30 awards of weight 3, key the lectern', paid.length === 30 && paid.every((x) => x.skill === 'arcane' && x.weight === 3 && x.key === LECTERN), paid.length);
check('...each worth x2 (classes.firstRate, through skillrates.js)', paid.every((x) => x.rate === 2), paid.map((x) => x.rate));
check('...and never more work than the Wheel lets through: at most the bucket (13 + 20 an hour, so 23 in 30 minutes)', metered <= PS.bucketBurst + PS.bucketPerHour / 2 + 1e-9 && metered > 20, metered);
check('outside a class an award to Arcane Arts is worth x1', globalThis.__dboSkillRate(BEGIN, 'arcane', 'award', { key: LECTERN }) === 1);
console.log(`info a 30-minute class: ${metered.toFixed(1)} metered units, worth ${worth.toFixed(1)} (Arcane Arts 1 -> ${arcaneLevel(BEGIN)})`);
// The same 30 minutes at Study Magic before the first spell: 20 minutes a window, weight 3 a minute at x1 (schools.js)
{
  const SOLO = 0x1f; NAMES[SOLO] = 'Solo'; put(SOLO, 'private.mastery', { v: 2, skills: {}, order: [] }); skillAt(SOLO, 'arcane', 1);
  let soloWorth = 0;
  for (let m = 0; m < 20; m++) { wallClock += MIN; soloWorth += globalThis.__alduinakMasteryAward(SOLO, 'arcane', 3, 0x651cc) * 1; }
  wallClock -= 20 * MIN; // the class above is the clock's
  check(`...a solo sitting in the same time is worth about half (study ${soloWorth.toFixed(1)}, class ${worth.toFixed(1)})`, worth >= 1.8 * soloWorth, [soloWorth, worth]);
  console.log(`info solo Study Magic before the first spell: 20 minutes a window, worth ${soloWorth.toFixed(1)}`);
}
check('the beginner\'s student cooldown began with the first payment', Number(getp(BEGIN, 'private.dboSchools').paidAt) > 0);
const lecternPanel = lastWidget(TEACHER, 'classLectern');
ui('lecternEnd', TEACHER, [lecternPanel.nonce]);
check('ending the class tells the beginner what it came to, and pays nothing twice', /Teacher's class on Flames is over\. It taught you [\d.]+ of the Wheel's units of Arcane Arts, worth x2: Arcane Arts stands at \d+/.test(said(BEGIN)) && awards.filter((x) => x.a === BEGIN).length === paid.length, [said(BEGIN), awards.length - a0]);
check('...and no school meter was touched', !Object.keys((getp(BEGIN, 'private.dboSchools') || {}).levels || {}).length, getp(BEGIN, 'private.dboSchools').levels);
check('...audited as a beginner\'s pay', /class by P19 on Flames .* ended: P1a beginner \+[\d.]+ units x2/.test(lastAudit(/class by P19/)), lastAudit(/class by P19/));
// A second class within 12 hours pays them nothing
put(TEACHER, 'private.dboSchools', Object.assign(getp(TEACHER, 'private.dboSchools'), { classAt: 0 }));
globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, FLAMES.spell]);
globalThis.__dboSchoolsActivate(LECTERN, BEGIN);
check('the 12-hour student cooldown holds for a beginner', lastWidget(BEGIN, 'classLectern').canJoin === false && /You sat a class not long ago/.test(lastWidget(BEGIN, 'classLectern').whyNot), lastWidget(BEGIN, 'classLectern').whyNot);
// A beginner who reaches Arcane Arts 25 mid-class stops being paid
globalThis.__dboSchoolsActivate(LECTERN, BEGIN2); ui('lecternJoin', BEGIN2, [lastWidget(BEGIN2, 'classLectern').nonce]);
skillAt(BEGIN2, 'arcane', 24);
const a1 = awards.length;
for (let m = 0; m < 12; m++) { wallClock += MIN; timers.get('schools.classes')(); }
const paid2 = awards.slice(a1).filter((x) => x.a === BEGIN2);
check('a beginner who reaches Arcane Arts 25 mid-class is paid no further (the first spell opens instead)', arcaneLevel(BEGIN2) >= 25 && paid2.length < 12 && arcaneLevel(BEGIN2) < 27, [paid2.length, arcaneLevel(BEGIN2)]);
ui('lecternCancel', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);


// ---- 7. Worker E's two ideas: Conjuration casts count twice, and a class's spell is offered at its end -------------------
{
  const CONJ = 0x20, DEST = 0x21; NAMES[CONJ] = 'Conj'; NAMES[DEST] = 'Dest';
  for (const [a, school] of [[CONJ, 'Conjuration'], [DEST, 'Destruction']]) {
    online.push(a); put(a, 'profileId', a); at(a, BRUMA); ui('uiCaps', a, ['spellbook', 'schools']); skillAt(a, 'arcane', 60);
    put(a, 'private.dboSchools', { v: 1, primary: school, secondary: null, levels: { [school]: { level: 40, xp: 0 } }, grandfathered: [], picks: { [school]: { spell: '', how: 'none', at: 1 } }, pickTold: {}, firstOffered: 1 });
  }
  const xpOf = (a, school) => getp(a, 'private.dboSchools').levels[school].xp;
  globalThis.__dboSchoolsCast(CONJ, idOf(tome('SpellTomeConjureFamiliar').spell));
  globalThis.__dboSchoolsCast(DEST, idOf(FLAMES.spell));
  check('a Conjuration cast counts twice what a Destruction cast does toward its school (castUnitsBySchool)', Math.abs(xpOf(CONJ, 'Conjuration') - 2 * xpOf(DEST, 'Destruction')) < 1e-9 && xpOf(DEST, 'Destruction') > 0, [xpOf(CONJ, 'Conjuration'), xpOf(DEST, 'Destruction')]);
  const sum = (a) => getp(a, 'private.dboSchools').cast.units;
  check('...and the day\'s cast cap fills as fast (40 a school)', Math.abs(sum(CONJ).Conjuration - 2 * sum(DEST).Destruction) < 1e-9, [sum(CONJ), sum(DEST)]);

  // A class on Sparks (Novice): the Destruction students who stayed are offered Sparks
  const STU = 0x22, STU2 = 0x23; NAMES[STU] = 'Stu'; NAMES[STU2] = 'Stutwo';
  for (const a of [STU, STU2]) {
    online.push(a); put(a, 'profileId', a); at(a, SYNOD, [300, 140, 0]); ui('uiCaps', a, ['spellbook', 'schools']); skillAt(a, 'arcane', 30); member(a, 'synod', 'Associate');
    put(a, 'private.dboSchools', { v: 1, primary: 'Destruction', secondary: null, levels: { Destruction: { level: 10, xp: 0 } }, grandfathered: [], picks: { Destruction: { spell: '', how: 'none', at: 1 } }, pickTold: {}, firstOffered: 1 });
  }
  known(STU2).add(idOf(SPARKS.spell));
  known(TEACHER).add(idOf(SPARKS.spell));
  wallClock += 2 * HOUR;
  put(TEACHER, 'private.dboSchools', Object.assign(getp(TEACHER, 'private.dboSchools'), { classAt: 0 }));
  const boughtBefore = getp(TEACHER, 'private.dboTomeBoughtAt');
  globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
  ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, SPARKS.spell]);
  for (const a of [STU, STU2]) { globalThis.__dboSchoolsActivate(LECTERN, a); ui('lecternJoin', a, [lastWidget(a, 'classLectern').nonce]); }
  check('two Destruction students sign up for a Sparks class', [STU, STU2].every((a) => globalThis.__dboSchoolsState.classes.get(LECTERN).students.has(a)));
  for (let m = 0; m < 31; m++) { wallClock += MIN; timers.get('schools.classes')(); }
  ui('lecternEnd', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);
  const offerW = lastWidget(STU, 'contextMenu');
  check('when the class ends, a student who stayed is offered its spell (Learn / Decline)', offerW && offerW.id === 45 && /Teacher offers to teach you Sparks \(Destruction, Novice\), the spell of the class/.test(offerW.targetName) && offerW.actions.map((x) => x.id).join() === 'accept,decline', offerW);
  check('...one who already knows it is not asked', !(lastWidget(STU2, 'contextMenu') || {}).targetName || !/the spell of the class/.test(lastWidget(STU2, 'contextMenu').targetName));
  ui('spellsOffer', STU, ['accept'], 45);
  check('...accepting learns it, audited as TEACH at a class', studiedAll(STU).includes(SPARKS.spell) && /^TEACH P19 taught 2dd2a:Skyrim.esm Sparks to P22 at a class/.test(lastAudit(/^TEACH/)), [studiedAll(STU), lastAudit(/^TEACH/)]);
  check('...and costs the teacher one tome purchase for the class (Nate, 11 Oct: no spell for nothing)', getp(TEACHER, 'private.dboTomeBoughtAt') === wallClock && getp(TEACHER, 'private.dboTomeBoughtAt') !== boughtBefore && /tome purchase/.test(lastAudit(/^TEACH/)), [boughtBefore, getp(TEACHER, 'private.dboTomeBoughtAt'), lastAudit(/^TEACH/)]);
  // One credit per class: two students of one class, one tome carried
  api.giveItem(TEACHER, idOf(FLAMES.book), 1);
  for (const a of [STU, STU2]) { known(a).delete(idOf(FLAMES.spell)); }
  const key = 'harness-class-1';
  const o1 = globalThis.__dboSpellsClassOffer(TEACHER, STU, idOf(FLAMES.spell), key);
  const o2 = globalThis.__dboSpellsClassOffer(TEACHER, STU2, idOf(FLAMES.spell), key);
  check('with its purchase spent, a teacher carrying a tome still has the class spell offered', o1 === true && o2 === true, [o1, o2, said(STU), said(STU2)]);
  ui('spellsOffer', STU, ['accept'], 45);
  check('...the first to accept uses the teacher\'s tome', studiedAll(STU).includes(FLAMES.spell) && count(TEACHER, idOf(FLAMES.book)) === 0, [studiedAll(STU), count(TEACHER, idOf(FLAMES.book))]);
  ui('spellsOffer', STU2, ['accept'], 45);
  check('...the second of the same class learns it on the same tome', studiedAll(STU2).includes(FLAMES.spell) && /the class's tome/.test(lastAudit(/^TEACH/)), [studiedAll(STU2), lastAudit(/^TEACH/)]);
  for (const a of [STU2]) { known(a).delete(idOf(FLAMES.spell)); put(a, 'private.dboStudied', {}); }
  check('a new class with no tome and no purchase left offers nothing, and says why', globalThis.__dboSpellsClassOffer(TEACHER, STU2, idOf(FLAMES.spell), 'harness-class-2') === false && /no tome purchase left today/.test(said(STU2)), said(STU2));
  api.giveItem(TEACHER, idOf(FLAMES.book), 1);
  // The offer keeps the college rules: rank cap and restricted arts, and it lapses after 180 s
  known(TEACHER).add(idOf(FIREBALL.spell)); known(TEACHER).add(idOf(REANIMATE.spell));
  check('an Adept class spell is not offered to an Associate (rank cap), who is told why', globalThis.__dboSpellsClassOffer(TEACHER, STU, idOf(FIREBALL.spell)) === false && /would teach you Fireball, but: At your rank you may be taught spells up to Apprentice/.test(said(STU)), said(STU));
  check('a restricted art is not offered to an Associate', globalThis.__dboSpellsClassOffer(TEACHER, STU, idOf(REANIMATE.spell)) === false && /restricted arts/.test(said(STU)), said(STU));
  globalThis.__dboSpellsClassOffer(TEACHER, STU2, idOf(FLAMES.spell));
  wallClock += 181 * 1000;
  ui('spellsOffer', STU2, ['accept'], 45);
  check('a class offer lapses after 180 s', !studiedAll(STU2).includes(FLAMES.spell) && /The offer has lapsed/.test(said(STU2)), said(STU2));
  load(Object.assign(baseCfg(), { schools: Object.assign({}, baseCfg().schools, { classes: Object.assign({}, CONFIG.schools.classes, { offerSpell: false }) }) }));
  wallClock += 13 * HOUR;
  put(TEACHER, 'private.dboSchools', Object.assign(getp(TEACHER, 'private.dboSchools'), { classAt: 0 }));
  for (const a of [TEACHER, STU2]) ui('uiCaps', a, ['spellbook', 'schools']);
  known(STU2).delete(idOf(SPARKS.spell));
  globalThis.__dboSchoolsActivate(LECTERN, TEACHER);
  ui('lecternStart', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce, SPARKS.spell]);
  globalThis.__dboSchoolsActivate(LECTERN, STU2); ui('lecternJoin', STU2, [lastWidget(STU2, 'classLectern').nonce]);
  for (let m = 0; m < 31; m++) { wallClock += MIN; timers.get('schools.classes')(); }
  const w0 = out.widgets.length;
  ui('lecternEnd', TEACHER, [lastWidget(TEACHER, 'classLectern').nonce]);
  check('classes.offerSpell false: the class pays, and offers no spell', saidAny(STU2, /class on Sparks is over/) && !out.widgets.slice(w0).some((x) => x.a === STU2 && /the spell of the class/.test(x.w.targetName || '')), out.widgets.slice(w0).filter((x) => x.a === STU2).map((x) => x.w.type));
  load();
}

console.log(`\n${checks - failures}/${checks} passed`);
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
