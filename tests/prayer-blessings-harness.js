// Scripted test for how server\prayer.js hands over a blessing (2026-10-01). The server's AddSpell only puts a spell in the
// learned list, so every Divine and Prince blessing (a Spell cast Fire-and-Forget on Self) was taught as a castable
// "Blessing of X" and never ran. Now such a blessing is cast on the worshipper by their own client (dboCastSelf), again at
// every login while it runs and again when the spell's own duration ends first; an Ability is still learned, and so is a
// Power. Also: closing a prayer round before its first press (to make an offering) rests no shrine. Loads the real
// module with a mock gamemode api and spell records shaped like the real ones. Run it from this folder's parent with
//
//   node tests/prayer-blessings-harness.js
'use strict';
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const PRAYER = path.join(SERVER, 'prayer.js');
const SKILLS = require(path.join(SERVER, 'skills.json'));

let virtual = 0;
globalThis.performance = { now: () => virtual };
let wallClock = 1790000000000;
const realNow = Date.now;
Date.now = () => wallClock;
const H = 3600000;

const ACTOR = 0x14;
const idOf = (d) => parseInt(String(d).split(':')[0], 16) >>> 0;
const choiceOf = (id) => SKILLS.deities.choices.find((c) => c.id === id);
const spellOf = (id) => idOf(choiceOf(id).blessing);

// Every blessing spell in skills.json, as the winning record reads in the server's load order (/opt/skyrim-data,
// plugins.server.txt, measured 2026-10-01): SPIT type (0 Spell, 2 Power, 3 Lesser Power, 4 Ability), cast type
// (0 Constant Effect, 1 Fire and Forget), delivery (0 Self), and each effect's EFIT duration in seconds.
const MEASURED = {
  akatosh: ['AltarAkatoshSpell', 0, 1, 0, [28800, 0]], arkay: ['AltarArkaySpell', 0, 1, 0, [28800, 0]],
  dibella: ['DBO_BlessingOfDibella', 0, 1, 0, [28800, 0]], julianos: ['AltarJulianosSpell', 0, 1, 0, [28800, 0]],
  kynareth: ['AltarKynarethSpell', 0, 1, 0, [28800, 0]], mara: ['AltarMaraSpell', 0, 1, 0, [28800, 0]],
  stendarr: ['AltarStendarrSpell', 0, 1, 0, [28800, 0]], talos: ['DBO_BlessingOfTalos', 0, 1, 0, [28800, 0]],
  zenithar: ['DBO_BlessingOfZenithar', 0, 1, 0, [28800, 0]], auriel: ['DLC1AltarAurielSpell', 0, 1, 0, [43200, 0]],
  malacath: ['AltarMalacathSpell', 0, 1, 0, [28800, 0, 28800]], azura: ['DLC2AltarAzuraSpell', 0, 1, 0, [0, 28800]],
  boethiah: ['DLC2AltarBoethiahSpell', 0, 1, 0, [0, 28800]], mephala: ['DBO_BlessingOfMephala', 0, 1, 0, [28800, 0]],
  mehrunes: ['DBO_BlessingOfMehrunesDagon', 0, 1, 0, [28800, 0]], molagbal: ['DBO_BlessingOfMolagBal', 0, 1, 0, [28800, 0]],
  nocturnal: ['AltarNocturnalSpell', 0, 1, 0, [28800, 0]], hircine: ['DBO_BlessingOfHircine', 0, 1, 0, [28800, 0]],
  meridia: ['DBO_BlessingOfMeridia', 0, 1, 0, [28800, 0]], namira: ['DBO_BlessingOfNamira', 0, 1, 0, [28800, 28800]],
  peryite: ['DBO_BlessingOfPeryite', 0, 1, 0, [28800, 0]], vaermina: ['DBO_BlessingOfVaermina', 0, 1, 0, [28800, 0]],
  dragoncult: ['AltarTalosSpell', 0, 1, 0, [28800, 0]],
  hist: ['PowerArgonianHistskin', 2, 1, 0, [60, 60]], ancestors: ['PowerDarkElfFlameCloak', 2, 1, 0, [60, 62]],
  yokudan: ['PowerRedguardStaminaRegen', 2, 1, 0, [60]], riddlethar: ['PowerKhajiitNightEye', 3, 1, 0, [60]],
  trinimac: ['doomLordAbility', 4, 0, 0, [0, 0]], wormcult: ['doomApprenticeAbility', 4, 0, 0, [0]],
};
const CAST = Object.keys(MEASURED).filter((k) => MEASURED[k][1] === 0 && MEASURED[k][2] === 1);
const ABILITIES = ['trinimac', 'wormcult'];
const POWERS = ['hist', 'ancestors', 'yokudan', 'riddlethar'];
const field = (type, bytes) => ({ type, data: Uint8Array.from(bytes) });
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const spel = ([edid, type, castType, delivery, durations]) => ({ record: { type: 'SPEL', editorId: edid, fields: [
  field('EDID', []),
  // cost, flags, type, charge time, cast type, delivery, cast duration, range, half-cost perk
  field('SPIT', [...u32le(402104), ...u32le(0), ...u32le(type), ...u32le(0), ...u32le(castType), ...u32le(delivery), ...u32le(0), ...u32le(0), ...u32le(0)]),
  ...durations.flatMap((secs) => [field('EFID', u32le(0x800)), field('EFIT', [...u32le(0x41200000), ...u32le(0), ...u32le(secs)])]),
] } });

