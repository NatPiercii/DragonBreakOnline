// Scripted test for hiding players from each other while they make a character in the Realm (Nate, 4 Oct: "people
// spawning into other people and seeing them in the creation screen"). gamemode.js sets `invis` in the neighbour-visible
// ff_adminModes property of everyone in character creation; the client hides an actor with that flag (formView
// adminViewOf: alpha 0, no nametag; staff see a ghost). AdminSystem keeps the real admin modes per profile, so the flag
// is visual only, and only `invis` is ever written.
// Run it from this folder's parent with
//
//   node tests/creator-hide-harness.js
// With FORK=<fork client worktree> (run-all passes it) it also reads the client source the flag relies on.
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const root = path.resolve(__dirname, '..');
const gm = fs.readFileSync(path.join(root, 'gamemode.js'), 'utf8');
const a0 = gm.indexOf('// Nobody making a character sees anyone else doing it');
const b0 = gm.indexOf('// The move never beats the starter kit', a0);
if (a0 < 0 || b0 < 0) { console.log('FAIL the creator hide markers are gone from gamemode.js'); process.exit(1); }

const HUB_DESC = '17482:DragonBreak Hub.esp';
const WORLD = 'a764b:BSHeartland.esm';
// The stub world: where each actor is, whether it is still being made, its mirrored admin modes
const world = new Map(), pending = new Set(), modes = new Map(), writes = [];
let online = [];
const gone = new Set();
const mp = {
  get: (a, k) => {
    if (gone.has(a)) throw new Error('no such actor');
    if (k === 'worldOrCellDesc') return world.get(a);
    if (k === 'ff_adminModes') return modes.has(a) ? modes.get(a) : undefined;
    return undefined;
  },
  set: (a, k, v) => { if (gone.has(a)) throw new Error('no such actor'); if (k === 'ff_adminModes') { writes.push([a, v]); modes.set(a, v); } },
};
const inHub = (a) => { try { return String(mp.get(a, 'worldOrCellDesc') || '').toLowerCase() === HUB_DESC.toLowerCase(); } catch (e) { return false; } };
const timers = {};
const logs = [];
const load = (creation) => new Function('mp', 'inHub', 'creationPending', 'creation', 'every', 'onlineActors', 'log', 'globalThis',
  gm.slice(a0, b0) + '\nreturn { setCreatorHidden, inCreatorRealm, creatorHidden };')(
  mp, inHub, (a) => pending.has(a), creation, (n, ms, fn) => { timers[n] = { ms, fn }; }, () => online, (...x) => logs.push(x.join(' ')), globalThis);

delete globalThis.__dboCreatorHidden;
const creation = new Map();
let H = load(creation);
check('one sweep, every second, under one name (a reload replaces it)', timers.creatorHide && timers.creatorHide.ms === 1000);
const sweep = () => timers.creatorHide.fn();
const MAKER = 1, MAKER2 = 2, PLAYER = 3, STAFF = 4, GODPICK = 5;
const join = (a, w, isPending) => { online.push(a); world.set(a, w); if (isPending) { pending.add(a); creation.set(a, 'open'); } };
join(MAKER, HUB_DESC, true); join(MAKER2, HUB_DESC, true); join(PLAYER, WORLD, false);
sweep();
check('both players making a character are hidden', modes.get(MAKER) && modes.get(MAKER).invis === true && modes.get(MAKER2).invis === true, [modes.get(MAKER), modes.get(MAKER2)]);
check('a player in the world is not touched', !modes.has(PLAYER) && !writes.some(([a]) => a === PLAYER));
const n0 = writes.length;
sweep(); sweep();
check('the sweep writes nothing more while the flag is already on', writes.length === n0, writes.length - n0);

// AdminSystem rewrites the whole mirror at each login (resyncModes) and each toggle: the next sweep puts invis back
modes.set(MAKER, { god: false, smite: false, healhit: false, invis: false, ghost: false });
sweep();
check('a mirror rewritten by AdminSystem (a reconnect) is hidden again on the next sweep', modes.get(MAKER).invis === true
  && modes.get(MAKER).god === false && Object.keys(modes.get(MAKER)).length === 5, modes.get(MAKER));

