// The skills menu's Werewolf and Vampire tab, front half (skymp5-front masteryMenu, Nate 2026-09-30): renders the real
// widget with React's static renderer for the progress the real supernatural.js sends (tests/super-progress-harness.js
// covers the gameplay half), and checks the client's masteryService mirrors it, the middle of the packet's three hops.
// run-all bundles the widget from $FORK; by hand:
//
//   FORK=<fork> node tests/supernatural-tab-harness.js <bundle of skymp5-front/src/features/masteryMenu/index.tsx>
//
// A front from before the tab (client-final up to 3350d7b7) has nothing to test, which is said and not failed: the
// gameplay side works without it, and players keep /hunt and /blood until the next client pack.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/supernatural-tab-harness.js <bundle>'); process.exit(2); }
if (!/mastery__curse/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('supernatural-tab', 'this front has no Werewolf and Vampire tab');
  console.log('ok   skipped: this front predates the Werewolf and Vampire tab');
  process.exit(0);
}
const { Widget, CurseStage, CurseRanks, renderToStaticMarkup, createElement } = require(bundle);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ---- the payloads, from the real gameplay modules against a stub api ----
const store = new Map();
const noop = () => {};
const now = Date.UTC(2026, 8, 30, 12, 0);
Date.now = () => now;
globalThis.__dboClock = { gameDays: () => 10.25, summary: () => ({ timeScale: 6 }), isNight: () => false, isFullMoon: () => false };
globalThis.__dboSuperState = { crown: null, revoke: [] };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`), set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
const api = {
  mp, log: noop, audit: noop, personal: noop, system: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
  sendPacket: noop, display: String, who: String, isAdmin: () => false, findByName: () => null, onlineActors: () => [], every: noop,
  profileOf: (a) => a, nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 50, zoneOfActor: () => null, zoneById: () => null, cfg: {},
};
for (const f of ['greathunt.js', 'bloodranks.js', 'supernatural.js']) require(path.resolve(__dirname, '..', f))(api);
const WOLF = 11, VAMP = 12;
store.set(`${WOLF}|private.supernatural`, { kind: 'werewolf', beastDay: 10, beastDayUses: 1 });
store.set(`${WOLF}|private.greatHunt`, { renown: 130, fedOn: {} });
store.set(`${VAMP}|private.supernatural`, { kind: 'vampire', stage: 2, lastFed: 8.75, pure: false });
store.set(`${VAMP}|private.bloodRanks`, { blood: 20, fedOn: {} });
const wolf = globalThis.__dboSuperProgress(WOLF);
const vamp = globalThis.__dboSuperProgress(VAMP);

// ---- the skills menu, as masterySystem sends it ----
const EVENTS = { choose: 'mastery:choose', drop: 'mastery:drop', lock: 'mastery:lock', takeUp: 'mastery:takeUp', close: 'mastery:close' };
const menu = (over) => Object.assign({
  id: 25, events: EVENTS, profession: null, rank: 0, hours: 0, rankHours: [], professions: [],
  maxChosen: 3, tierNames: ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'], tierHours: [0, 10, 30, 70, 150],
  categories: [{ id: 'craft', label: 'Crafts' }],
  skills: [{ id: 'smithing', category: 'craft', label: 'Smithing', title: 'The Smith', description: 'Metal and fire.', tiers: ['a', 'b', 'c', 'd', 'e'], openable: 'station', hint: 'a forge' }],
  chosen: [], respec: { open: false, free: true, cost: 0, count: 0 },
  points: { enabled: true, pool: 300, used: 30, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 1, held: [{ id: 'smithing', level: 30, xp: 10, tier: 1, lock: 'raise' }], offers: [] },
}, over);
const render = (data) => text(renderToStaticMarkup(createElement(Widget, { data })));

let t = render(menu({}));
check('an older gameplay sends nothing: the skills menu is as it was', /Smithing/.test(t) && !/The Beast|The Blood|Werewolf|Vampire/.test(t), t);
t = render(menu({ supernatural: null }));
check('a player with no curse (null) sees no tab', /Smithing/.test(t) && !/Werewolf|Vampire/.test(t), t);
t = render(menu({ supernatural: wolf }));
check('a werewolf sees The Beast in the list, with Werewolf and their rank', /The Beast Werewolf Prowler/.test(t), t);
check('...and the menu still opens on their skill', /The Smith/.test(t) && !/Hircine's blood/.test(t), t);
t = render(menu({ supernatural: vamp }));
check('a vampire sees The Blood in the list, with Vampire and their rank', /The Blood Vampire Fledgling/.test(t), t);

// ---- the tab itself ----
t = text(renderToStaticMarkup(createElement(CurseStage, { curse: wolf })));
check("the werewolf's tab: its title and creed", /Prowler of the Hunt/.test(t) && /Hircine's blood runs in you/.test(t), t);
check('...where they stand: 130 renown, Prowler, 170 more to Hunter', /130 renown Prowler/.test(t) && /170 more renown to Hunter\./.test(t), t);
check('...how renown is earned', /an animal 5/.test(t), t);
check('...each fact with its hint', /Pack Lone Wolf You belong to no pack and hunt alone\. A pack takes you in only by invitation\./.test(t) && /Beast form today 1 of 1 used The beast stirs again/.test(t) && /The beast within Restless/.test(t), t);
check('...and the powers', /Powers Beast Form Become the werewolf/.test(t) && /Howl of Terror/.test(t), t);
const bar = renderToStaticMarkup(createElement(CurseStage, { curse: wolf })).match(/mastery__level-bar"><i style="width:([\d.]+)%/);
check('the bar is 15% of the way from Prowler (100) to Hunter (300)', !!bar && Math.abs(Number(bar[1]) - 15) < 0.01, bar && bar[1]);
t = text(renderToStaticMarkup(createElement(CurseRanks, { ladder: wolf.ladder })));
check('the ladder: five ranks, from the start to 1500 renown', /Fledgling .* from the start/.test(t) && /Prowler .* 100 renown/.test(t) && /Elder .* 1500 renown/.test(t), t);
const reached = (renderToStaticMarkup(createElement(CurseRanks, { ladder: wolf.ladder })).match(/mastery__rank--reached/g) || []).length;
check('...Fledgling and Prowler reached, the rest not', reached === 2, reached);

t = text(renderToStaticMarkup(createElement(CurseStage, { curse: vamp })));
check("the vampire's tab: title, thirst and its hint", /^ ?Fledgling /.test(t) && /Thirst Stage 2 of 4 You last fed 6 hours ago\./.test(t), t);
check('...80 more blood to Vampire', /20 blood Fledgling/.test(t) && /80 more blood to Vampire\./.test(t), t);
const html = renderToStaticMarkup(createElement(CurseStage, { curse: vamp }));
check('...a power not yet had is dim, with what brings it', /mastery__curse-power"><span class="mastery__curse-power-name">Embrace of Shadows<\/span><span class="mastery__curse-power-note">At stage 4 of thirst/.test(html), html.slice(html.indexOf('Embrace') - 120, html.indexOf('Embrace') + 120));
check('...one had is not', /mastery__curse-power mastery__curse-power--have"><span class="mastery__curse-power-name">Vampire&#x27;s Seduction/.test(html));
const top = Object.assign({}, vamp, { ladder: Object.assign({}, vamp.ladder, { value: 1600, rank: 4 }) });
t = text(renderToStaticMarkup(createElement(CurseStage, { curse: top })));
check('at the top rank it says none stands higher', /No rank of The Blood stands higher\./.test(t), t);
t = text(renderToStaticMarkup(createElement(CurseRanks, { ladder: null })));
check('without a ladder (greathunt.js not loaded) the ranks column is empty, not broken', t.trim() === '', t);

// ---- the client mirror: the middle hop ----
const svc = path.join(process.env.FORK || path.resolve(__dirname, '..', '..', 'fork'), 'skymp5-client/src/services/services/masteryService.ts');
const src = fs.existsSync(svc) ? fs.readFileSync(svc, 'utf8') : '';
check('the client keeps dboSuperProgress without opening the menu on it', /case "dboSuperProgress":\s*info\.supernatural = content\["progress"\] \?\? null;\s*if \(this\.menuOpen\) this\.openMenu\(\);/.test(src), svc);
check('...a skills refresh keeps it', /supernatural: info\.supernatural,\s*\};/.test(src));
check('...and the widget setter passes it to the front', /points: info\.points,\s*supernatural: info\.supernatural,\s*events: events,/.test(src));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
