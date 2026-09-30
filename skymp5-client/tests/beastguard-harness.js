// Scripted test for the beast cast guard (2026-09-30: a werewolf's howls crashed three watchers). SkyrimPlatform's
// ApplyVariablesToActor writes a relayed caster's animation variables at the humanoid master graph's fixed indexes with
// no graph or bounds check, so a werewolf's or Vampire Lord's copy must get none. beastRaceIds.ts has no imports and
// transpiles on its own; the call sites in remoteServer.ts, and the base writes that applyTints aliased to the player
// (formView.ts, inventory.ts), are checked in the source. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/sync/beastRaceIds.ts --outDir /tmp/claude-nate-beastguard --module commonjs --target es2019
//   node tests/beastguard-harness.js /tmp/claude-nate-beastguard/beastRaceIds.js
'use strict';
const fs = require('fs');
const path = require('path');
const { BEAST_RACE_IDS, isBeastRaceId, casterVariablesFor, emptyCasterVariables } = require(path.resolve(process.argv[2] || '/tmp/claude-nate-beastguard/beastRaceIds.js'));
const SRC = path.resolve(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// ---- the races ----------------------------------------------------------------------------------------------------
const WEREWOLF = 0x000cdd84, VAMPIRE_LORD = 0x0200283a, NORD = 0x00013746, DUNMER_VAMPIRE = 0x0008883d;
check('the werewolf race is a beast race', isBeastRaceId(WEREWOLF));
check('the Vampire Lord race is a beast race', isBeastRaceId(VAMPIRE_LORD));
check('a Nord is not, nor a vampire in mortal form (their graph is the humanoid one)', !isBeastRaceId(NORD) && !isBeastRaceId(DUNMER_VAMPIRE));
check('no race (0, null, undefined) is not', !isBeastRaceId(0) && !isBeastRaceId(null) && !isBeastRaceId(undefined));
check('a signed id is read as unsigned', isBeastRaceId(VAMPIRE_LORD | 0) && isBeastRaceId(-0) === false);
check('exactly the two beast races', BEAST_RACE_IDS.size === 2);

// ---- what a relayed cast or stop may write --------------------------------------------------------------------------
const snapshot = () => ({ booleans: new Uint8Array([1, 0, 1]), floats: new Uint8Array(76), integers: new Uint8Array(56) });
const empty = (v) => v.booleans.length === 0 && v.floats.length === 0 && v.integers.length === 0;
const human = snapshot();
check('a humanoid copy gets the caster\'s variables untouched', casterVariablesFor(NORD, human) === human);
check('a copy of no known race gets them too (the native checks nothing either way)', casterVariablesFor(0, human) === human);
check('a werewolf copy gets none at all (ApplyVariablesToActor returns before writing)', empty(casterVariablesFor(WEREWOLF, snapshot())));
check('a Vampire Lord copy gets none at all', empty(casterVariablesFor(VAMPIRE_LORD, snapshot())));
check('empty means empty Uint8Arrays, the type the native reads', ['booleans', 'floats', 'integers'].every((k) => emptyCasterVariables()[k] instanceof Uint8Array));

// ---- every place the client applies relayed variables is guarded ----------------------------------------------------
const rs = read('services/services/remoteServer.ts');
const castMsg = rs.slice(rs.indexOf('private onSpellCastMessage('), rs.indexOf('private stopCloneCast('));
check('onSpellCastMessage builds its variables through casterVariablesFor(beastRaceOf(ac), ...)',
  /const beastRace = beastRaceOf\(ac\);\s*const actorAnimationVariables: ActorAnimationVariables = casterVariablesFor\(beastRace, \{/.test(castMsg));
check('...before both the stop and the cast use them', castMsg.indexOf('casterVariablesFor(beastRace') < castMsg.indexOf('this.stopCloneCast(ac') &&
  castMsg.indexOf('casterVariablesFor(beastRace') < castMsg.indexOf('castSpellImmediate('));
check('...and writes one dbo-diag line per skip', /if \(beastRace\) \{\s*writeDiagLine\(`beast cast guard:/.test(castMsg));
const sweep = rs.slice(rs.indexOf('private sweepCloneCasts('), rs.indexOf('private onUpdateAnimVariablesMessage('));
check('the sweep\'s stop of a stored clone is guarded too', /this\.stopCloneCast\(ac, watch\.casterRemoteId, watch\.castingSource, casterVariablesFor\(beastRaceOf\(ac\), watch\.animVars\)\)/.test(sweep));
const upd = rs.slice(rs.indexOf('private onUpdateAnimVariablesMessage('), rs.indexOf('private cloneCastWatch'));
check('a relayed anim-variables update is refused for a beast before applyAnimationVariablesToActor',
  upd.indexOf('beastRaceOf(ac)') > 0 && upd.indexOf('beastRaceOf(ac)') < upd.indexOf('applyAnimationVariablesToActor(') && /writeDiagLine\(`beast cast guard:[^`]*anim variables update/.test(upd));
// the natives only: ac.interruptCast() is the Papyrus method, which carries no variables
const sites = (rs.match(/(?<![.\w])(castSpellImmediate|interruptCast|applyAnimationVariablesToActor)\(/g) || []).length;
check('no other call site applies relayed variables (castSpellImmediate, interruptCast, applyAnimationVariablesToActor)', sites === 3, sites);
const stopCalls = rs.match(/this\.stopCloneCast\([^;]*;/g) || [];
check('every stopCloneCast call passes guarded variables', stopCalls.length === 2 && stopCalls.every((c) => /actorAnimationVariables\)|casterVariablesFor\(/.test(c)), stopCalls);

// ---- writes through a remote copy's base (applyTints gave it the player's base id) --------------------------------
const fv = read('view/formView.ts');
check('formView\'s name-only update no longer renames through a copy\'s base', !/getBaseObject\(\)\??\.setName\(/.test(fv) && /refr\?\.setDisplayName\(model\.appearance\.name, true\)/.test(fv));
check('no client file calls setName on a base it got from a reference',
  !['view/formView.ts', 'services/services/remoteServer.ts', 'sync/inventory.ts', 'sync/appearance.ts'].some((f) => /getBaseObject\(\)[^;\n]*\.setName\(/.test(read(f))));
const inv = read('sync/inventory.ts');
check('inventory.ts never resets the player\'s base container through a copy', /const resetBase = [^]*?if \(baseIsPlayers\(refr\)\) \{\s*return;/.test(inv));
check('...nor reads it as the copy\'s base container', /const getBaseContainerAsInventory = [^]*?if \(baseIsPlayers\(refr\)\) \{\s*return \{ entries: \[\] \};/.test(inv));
check('appearance.ts explains the alias and exports baseIsPlayers', /export const baseIsPlayers = /.test(read('sync/appearance.ts')) && /reaches the LOCAL PLAYER's base/.test(read('sync/appearance.ts')));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