// A finished character choosing a god (still in the hub, creation entry kept) stays hidden; once sent out, shown at once
pending.delete(MAKER);
sweep();
check('a finished character still in the Realm (the god picker, the naming hold) stays hidden', modes.get(MAKER).invis === true && H.inCreatorRealm(MAKER));
world.set(MAKER, WORLD); creation.delete(MAKER);
H.setCreatorHidden(MAKER, false);
check('leaving the Realm (sendToArrival, leftRealm) shows them again at once, the other modes kept', modes.get(MAKER).invis === false
  && Object.keys(modes.get(MAKER)).length === 5 && !H.creatorHidden.has(MAKER), modes.get(MAKER));
const n1 = writes.length;
sweep();
check('...and the sweep leaves a player in the world alone after that', writes.length === n1 && modes.get(MAKER).invis === false);

// The sweep alone also shows someone who left without passing sendToArrival (a staff teleport)
world.set(MAKER2, WORLD); creation.delete(MAKER2); pending.delete(MAKER2);
sweep();
check('someone moved out of the Realm another way is shown by the next sweep', modes.get(MAKER2).invis === false && !H.creatorHidden.has(MAKER2), modes.get(MAKER2));

// Staff who already had Invisible (or Ghost) on keep their own modes, before and after
join(STAFF, HUB_DESC, true);
modes.set(STAFF, { god: true, smite: false, healhit: false, invis: true, ghost: false });
const n2 = writes.length;
sweep();
check('a staff member already invisible is not written to while making a character', writes.length === n2 && modes.get(STAFF).god === true);
world.set(STAFF, WORLD); creation.delete(STAFF); pending.delete(STAFF);
H.setCreatorHidden(STAFF, false);
check('...and stays invisible after leaving the Realm (their own mode, not ours)', modes.get(STAFF).invis === true && modes.get(STAFF).god === true, modes.get(STAFF));
const GHOSTSTAFF = 6;
join(GHOSTSTAFF, HUB_DESC, true);
modes.set(GHOSTSTAFF, { god: false, smite: false, healhit: false, invis: false, ghost: true });
sweep();
check('a Ghost staff member is hidden with Ghost kept', modes.get(GHOSTSTAFF).invis === true && modes.get(GHOSTSTAFF).ghost === true);
world.set(GHOSTSTAFF, WORLD); creation.delete(GHOSTSTAFF); pending.delete(GHOSTSTAFF);
sweep();
check('...and shown again with Ghost still on', modes.get(GHOSTSTAFF).invis === false && modes.get(GHOSTSTAFF).ghost === true, modes.get(GHOSTSTAFF));

// A player in the hub who is not making a character (staff visiting the Realm) is not hidden
const VISITOR = 7;
join(VISITOR, HUB_DESC, false);
sweep();
check('someone in the Realm who is not making a character is not hidden', !modes.has(VISITOR));

// A disconnect mid-creation: the entry goes (AdminSystem clears the stale mirror at the next login); a gone actor never throws
join(GODPICK, HUB_DESC, true);
sweep();
check('a new arrival is hidden', modes.get(GODPICK).invis === true && H.creatorHidden.has(GODPICK));
online = online.filter((a) => a !== GODPICK);
sweep();
check('an offline player\'s entry is dropped by the sweep', !H.creatorHidden.has(GODPICK));
online.push(GODPICK);
gone.add(GODPICK);
let threw = false;
try { sweep(); H.setCreatorHidden(GODPICK, true); H.setCreatorHidden(GODPICK, false); } catch (e) { threw = true; }
check('a deleted character in the online list throws nothing', !threw);
gone.delete(GODPICK); online = online.filter((a) => a !== GODPICK);