const records = new Map();
for (const [deity, m] of Object.entries(MEASURED)) records.set(spellOf(deity), spel(m));

const props = new Map();
let online = true;
const learned = new Set();                       // the server's learned list for ACTOR
const out = { packets: [], papyrus: [], logs: [], personals: [], widgets: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
const api = {
  mp: {
    getIdFromDesc: (d) => idOf(d),
    getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
    // The server's own AddSpell and RemoveSpell (PapyrusActor.cpp): the learned list only, and a snippet to the client
    // only when the list changed
    callPapyrusFunction: (kind, cls, fn, self, args) => {
      const spell = idOf(args[0] && args[0].desc);
      let changed = false;
      if (fn === 'AddSpell') { changed = !learned.has(spell); learned.add(spell); }
      if (fn === 'RemoveSpell') { changed = learned.delete(spell); }
      out.papyrus.push({ fn, spell, changed, n: out.packets.length });
      return changed;
    },
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push(t),
  audit: () => {},
  display: () => 'Tester #ABCD',
  who: () => 'Tester #ABCD (profile 1)',
  cfg: {},
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => (online ? [ACTOR] : []),
  every: (name, ms, fn) => { timers.set(name, fn); },
  skills: SKILLS,
  takeGold: () => true,
  treasuryHere: (a, n) => n,
  sendPacket: (a, p) => out.packets.push({ a, p }),
};

let failures = 0;
const check = (name, cond, detail) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); };
const clear = () => { for (const k of Object.keys(out)) out[k].length = 0; };
const fire = (ev, args) => (handlers.get(ev) || []).forEach((f) => f(ACTOR, args, 35));
const load = () => { delete require.cache[require.resolve(PRAYER)]; handlers.clear(); commands.clear(); timers.clear(); require(PRAYER)(api); };
const sweep = () => { clear(); timers.get('prayerBlessings')(); };
const casts = () => out.packets.filter((x) => x.a === ACTOR && x.p.customPacketType === 'dboCastSelf');
const calls = (fn) => out.papyrus.filter((c) => c.fn === fn);
const blessing = () => props.get(ACTOR + '|private.dboBlessing') || null;
const worship = (id, tier) => {
  const d = choiceOf(id);
  props.set(ACTOR + '|private.dboDeity', { id: d.id, name: d.name, kind: d.kind, at: 1, convertedAt: 1, warnedUnlawful: true });
  props.delete(ACTOR + '|private.prayedShrines');
  props.delete(ACTOR + '|private.dboBlessing');
  props.set(ACTOR + '|private.mastery', tier === undefined ? null : { order: ['priest'], skills: { priest: { rank: tier } } });
};
// A held prayer whose roll always lands, at the deity's own shrine (or anywhere, for a faith that needs none)
const prayAndWin = (id) => {
  const d = choiceOf(id);
  wallClock += 2000; virtual += 100000; clear();
  if (d.prayAnywhere) commands.get('pray')(ACTOR, '');
  else globalThis.__dboPrayerActivate(idOf(d.shrines[0]), ACTOR);
  const w = out.widgets[out.widgets.length - 1];
  if (!w || w.type !== 'prayer') return { ok: false, said: out.personals.join(' | ') };
  const start = virtual;
  virtual = start + w.totalMs + 100;
  const roll = Math.random; Math.random = () => 0;
  clear();
  try { fire('prayer', [w.nonce, JSON.stringify([[0, w.totalMs]]), w.totalMs]); } finally { Math.random = roll; }
  return { ok: true, said: out.personals.join(' | ') };
};

