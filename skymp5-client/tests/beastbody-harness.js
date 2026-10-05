// Scripted test for the werewolf body shown by the client itself (sync/beastBody.ts, 0.3.77). The server keeps a
// werewolf's mortal race in the appearance every client gets, and lists the beast bodies (dboBeastBody) only to a client
// whose UI announced 'beastBody'. Every watcher crash near a shown beast body (30 Sep howls, 28/29 Sep Vampire Lords)
// followed a relayed cast or stop whose humanoid caster variables SkyrimPlatform wrote into the beast copy's graph, so
// a listed copy is guarded by its listing as well as by its engine race, and a beast caster sends no variables at all.
// beastBody.ts and beastRaceIds.ts transpile on their own; the call sites are checked in the source. From skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/sync/beastRaceIds.ts src/sync/beastBody.ts --outDir /dev/shm/claude-nate-beastbody --module commonjs --target es2019
//   node tests/beastbody-harness.js /dev/shm/claude-nate-beastbody
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(process.argv[2] || '/dev/shm/claude-nate-beastbody');
const { setBeastBodies, beastBodyOf, parseBeastBodies, beastBodyAppearance } = require(path.join(OUT, 'beastBody.js'));
const { casterVariablesFor } = require(path.join(OUT, 'beastRaceIds.js'));
const SRC = path.resolve(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const WEREWOLF = 0x000cdd84, VAMPIRE_LORD = 0x0200283a, NORD = 0x00013746, DRAUGR = 0x00000d53;
const WOLF = 0xff000010, LORD = 0xff000020, OTHER = 0xff000030;
const snap0 = () => ({ booleans: new Uint8Array(4), floats: new Uint8Array(8), integers: new Uint8Array(8) });

// ---- the list ------------------------------------------------------------------------------------------------------
setBeastBodies([{ id: WOLF, race: WEREWOLF }, { id: LORD, race: VAMPIRE_LORD }]);
check('a listed werewolf is shown in its body', beastBodyOf(WOLF) === WEREWOLF);
check('a listed Vampire Lord too', beastBodyOf(LORD) === VAMPIRE_LORD);
check('anyone else keeps the appearance the server sent', beastBodyOf(OTHER) === 0 && beastBodyOf(undefined) === 0 && beastBodyOf(null) === 0);
check('a signed id is the same player', beastBodyOf(WOLF | 0) === WEREWOLF);
setBeastBodies([{ id: LORD, race: VAMPIRE_LORD }]);
check('a new list replaces the old: a werewolf left out of it is mortal again', beastBodyOf(WOLF) === 0 && beastBodyOf(LORD) === VAMPIRE_LORD);
setBeastBodies([{ id: WOLF, race: NORD }, { id: OTHER, race: DRAUGR }, { id: 0, race: WEREWOLF }]);
check('only the two beast races are taken: a list cannot give a player any other race', beastBodyOf(WOLF) === 0 && beastBodyOf(OTHER) === 0);
setBeastBodies([]);
check('an empty list (a new connection) shows nobody as a beast', beastBodyOf(LORD) === 0);

// ---- a Vampire Lord the same way (Nate, 5 Oct: both bodies on) ---------------------------------------------------------
setBeastBodies([{ id: WOLF, race: WEREWOLF }, { id: LORD, race: VAMPIRE_LORD }]);
const lordLook = beastBodyAppearance({ raceId: NORD, headpartIds: [7], tints: [{}], options: [1], presets: [2], headTextureSetId: 3, name: 'Vampire Lord' }, beastBodyOf(LORD));
check('a listed Lord is built as DLC1VampireBeastRace with the bare look, named Vampire Lord', lordLook.raceId === VAMPIRE_LORD &&
  !lordLook.headpartIds.length && !lordLook.tints.length && lordLook.headTextureSetId === 0 && lordLook.name === 'Vampire Lord');
check('a listed Lord\'s copy gets no caster variables (Drain, Raise Dead, Corpse Curse, the Gargoyle summon)',
  casterVariablesFor(beastBodyOf(LORD), snap0()).floats.length === 0 && casterVariablesFor(VAMPIRE_LORD, snap0()).integers.length === 0);
check('the Lord race the list takes is the one the cast guard and the non-humanoid list name (Dawnguard 00283A at index 02)',
  /\["Dawnguard\.esm", 0x00283a, "DLC1VampireBeastRace"\]/.test(read('sync/nonHumanoidRaceList.ts')) && beastBodyOf(LORD) === 0x0200283a);
check('the summoned Gargoyle is guarded as a non-humanoid caster too', /\["Dawnguard\.esm", 0x00a2c6, "DLC1GargoyleRace"\]/.test(read('sync/nonHumanoidRaceList.ts')));
setBeastBodies([]);

// ---- the packet ----------------------------------------------------------------------------------------------------
const pkt = (bodies) => ({ customPacketType: 'dboBeastBody', bodies });
check('the packet\'s list is read', JSON.stringify(parseBeastBodies(pkt([{ id: WOLF, race: WEREWOLF }]))) === JSON.stringify([{ id: WOLF, race: WEREWOLF }]));
check('ids and races may come as strings or signed numbers', JSON.stringify(parseBeastBodies(pkt([{ id: String(WOLF), race: WEREWOLF | 0 }]))) === JSON.stringify([{ id: WOLF, race: WEREWOLF }]));
check('junk entries are dropped, not thrown on', JSON.stringify(parseBeastBodies(pkt([null, 5, 'x', { id: WOLF }, { race: WEREWOLF }, { id: OTHER, race: NORD }]))) === '[]');
check('another packet type, or no list, is not this packet', parseBeastBodies({ customPacketType: 'dboBeast', bodies: [] }) === null &&
  parseBeastBodies({ customPacketType: 'dboBeastBody' }) === null && parseBeastBodies(null) === null);

// ---- the look ------------------------------------------------------------------------------------------------------
const mortal = { isFemale: true, raceId: NORD, weight: 50, skinColor: 1, hairColor: 2, headpartIds: [1, 2, 3], headTextureSetId: 9,
  options: [0.5], presets: [1], tints: [{ argb: 1, type: 0, texturePath: 'x' }], name: 'Werewolf' };
const beast = beastBodyAppearance(mortal, WEREWOLF);
check('the beast look has the beast race and no mortal head (head parts on a beast body crashed watchers, 23 Sep)',
  beast.raceId === WEREWOLF && !beast.headpartIds.length && !beast.tints.length && !beast.options.length && !beast.presets.length && beast.headTextureSetId === 0);
check('...and keeps the name, sex and weight', beast.name === 'Werewolf' && beast.isFemale === true && beast.weight === 50);
check('the server\'s appearance object is left as it was', mortal.raceId === NORD && mortal.headpartIds.length === 3);

// ---- formView builds the listed body ---------------------------------------------------------------------------------
const fv = read('view/formView.ts');
const upd = fv.slice(fv.indexOf('  update(model: FormModel): void {'), fv.indexOf('    // Other players mutate into PC clones'));
check('formView.update swaps in the listed body before it reads the model', /const beastRace = beastBodyOf\(this\.remoteRefrId\);\s*if \(beastRace && model\.appearance\) model = this\.withBeastBody\(model, beastRace\);/.test(upd), upd);
check('a change of listing counts as an appearance change (it respawns the copy in the other race)',
  /model\.numAppearanceChanges !== this\.appearanceState\.lastNumChanges \|\|\s*beastRace !== this\.appearanceState\.beastRace/.test(fv) &&
  /this\.appearanceState\.beastRace = beastRace;/.test(fv));
check('one beast look per server appearance, not one a frame', /cache\.from !== model\.appearance \|\| cache\.race !== race/.test(fv));
check('the beast copy still settles for 1.5 s and hides its name tag (isBeastCopy reads the model\'s race)',
  /private isBeastCopy\(model: FormModel\): boolean \{\s*return !!model\.appearance && isBeastRaceId\(model\.appearance\.raceId\);/.test(fv));

check('a beast copy\'s relayed animations (a Lord\'s LevitateStart/LandStart) wait for the settle and are not marked applied meanwhile',
  /if \(refr\.is3DLoaded\(\) && !this\.isSettlingCopy\(model\) && !holdsRelayedRagdoll\(/.test(fv) && /private isSettlingBeast\(model: FormModel\): boolean \{\s*return this\.isBeastCopy\(model\)/.test(fv));
check('the Lord\'s animation diag reads the listed race (it runs in applyAll, on the swapped model)',
  /if \(model\.appearance && isVampireLordRace\(model\.appearance\.raceId\)\)/.test(fv) && /this\.applyAll\(refr, model\)/.test(fv));
const bfs = read('services/services/beastFormService.ts');
check('the Lord\'s own form is untouched: dboBeastBody returns before the dboBeast handling, which keeps the stance global',
  bfs.indexOf('if (bodies) { setBeastBodies(bodies); return; }') < bfs.indexOf('content["customPacketType"] !== "dboBeast"') && /this\.setVampireStance\(beast \? VL_STATE_LEVITATING : VL_STATE_NONE\)/.test(bfs));

// ---- the guard knows the listing -----------------------------------------------------------------------------------
const races = read('sync/beastRaces.ts');
check('guardedRaceOf takes the copy\'s remote id and answers the listed race first',
  /export const guardedRaceOf = \(ac: Actor \| null \| undefined, remoteId\?: number\): number => \{\s*resolveNonHumanoidRaces\(\);\s*const listed = beastBodyOf\(remoteId\);\s*if \(listed\) return listed;/.test(races));
setBeastBodies([{ id: WOLF, race: WEREWOLF }]);
const snap = { booleans: new Uint8Array(4), floats: new Uint8Array(8), integers: new Uint8Array(8) };
check('a listed werewolf\'s copy gets no caster variables even while the engine still reads it as a Nord',
  casterVariablesFor(beastBodyOf(WOLF) || NORD, snap).floats.length === 0);
const rs = read('services/services/remoteServer.ts');
const calls = rs.match(/guardedRaceOf\([^)]*\)/g) || [];
check('every guard call in remoteServer passes the remote id (cast, sweep, anim-variables update)', calls.length === 3 &&
  calls.includes('guardedRaceOf(ac, msg.data.caster)') && calls.includes('guardedRaceOf(ac, watch.casterRemoteId)') &&
  calls.includes('guardedRaceOf(ac, msg.data.actorRemoteId)'), calls);

// ---- a beast caster sends nothing to write --------------------------------------------------------------------------
const ms = read('services/services/magicSyncService.ts');
const conv = ms.slice(ms.indexOf('private getAnimationVariablesFromActorConverted('), ms.indexOf('private getUpdateAnimVariablesEventData('));
check('a guarded-race caster\'s snapshot is empty, read before getAnimationVariablesFromActor',
  /if \(guardedRaceOf\(Actor\.from\(Game\.getFormEx\(actorId\)\)\)\) \{\s*return \{ booleans: \[\] as number\[\], floats: \[\] as number\[\], integers: \[\] as number\[\] \};/.test(conv) &&
  conv.indexOf('guardedRaceOf(') < conv.indexOf('getAnimationVariablesFromActor(actorId)'));
check('every snapshot the relay sends goes through that function', (ms.match(/getAnimationVariablesFromActor\(/g) || []).length === 1);
check('a beast player sends no anim-variables updates at all', /if \(!ac \|\| guardedRaceOf\(ac\)\) \{\s*return;\s*\}\s*const animVariables = this\.getAnimationVariablesFromActorConverted/.test(ms));

// ---- the packet reaches the list, and the UI says the client can --------------------------------------------------
const bf = read('services/services/beastFormService.ts');
check('beastFormService hands dboBeastBody to the list', /const bodies = parseBeastBodies\(content\);\s*if \(bodies\) \{ setBeastBodies\(bodies\); return; \}/.test(bf));
check('...and forgets the list on a new connection', /"connectionAccepted", \(\) => \{[^}]*setBeastBodies\(\[\]\);/.test(bf));
const hud = fs.readFileSync(path.resolve(__dirname, '..', '..', 'skymp5-front', 'src', 'features', 'hud', 'index.tsx'), 'utf8');
check('the front announces the beastBody capability with the rest (dbo:uiCaps)', /const UI_CAPS = \[[^\]]*'beastBody'\];/.test(hud));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