// A reload keeps the same Map (no actor is forgotten half-hidden) and replaces the sweep
const before = H.creatorHidden;
join(8, HUB_DESC, true);
sweep();
H = load(creation);
check('a hot reload reuses the hidden list', H.creatorHidden === before && H.creatorHidden.has(8));
world.set(8, WORLD); creation.delete(8); pending.delete(8);
timers.creatorHide.fn();
check('...and the new sweep shows someone the old code hid', modes.get(8).invis === false && !H.creatorHidden.has(8));

// ---- the wiring in gamemode.js ----
const arrived = gm.slice(gm.indexOf("onUi('arrived'"), gm.indexOf("onUi('arrived'") + 1400);
check('arriving in the hub while creating hides at once, before the spot move',
  /if \(world === worldIdOf\(HUB\.cellOrWorldDesc\)\) setCreatorHidden\(a, true\);/.test(arrived)
  && arrived.indexOf('setCreatorHidden(a, true)') < arrived.indexOf('placeInCreatorSpot(a)'));
const ready = gm.slice(gm.indexOf('const onCharacterReady = '), gm.indexOf('const onCharacterReady = ') + 1600);
check('a new character spawning in the hub is hidden from the first moment', /creation\.set\(a, 'spawning'\); setFade\(a, true\); if \(inHub\(a\)\) setCreatorHidden\(a, true\);/.test(ready));
const toArrival = gm.slice(gm.indexOf('const sendToArrival = '), gm.indexOf('const sendToArrival = ') + 1400);
check('sendToArrival shows them again right after the move out', /mp\.set\(a, 'locationalData', arrivalLocFor\(a\)\);[\s\S]{0,120}setCreatorHidden\(a, false\);/.test(toArrival));
const lr = gm.slice(gm.indexOf('const leftRealm = '), gm.indexOf('const sendToArrival = '));
check('leftRealm (a staff teleport out) shows them again', /setCreatorHidden\(a, false\);/.test(lr));
check('nothing else in the gamemode writes ff_adminModes', (gm.match(/'ff_adminModes', /g) || []).length === 3, (gm.match(/'ff_adminModes', /g) || []).length);
check('the property is registered neighbour-visible', /makeProp\('ff_adminModes', true\)/.test(gm));
check('the creator spots never include the marker everyone spawns on', /const CREATOR_SPOTS = \[\]\.concat\(/.test(gm));

// ---- the client and AdminSystem it relies on, when run-all hands us the fork ----
const read = (base, rel) => { try { return base ? fs.readFileSync(path.join(base, rel), 'utf8') : null; } catch (e) { return null; } };
const formView = read(process.env.FORK, 'skymp5-client/src/view/formView.ts');
if (!formView) console.log('skip  client source checks (no FORK with skymp5-client/src/view/formView.ts)');
else {
  const view = formView.slice(formView.indexOf('private static adminViewOf('), formView.indexOf('private static adminViewOf(') + 500);
  check('client: an actor whose ff_adminModes has invis is "hidden" to players and a ghost to staff',
    /if \(m\["invis"\]\) return FormView\.viewerIsAdmin\(\) \? "ghost" : "hidden";/.test(view), view.slice(0, 300));
  check('client: hidden is drawn at alpha 0', /actor\.setAlpha\(view === "hidden" \? 0 :/.test(formView));
  check('client: the nametag is not drawn over a hidden actor', /adminViewOf\(model\) !== "hidden"|adminViewOf\(model\) === "hidden"/.test(formView));
}
const admin = read(process.env.FORK_SERVER || process.env.FORK, 'skymp5-server/ts/systems/adminSystem.ts');
if (!admin) console.log('skip  AdminSystem source checks (no FORK_SERVER with adminSystem.ts)');
else {
  const hook = admin.slice(admin.indexOf('private installGodModeHook('), admin.indexOf('private installGodModeHook(') + 2500);
  check('AdminSystem judges modes from its own per-profile state, never from the mirror',
    !/get\([^)]*"ff_adminModes"\)/.test(hook) && /modesByProfile/.test(admin));
  check('AdminSystem writes the mirror only in writeModeMirror (a toggle, a login resync)', (admin.match(/"ff_adminModes", /g) || []).length === 1);
}

delete globalThis.__dboCreatorHidden;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