load();

// ---- 1. what each blessing is, read from its record --------------------------------------------------------------
check('the measured table covers every blessing spell in skills.json',
  SKILLS.deities.choices.filter((c) => /^[0-9a-f]+:/i.test(String(c.blessing))).every((c) => MEASURED[c.id]) && Object.keys(MEASURED).length === 29,
  `${Object.keys(MEASURED).length} measured`);
const boot = out.logs.find((l) => /^prayer on:/.test(l)) || '';
check('the boot line counts 23 blessings cast on the worshipper and 6 learned', /29 resolved \(23 cast on the worshipper, 6 learned\)/.test(boot), boot.replace(/^.*blessings /, ''));

// ---- 2. every blessing, granted for real -------------------------------------------------------------------------
const rows = [];
for (const id of Object.keys(MEASURED)) {
  worship(id);
  learned.clear();
  const r = prayAndWin(id);
  const b = blessing();
  const spell = spellOf(id);
  const sent = casts();
  rows.push({ id, ok: r.ok, sent: sent.length, packet: sent[0] && sent[0].p, added: calls('AddSpell').length, learnedNow: learned.has(spell), via: b && b.via, spellOk: !!b && b.spell === spell });
}
const row = (id) => rows.find((x) => x.id === id);
const castRows = CAST.map(row);
check('every Fire-and-Forget blessing (23) is cast on the worshipper by their own client',
  castRows.length === 23 && castRows.every((x) => x.ok && x.sent === 1 && x.via === 'cast' && x.spellOk),
  castRows.filter((x) => !(x.ok && x.sent === 1 && x.via === 'cast')).map((x) => x.id).join(', ') || '23 of 23');
check('the packet is the one castSelfService reads: { customPacketType: dboCastSelf, spell }',
  castRows.every((x) => x.packet && x.packet.customPacketType === 'dboCastSelf' && x.packet.spell === spellOf(x.id) && Object.keys(x.packet).length === 2),
  JSON.stringify(row('akatosh').packet));
check('and none of them is taught: no AddSpell, nothing in the learned list',
  castRows.every((x) => x.added === 0 && !x.learnedNow), castRows.filter((x) => x.added || x.learnedNow).map((x) => x.id).join(', '));
check('the Abilities (Trinimac, the Worm Cult) are still learned, which is what runs them, and nothing is cast',
  ABILITIES.map(row).every((x) => x.ok && x.added === 1 && x.learnedNow && x.sent === 0 && x.via === 'spell'),
  JSON.stringify(ABILITIES.map(row)));
check('the Powers (the Hist, the Ancestors, the Yokudan gods, Riddle\'Thar) keep today\'s behaviour: a power to use',
  POWERS.map(row).every((x) => x.ok && x.added === 1 && x.learnedNow && x.sent === 0 && x.via === 'spell'),
  JSON.stringify(POWERS.map(row).map((x) => [x.id, x.added, x.sent])));

