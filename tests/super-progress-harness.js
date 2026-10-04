// The skills menu's Werewolf and Vampire tab (Nate, 2026-09-30): what supernatural.js sends beside the skills when a
// player opens K (dboSuperProgress), for a werewolf, a vampire and anyone else. Loads the real greathunt.js,
// bloodranks.js and supernatural.js against a stub api. The front half is tests/supernatural-tab-harness.js.
// node tests/super-progress-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const store = new Map(); // `${id}|${prop}` -> value
const packets = [];
const cmds = {};
const timers = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 8, 30, 12, 0);
Date.now = () => now;
let day = 10.25; // game days on the world clock
let hunger = 0;
globalThis.__dboClock = { gameDays: () => day, summary: () => ({ timeScale: 6 }), isNight: () => false, isFullMoon: () => false };
globalThis.__dboSuperState = { crown: null, revoke: [] }; // never the runtime supernatural.json beside the gamemode
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const api = {
  mp, log: noop, audit: noop, personal: noop, system: noop, registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: (a, p) => packets.push({ a, p }), display: String, who: String,
  isAdmin: () => false, findByName: () => null, onlineActors: () => online, every: (n, ms, f) => { timers[n] = f; }, profileOf: (a) => a,
  nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => hunger, zoneOfActor: () => null, zoneById: () => null, cfg: {},
  hasUiCap: (a, c) => caps.has(c),
};
for (const f of ['greathunt.js', 'bloodranks.js', 'supernatural.js']) require(path.resolve(__dirname, '..', f))(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`); if (!c) fail++; };
const WOLF = 11, VAMP = 12, PLAIN = 13;
const caps = new Set();   // the client's UI caps: riteJudge decides what a lost fever rite does
const curse = (a, s) => store.set(`${a}|private.supernatural`, Object.assign({ kind: null, stage: 0, lastFed: 0, pure: false, blessed: false, beastDay: -1 }, s));
const row = (v, label) => (v.rows.filter((r) => r.label === label)[0] || null);
const power = (v, name) => (v.powers.filter((p) => p.name === name)[0] || null);

ok(typeof globalThis.__dboSuperProgress === 'function' && typeof globalThis.__dboSuperProgressSend === 'function', 'supernatural.js gives the skills menu its progress hooks');
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }

// Someone with no curse: no tab, and the null that takes an old one away
ok(globalThis.__dboSuperProgress(PLAIN) === null, 'no curse, no tab');
globalThis.__dboSuperProgressSend(PLAIN);
let last = packets[packets.length - 1];
ok(last && last.a === PLAIN && last.p.customPacketType === 'dboSuperProgress' && last.p.progress === null, 'they are sent null, so a cured player loses the tab', last);

// A lone werewolf at the start of the Hunt
curse(WOLF, { kind: 'werewolf' });
store.set(`${WOLF}|private.greatHunt`, { renown: 12, fedOn: {} });
let v = globalThis.__dboSuperProgress(WOLF);
ok(v && v.kind === 'werewolf' && v.label === 'Werewolf' && v.group === 'The Beast', 'a werewolf gets the Werewolf tab', v);
ok(v.epithet === 'Fledgling of the Hunt', 'titled by their rank in the Hunt', v.epithet);
ok(v.ladder && v.ladder.value === 12 && v.ladder.rank === 0 && v.ladder.unit === 'renown' && v.ladder.ranks.length === 5, 'the ladder: 12 renown, first of five ranks', v.ladder);
ok(v.ladder.ranks[1].name === 'Prowler' && v.ladder.ranks[1].at === 100, '...the next is Prowler at 100', v.ladder.ranks[1]);
ok(/150 s in the beast, a feed adds 30 s, 1 change a day/.test(v.ladder.ranks[0].perk), "...each rank says what it gives", v.ladder.ranks[0].perk);
ok(/hits on you 20% lighter, yours 20% heavier, forced out 75% less/.test(v.ladder.ranks[4].perk), '...Elder its whole gift', v.ladder.ranks[4].perk);
ok(/an animal 5/.test(v.ladder.earn) && /outside the walls 60/.test(v.ladder.earn), '...and how renown is earned', v.ladder.earn);
ok(row(v, 'Pack') && row(v, 'Pack').value === 'Lone Wolf' && /no pack and hunt alone/.test(row(v, 'Pack').hint) && /invitation/.test(row(v, 'Pack').hint), 'no pack: a Lone Wolf, who hunts alone until a pack invites them (Nate 2026-09-30)', row(v, 'Pack'));
ok(row(v, 'Beast form today') && row(v, 'Beast form today').value === '0 of 1 used', 'no change used today', row(v, 'Beast form today'));
curse(WOLF, { kind: 'werewolf', beastDay: 10, beastDayUses: 1 });
v = globalThis.__dboSuperProgress(WOLF);
// 0.75 game days to the turn at time scale 6 is 180 real minutes
ok(row(v, 'Beast form today').value === '1 of 1 used' && /stirs again when the day turns, in about 3 hours/.test(row(v, 'Beast form today').hint), "today's change used, and when the next comes", row(v, 'Beast form today'));
curse(WOLF, { kind: 'werewolf', beastDay: 9, beastDayUses: 1 });
ok(globalThis.__dboSuperProgress(WOLF).rows.some((r) => r.value === '0 of 1 used'), "yesterday's change does not count today");
ok(!row(v, 'In the beast'), 'no beast line while in their own shape');
ok(row(v, 'The beast within').value === 'Quiet' && /rarely breaks free/.test(row(v, 'The beast within').hint), 'fed, the beast is quiet', row(v, 'The beast within'));
hunger = 50; v = globalThis.__dboSuperProgress(WOLF);
ok(row(v, 'The beast within').value === 'Restless', 'hungry, restless', row(v, 'The beast within'));
hunger = 90; v = globalThis.__dboSuperProgress(WOLF);
ok(row(v, 'The beast within').value === 'Straining' && /most under a full moon/.test(row(v, 'The beast within').hint), 'starving, straining; the full moon is named', row(v, 'The beast within'));
globalThis.__dboClock.isFullMoon = () => true; v = globalThis.__dboSuperProgress(WOLF); globalThis.__dboClock.isFullMoon = () => false;
ok(/the moon is full/.test(row(v, 'The beast within').hint), '...and said when it is full now', row(v, 'The beast within'));
// Nate, 4 Oct: silver and poison 25% each, in beast form only
ok(row(v, 'Silver') && /In beast form silver strikes you 25% harder/.test(row(v, 'Silver').hint), 'silver burns the beast', row(v, 'Silver'));
ok(row(v, 'Poison') && /25% harder/.test(row(v, 'Poison').hint), 'and so does poison', row(v, 'Poison'));
store.set(`${WOLF}|private.beast`, { form: 'werewolf', until: now + 42000 });
v = globalThis.__dboSuperProgress(WOLF);
ok(row(v, 'In the beast') && row(v, 'In the beast').value === '42 s left', 'in beast form: the time left', row(v, 'In the beast'));
store.delete(`${WOLF}|private.beast`);
ok(['Beast Form', 'Feeding', 'Howl of Terror', 'Totem of the Hunt'].every((n) => power(v, n) && power(v, n).have), 'the powers a werewolf has', v.powers);
ok(/30 s longer/.test(power(v, 'Feeding').note), '...a feed adds the rank\'s seconds', power(v, 'Feeding'));

// A pack's member, then its leader
globalThis.__dboGuildsOf = (a) => (a === WOLF ? [{ id: 'pack-of-the-jerall', name: "Hircine's Pack of the Jerall", title: 'Hunter', kind: 'pack' }, { id: 'fighters', name: 'Fighters Guild', title: 'Member', kind: 'guild' }] : []);
v = globalThis.__dboSuperProgress(WOLF);
ok(row(v, 'Pack').value === "Hircine's Pack of the Jerall, Hunter" && /takes the pack/.test(row(v, 'Pack').hint), 'a pack member sees their pack and rank, and not their other factions', row(v, 'Pack'));
globalThis.__dboGuildIsPackLeader = (a) => a === WOLF;
v = globalThis.__dboSuperProgress(WOLF);
ok(/pale coat/.test(row(v, 'Pack').hint), 'the Pack Leader is told of the pale coat', row(v, 'Pack'));
ok(row(v, 'Beast form') && row(v, 'Beast form').value === 'At will' && !row(v, 'Beast form today'), '...changes at will', v.rows);
ok(row(v, 'The beast within').value === 'Held', '...and the beast never takes them', row(v, 'The beast within'));
globalThis.__dboGuildIsPackLeader = () => false; globalThis.__dboGuildsOf = () => [];
curse(WOLF, { kind: 'werewolf', blessed: true });
ok(/Hircine's blessing/.test(row(globalThis.__dboSuperProgress(WOLF), 'Beast form').hint), "Hircine's blessing frees a werewolf the same way");
store.set(`${WOLF}|private.greatHunt`, { renown: 320, fedOn: {} });
v = globalThis.__dboSuperProgress(WOLF);
ok(v.epithet === 'Hunter of the Hunt' && v.ladder.rank === 2, 'renown 320 is a Hunter', v.epithet);

// A vampire, turned, two game days since they fed: stage 2
hunger = 0;
curse(VAMP, { kind: 'vampire', stage: 2, lastFed: 8.75 });
store.set(`${VAMP}|private.bloodRanks`, { blood: 150, fedOn: {} });
v = globalThis.__dboSuperProgress(VAMP);
ok(v && v.kind === 'vampire' && v.label === 'Vampire' && v.group === 'The Blood', 'a vampire gets the Vampire tab', v);
ok(v.epithet === 'Vampire', 'titled by their blood rank', v.epithet);
ok(v.ladder && v.ladder.unit === 'blood' && v.ladder.value === 150 && v.ladder.rank === 1 && v.ladder.ranks[4].name === 'Master Vampire', 'the ladder: 150 blood, the second rank', v.ladder);
ok(v.ladder.ranks[0].perk === 'the blood gives nothing yet' && /10% heavier at night, the sun 40% weaker, thirst 40% slower/.test(v.ladder.ranks[4].perk), '...each rank says what it gives', v.ladder.ranks.map((r) => r.perk));
ok(/a living person, bound or willing, 20/.test(v.ladder.earn), '...and how blood is earned (willing people too, 2026-09-30)', v.ladder.earn);
// Fed 1.5 game days ago (360 real minutes); stage 3 at 2 days after at rank 1's rate 0.9 (2 / 0.9 = 2.22 days): 0.72 days, 174 minutes
const thirst = row(v, 'Thirst');
ok(thirst && thirst.value === 'Stage 2 of 4', 'thirst: stage 2 of 4', thirst);
ok(/last fed 6 hours ago/.test(thirst.hint) && /Stage 3 comes in about 3 hours unless you feed/.test(thirst.hint), '...when they last fed, and when it grows', thirst.hint);
ok(row(v, 'The sun').value === '0% shielded', 'the sun: nothing worn, nothing shielded', row(v, 'The sun'));
ok(row(v, 'Fire').value === '50% worse', 'fire: 25% a stage', row(v, 'Fire'));
ok(row(v, 'Bloodline').value === 'Turned', 'turned, not pure', row(v, 'Bloodline'));
ok(row(v, 'The Blood Crown').value === 'Unclaimed' && /next vampire made a pure-blood/.test(row(v, 'The Blood Crown').hint), 'the Crown lies unclaimed', row(v, 'The Blood Crown'));
ok(power(v, "Vampire's Seduction").have && !power(v, 'Embrace of Shadows').have && power(v, 'Embrace of Shadows').note === 'At stage 4 of thirst', 'stage 2: Seduction yes, Embrace of Shadows at stage 4', v.powers);
ok(power(v, 'Vampire Lord') && !power(v, 'Vampire Lord').have && power(v, 'Vampire Lord').note === 'Hold the Blood Crown', '...and no Vampire Lord without the Crown', power(v, 'Vampire Lord'));
ok(power(v, "Vampire's Servant") && !power(v, 'Raise Thrall'), 'powers go by their names in the game', v.powers.map((p) => p.name));

curse(VAMP, { kind: 'vampire', stage: 4, lastFed: 5, pure: true });
globalThis.__dboSuperState.crown = { holder: VAMP, name: 'V', since: now };
v = globalThis.__dboSuperProgress(VAMP);
ok(v.epithet === 'Vampire, pure-blood', 'a pure-blood is titled so', v.epithet);
ok(row(v, 'Thirst').value === 'Stage 4 of 4' && /can grow no worse/.test(row(v, 'Thirst').hint), 'stage 4 grows no worse', row(v, 'Thirst'));
ok(row(v, 'Fire').value === '50% worse', 'a pure-blood burns half as much', row(v, 'Fire'));
ok(row(v, 'The Blood Crown').value === 'Yours' && /Vampire Lord's form is yours/.test(row(v, 'The Blood Crown').hint), 'the holder sees the Crown is theirs', row(v, 'The Blood Crown'));
ok(power(v, 'Embrace of Shadows').have && power(v, 'Vampire Lord').have, '...with Embrace of Shadows and the Vampire Lord', v.powers);
globalThis.__dboSuperState.crown = { holder: 99, name: 'W', since: now };
ok(row(globalThis.__dboSuperProgress(VAMP), 'The Blood Crown').value === 'Held by another', "another's Crown is held by another, unnamed");
globalThis.__dboSuperState.crown = null;

// The first meal (Nate 2026-09-30: the first time they feed on a victim), through the real feeding
const V2 = 14, W2 = 15, BODY = 40, BODY2 = 41, BODY3 = 42, KILLER = 99;
globalThis.__dboSuperState.crown = { holder: KILLER, name: 'K', since: now }; // a pure-blood made below claims nothing (no file written)
const meal = (a) => row(globalThis.__dboSuperProgress(a), 'First meal');
const corpse = (id) => { store.set(`${id}|isDead`, true); globalThis.__dboSuperDeath(id, KILLER); };
// Feeding takes time (2026-09-30): the feeder and the body stand together, and the feed timer runs past a Fledgling's 12 s
for (const id of [V2, W2, BODY, BODY2, BODY3]) { store.set(`${id}|worldOrCellDesc`, 'tamriel'); store.set(`${id}|pos`, [0, 0, 0]); }
online = [V2, W2];
const drink = (body, who) => { const r = globalThis.__dboSuperActivate(body, who); for (let i = 0; i < 30; i++) { now += 500; if (timers.superFeed) timers.superFeed(); } return r; };
curse(V2, { kind: 'vampire', stage: 1, lastFed: day });
ok(meal(V2) && meal(V2).value === 'Not yet' && /bound captive/.test(meal(V2).hint), 'a new vampire has not had their first meal, and is told how', meal(V2));
corpse(BODY);
ok(drink(BODY, V2) === true, 'the vampire drinks from a fresh body');
ok(meal(V2).value === 'Taken' && meal(V2).hint === 'Your first meal was a moment ago, on a fresh body.', '...and that is their first meal', meal(V2));
const firstAt = store.get(`${V2}|private.supernatural`).firstMeal.at;
now += 3 * 86400000;
corpse(BODY2);
drink(BODY2, V2);
ok(store.get(`${V2}|private.supernatural`).firstMeal.at === firstAt && /3 days ago/.test(meal(V2).hint), 'a later meal leaves the first where it was', meal(V2));
cmds.curse(V2, 'me purevampire');
ok(meal(V2).value === 'Taken', "Molag Bal's Embrace on a vampire keeps the first meal: the curse goes on", meal(V2));
cmds.curse(V2, 'me cure');
ok(globalThis.__dboSuperProgress(V2) === null && !store.get(`${V2}|private.supernatural`).firstMeal, 'a cure ends it with the curse');
cmds.curse(V2, 'me vampire');
ok(meal(V2).value === 'Not yet', '...and the next curse starts without one', meal(V2));
curse(W2, { kind: 'werewolf' });
ok(meal(W2).value === 'Not yet' && /In the beast/.test(meal(W2).hint), 'a new werewolf has not fed, and is told how', meal(W2));
corpse(BODY3);
ok(globalThis.__dboSuperActivate(BODY3, W2) === false && meal(W2).value === 'Not yet', 'in their own shape a werewolf cannot feed', meal(W2));
store.set(`${W2}|private.beast`, { form: 'werewolf', until: now + 60000 });
ok(drink(BODY3, W2) === true && meal(W2).value === 'Taken' && /on a fresh body/.test(meal(W2).hint), 'in the beast they feed, and that is their first meal', meal(W2));
store.delete(`${W2}|private.beast`);
// Curses from before the first meal was kept: their ranks prove a feed
ok(meal(VAMP).value === 'Taken' && /before this was kept/.test(meal(VAMP).hint), 'an older vampire with blood has had theirs', meal(VAMP));
store.set(`${WOLF}|private.greatHunt`, { renown: 70, fedOn: { 5: now } });
ok(meal(WOLF).value === 'Taken', 'an older werewolf who fed on a player has had theirs', meal(WOLF));
store.set(`${WOLF}|private.greatHunt`, { renown: 12, fedOn: {} });
ok(meal(WOLF).value === 'Not yet', '...renown alone proves nothing (changes and kills earn it too)', meal(WOLF));
globalThis.__dboSuperState.crown = null;

// A broken view still answers, so the menu never waits on it
const real = globalThis.__dboSuperProgress;
globalThis.__dboSuperProgress = () => { throw new Error('boom'); };
packets.length = 0; globalThis.__dboSuperProgressSend(VAMP);
ok(packets.length === 1 && packets[0].p.progress === null, 'a view that throws sends null rather than nothing', packets);
globalThis.__dboSuperProgress = real;
globalThis.__dboSuperProgressSend(VAMP);
last = packets[packets.length - 1];
ok(last.p.progress && last.p.progress.kind === 'vampire', "the send carries the vampire's view", last);

// gamemode.js answers the skills menu's request with it
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
ok(/customPacketType === 'masteryInfoRequest'\) \{\s*const a = actorOf\(userId\); if \(a && typeof globalThis\.__dboSuperProgressSend === 'function'\) globalThis\.__dboSuperProgressSend\(a\);/.test(gm), 'gamemode.js sends the progress when K asks for the skills menu');

// The fever before the turning has its own tab (groundedpasta, #bugs "Lycanthropy", 1 Oct)
const CARRIER = 0xff00c0de, CARRIER2 = 0xff00c0df;
curse(CARRIER, { kind: null, disease: { kind: 'werewolf', since: 0, played: 1.5, by: '' } });
let f = globalThis.__dboSuperProgress(CARRIER);
ok(f && f.kind === 'fever-werewolf' && f.label === 'Sanies Lupinus' && f.group === 'The Fever' && f.epithet === 'Incubating', 'a werewolf carrier gets the Sanies Lupinus tab', f);
ok(row(f, 'The fever').value === '50% grown' && /only while you play: about 6 hours more\. Time away from the game does not count\./.test(row(f, 'The fever').hint), '...halfway grown, the play time left, and that time away does not count', row(f, 'The fever'));
ok(row(f, 'When it peaks').value === "Hircine's Hunt" && /Strike true 3 times in 5/.test(row(f, 'When it peaks').hint), "...Hircine's Hunt and what it takes", row(f, 'When it peaks'));
// What a loss does is what finishRite does for this client: no riteJudge (0.3.74) is judged by arrival and lives
ok(/Fail, and the fever breaks: you live, free of it\.$/.test(row(f, 'When it peaks').hint), '...a client timed across the network is told a loss breaks the fever and it lives', row(f, 'When it peaks').hint);
caps.add('riteJudge');
f = globalThis.__dboSuperProgress(CARRIER);
ok(/Fail, and the fever takes your life with it\.$/.test(row(f, 'When it peaks').hint), '...one that times its own strikes (riteJudge) is told a loss kills', row(f, 'When it peaks').hint);
caps.delete('riteJudge');
ok(/Divines or the older faiths.*Cure Disease potion.*Daedric Princes do not/.test(row(f, 'A cure').hint) && f.ladder === null && f.powers.length === 0, '...how it is cured; no ladder, no powers');
curse(CARRIER2, { kind: null, disease: { kind: 'vampire', since: 0, played: 3.2, by: '' } });
f = globalThis.__dboSuperProgress(CARRIER2);
ok(f && f.kind === 'fever-vampire' && f.label === 'Sanguinare Vampiris' && f.epithet === 'At its peak' && row(f, 'The fever').value === '100% grown'
  && row(f, 'When it peaks').value === 'The Blood Fever', 'a vampire carrier past the peak: Sanguinare Vampiris at its peak, The Blood Fever', f);
globalThis.__dboSuperProgressSend(CARRIER);
last = packets[packets.length - 1];
ok(last && last.a === CARRIER && last.p.progress && last.p.progress.kind === 'fever-werewolf', 'the panel packet carries the fever tab', last);
curse(CARRIER, { kind: null, disease: { kind: 'something', played: 1 } });
ok(globalThis.__dboSuperProgress(CARRIER) === null, 'an unknown disease shows nothing');

console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);