// ---- 3. the cast, step by step: Akatosh at priest tier 3 (a 16 h blessing over an 8 h spell) ----------------------
worship('akatosh', 3);
learned.clear();
learned.add(spellOf('akatosh'));                 // taught by the old code and never taken back (a lost expiry)
prayAndWin('akatosh');
const T0 = wallClock;
let b = blessing();
const removeFirst = calls('RemoveSpell').find((c) => c.spell === spellOf('akatosh'));
check('a spell the old code taught is taken out of the learned list, before the cast is sent',
  !!removeFirst && removeFirst.changed && removeFirst.n === 0 && !learned.has(spellOf('akatosh')) && casts().length === 1,
  JSON.stringify(out.papyrus));
check('the blessing lasts the priest tier\'s 16 h', !!b && b.until === T0 + 16 * H && b.via === 'cast', JSON.stringify(b));
wallClock = T0 + 4 * H; sweep();
check('4 h in, with the spell still running, nothing is sent', casts().length === 0);
wallClock = T0 + 8 * H - 30000; sweep();
check('a sweep before the 8 h spell runs out, with the blessing running on, it is cast again', casts().length === 1 && casts()[0].p.spell === spellOf('akatosh'), JSON.stringify(out.packets));
wallClock += 60000; sweep();
check('once, not every sweep', casts().length === 0);
wallClock = T0 + 15 * H; sweep();
check('the second cast covers the blessing to its end: no third', casts().length === 0);

// ---- 4. login --------------------------------------------------------------------------------------------------
globalThis.__dboDeityForget(ACTOR);              // the gamemode's logout
wallClock = T0 + 10 * H; clear();
globalThis.__dboPrayerLogin(ACTOR);
check('a login while the blessing runs casts it again (the client lost it with the session)', casts().length === 1 && calls('AddSpell').length === 0, JSON.stringify(out.packets));
wallClock = T0 + 16 * H + 1; sweep();
check('at its end the blessing fades and nothing is taken back, there being nothing to take',
  !blessing() && calls('RemoveSpell').length === 0 && casts().length === 0 && out.personals.some((p) => /blessing of Akatosh fades/.test(p)), out.personals.join(' | '));
globalThis.__dboDeityForget(ACTOR);
clear(); globalThis.__dboPrayerLogin(ACTOR);
check('a login after it ended sends nothing', casts().length === 0 && out.papyrus.length === 0);

// an 8 h blessing over an 8 h spell ends with it: no cast at the spell's end
worship('akatosh', 0);
prayAndWin('akatosh');
const T1 = wallClock;
check('a tier-1 blessing lasts 8 h, as long as the spell', blessing() && blessing().until === T1 + 8 * H);
wallClock = T1 + 8 * H - 30000; sweep();
check('so the spell running out is not answered with another 8 h cast', casts().length === 0);
// nor is a login in its last minute
globalThis.__dboDeityForget(ACTOR); clear(); globalThis.__dboPrayerLogin(ACTOR);
check('nor a login in the blessing\'s last minute', casts().length === 0);

// ---- 5. a login that the gamemode never reported (the sweep's own catch) ------------------------------------------
worship('julianos');
prayAndWin('julianos');
globalThis.__dboDeityForget(ACTOR);              // logged out: a sweep runs while they are away
online = false; wallClock += 60000; sweep();
online = true;                                   // and back in; the login hook has not run (or never will)
wallClock += 60000; sweep();
const firstSweep = casts().length;
wallClock += 60000; sweep();
check('a worshipper online with no cast this session is cast at the second sweep, not the first (a login is still loading)',
  firstSweep === 0 && casts().length === 1, `${firstSweep}, then ${casts().length}`);

// ---- 6. a blessing granted before this fix ----------------------------------------------------------------------
learned.clear();
learned.add(spellOf('arkay'));
props.set(ACTOR + '|private.dboBlessing', { deity: 'arkay', spell: spellOf('arkay'), until: wallClock + 5 * H });
globalThis.__dboDeityForget(ACTOR); clear();
globalThis.__dboPrayerLogin(ACTOR);
b = blessing();
check('an old blessing (taught, no `via`) at login: the spell leaves the learned list and is cast for the time left',
  !learned.has(spellOf('arkay')) && calls('RemoveSpell').length === 1 && casts().length === 1 && b.via === 'cast' && b.until === wallClock + 5 * H,
  JSON.stringify({ papyrus: out.papyrus, b }));
const r6 = calls('RemoveSpell')[0];
check('the RemoveSpell goes out before the cast', r6.n === 0);
// one that expired while its worshipper was away
learned.add(spellOf('stendarr'));
props.set(ACTOR + '|private.dboBlessing', { deity: 'stendarr', spell: spellOf('stendarr'), until: wallClock - 1000 });
globalThis.__dboDeityForget(ACTOR); clear();
globalThis.__dboPrayerLogin(ACTOR);
check('an old blessing that ended offline is not cast at login', casts().length === 0);
sweep();
check('and the sweep takes its taught spell back as it always did', !blessing() && !learned.has(spellOf('stendarr')) && calls('RemoveSpell').length === 1);
// one running while its worshipper was online when this loaded: the second sweep
learned.add(spellOf('mara'));
props.set(ACTOR + '|private.dboBlessing', { deity: 'mara', spell: spellOf('mara'), until: wallClock + 3 * H });
globalThis.__dboBlessingCasts.delete(ACTOR);
delete globalThis.__dboBlessingSeen;             // the reload that ships this: no sweep has run yet
load();
sweep(); const s1 = casts().length;
wallClock += 60000; sweep();
check('an old blessing on someone online at the reload is moved over within two sweeps',
  s1 === 0 && casts().length === 1 && !learned.has(spellOf('mara')) && blessing().via === 'cast', `${s1}, then ${casts().length}`);

// ---- 7. an Ability: learned while it lasts, taken back at the end ------------------------------------------------
worship('trinimac');
learned.clear();
prayAndWin('trinimac');
const T2 = wallClock;
b = blessing();
check('Trinimac\'s Ability is learned for the faiths\' half-length blessing (4 h)', learned.has(spellOf('trinimac')) && b.until === T2 + 4 * H && b.via === 'spell', JSON.stringify(b));
globalThis.__dboDeityForget(ACTOR); clear(); globalThis.__dboPrayerLogin(ACTOR);
check('a login sends no cast for an Ability (the learned list comes back by itself)', casts().length === 0 && out.papyrus.length === 0);
wallClock = T2 + 4 * H + 1; sweep();
check('and at its end the Ability is taken back', !learned.has(spellOf('trinimac')) && calls('RemoveSpell').length === 1 && !blessing());

// ---- 8. a blessing shorter than its spell (the Dragon Cult, 4 h, over the 8 h AltarTalosSpell) --------------------
worship('dragoncult');
prayAndWin('dragoncult');
const T3 = wallClock;
check('the Dragon Cult\'s blessing is cast, and lasts 4 h', casts().length === 1 && blessing().until === T3 + 4 * H);
wallClock = T3 + 4 * H + 1; sweep();
check('it fades on the server at 4 h with nothing to take back (the client\'s 8 h effect cannot be cut short: NOTES.md)',
  !blessing() && calls('RemoveSpell').length === 0 && casts().length === 0);

// ---- 9. turning, the staff reset, Sheogorath -------------------------------------------------------------------
worship('kynareth');
prayAndWin('kynareth');
props.set(ACTOR + '|private.dboDeity', { id: 'kynareth', name: 'Kynareth', kind: 'divine', at: 1, convertedAt: 1 });
clear();
fire('deityChoose', ['x', 'mara']);              // a stale nonce: nothing
globalThis.__dboDeityPicker(ACTOR);
const pick = out.widgets[out.widgets.length - 1];
clear(); fire('deityChoose', [pick.nonce, 'mara']);
check('turning to another god ends a cast blessing with no RemoveSpell', (props.get(ACTOR + '|private.dboDeity') || {}).id === 'mara'
  && !blessing() && calls('RemoveSpell').length === 0, JSON.stringify(out.papyrus));

worship('sheogorath');
const roll = Math.random;
const r9 = prayAndWin('sheogorath');
Math.random = roll;
b = blessing();
check('Sheogorath hands over another god\'s blessing, and a Fire-and-Forget one is cast',
  r9.ok && !!b && b.deity !== 'sheogorath' && (CAST.includes(b.deity) ? casts().length === 1 && b.via === 'cast' : calls('AddSpell').length === 1),
  JSON.stringify(b));

// ---- 10. a record the server cannot read keeps AddSpell --------------------------------------------------------
const saved = records.get(spellOf('nocturnal'));
records.delete(spellOf('nocturnal'));
load();
worship('nocturnal');
learned.clear();
prayAndWin('nocturnal');
check('a blessing whose record cannot be read is taught as before, not lost', calls('AddSpell').length === 1 && casts().length === 0 && blessing().via === 'spell'
  && out.logs.some((l) => /record unreadable/.test(l)));
records.set(spellOf('nocturnal'), saved);

// ---- 11. an offering costs no shrine rest (the second fix of 2026-10-01) ------------------------------------------
// /offer wants the shrine touched first, and a touch at a shrine that is not resting opens a prayer round. Closing that
// round to type /offer used to finish it as a failure, which rested the shrine for 5 minutes before the prayer.
const SHRINE = idOf(choiceOf('akatosh').shrines[0]);
const rests = () => props.get(ACTOR + '|private.prayedShrines') || {};
const touch = () => { wallClock += 2000; virtual += 100000; clear(); globalThis.__dboPrayerActivate(SHRINE, ACTOR); return { w: out.widgets.find((x) => x.type === 'prayer' && !x.result), said: out.personals.join(' | ') }; };
worship('akatosh');
let t = touch();
check('a touch at the shrine opens a round', !!t.w);
clear(); fire('prayerCancel', [t.w.nonce]);
const closed = out.widgets.find((x) => x.type === 'prayer' && x.result);
check('closed before the first press, it rests nothing', !rests()[SHRINE.toString(16)] && !!closed && /without praying/.test(closed.result), JSON.stringify(rests()));
clear(); commands.get('offer')(ACTOR, '50');
const offering = props.get(ACTOR + '|private.dboOffering');
check('the offering is taken at the shrine just touched', !!offering && offering.deityId === 'akatosh' && offering.gold === 50, out.personals.join(' | '));
t = touch();
check('and the shrine hears the prayer it was made for at once', !!t.w && !/prayed here recently/.test(t.said), t.said);
clear(); fire('prayerStart', [t.w.nonce]);
virtual += 3000; clear(); fire('prayerCancel', [t.w.nonce]);
check('a round begun (the first press) and abandoned still rests the shrine', Number(rests()[SHRINE.toString(16)]) === wallClock + 5 * 60000, JSON.stringify(rests()));
t = touch();
check('so the next touch is refused for those minutes', !t.w && /prayed here recently/.test(t.said), t.said);

// ---- 12. the same for Escape (the relay's close), which the client-judged prayer now answers ---------------------
props.delete(ACTOR + '|private.prayedShrines');
t = touch();
clear(); fire('close', []);
check('Escape before the first press rests nothing either, and says so', !rests()[SHRINE.toString(16)] && /without praying/.test(out.personals.join(' | ')), JSON.stringify(rests()));
t = touch();
check('...so the shrine opens a round again at once', !!t.w && !/prayed here recently/.test(t.said), t.said);
clear(); fire('prayerStart', [t.w.nonce]);
virtual += 3000; clear(); fire('close', []);
check('Escape after the first press still rests the shrine', Number(rests()[SHRINE.toString(16)]) === wallClock + 5 * 60000, JSON.stringify(rests()));

console.log('');
console.log('deity        cast  learned  via');
for (const x of rows) console.log(`${x.id.padEnd(12)} ${String(x.sent).padEnd(5)} ${String(x.learnedNow).padEnd(8)} ${x.via}`);
Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
