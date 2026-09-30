// Scripted test for the beast cast guard (2026-09-30: a werewolf's howls crashed three watchers). SkyrimPlatform's
// ApplyVariablesToActor writes a relayed caster's animation variables at the humanoid master graph's fixed indexes with
// no graph or bounds check, so a werewolf's or Vampire Lord's copy must get none. beastRaceIds.ts has no imports and
// transpiles on its own, with the throttle for the guard's skip lines; the call sites in remoteServer.ts, and the base
// writes that applyTints aliased to the player (formView.ts, inventory.ts), are checked in the source. Run it from
// skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/sync/beastRaceIds.ts --outDir /tmp/claude-nate-beastguard --module commonjs --target es2019
//   node tests/beastguard-harness.js /tmp/claude-nate-beastguard/beastRaceIds.js
'use strict';
const fs = require('fs');
const path = require('path');
const { BEAST_RACE_IDS, isBeastRaceId, casterVariablesFor, emptyCasterVariables, createBeastSkipLog, SKIP_LINE_INTERVAL_MS, SKIP_MAX_LINES } = require(path.resolve(process.argv[2] || '/tmp/claude-nate-beastguard/beastRaceIds.js'));
const SRC = path.resolve(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.relative(SRC, path.join(dir, e.name))] : []);
const allSrc = sourceFiles(SRC);

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

// ---- the skip lines: one per caster and kind per interval, and a session cap (Report a Problem sends the last 60 KB) ----
const LORD = 0xff000123, WOLF = 0xff000456;
const logWith = (maxLines) => {
  const out = { lines: [], t: 0 };
  out.note = createBeastSkipLog((l) => out.lines.push(l), () => out.t, SKIP_LINE_INTERVAL_MS, maxLines);
  return out;
};
const burst = logWith(SKIP_MAX_LINES);
for (let i = 0; i < 600; i++, burst.t += 500) {   // five minutes of a Vampire Lord's 500 ms updates, plus its casts
  burst.note(LORD, VAMPIRE_LORD, 'anim variables update');
  if (i % 6 === 0) burst.note(LORD, VAMPIRE_LORD, 'keep-alive', 0x0200d2f6);
  if (i % 20 === 0) burst.note(LORD, VAMPIRE_LORD, 'cast', 0x0200d2f6);
  if (i % 20 === 1) burst.note(LORD, VAMPIRE_LORD, 'stop', 0x0200d2f6);
  if (i % 4 === 0) burst.note(WOLF, WEREWOLF, 'anim variables update');
}
const count = (re) => burst.lines.filter((l) => re.test(l)).length;
check('a five-minute burst writes one line per caster and kind', burst.lines.length === 5 &&
  count(/ff000123 race 200283a anim variables update/) === 1 && count(/ff000123 race 200283a spell 200d2f6 keep-alive/) === 1 &&
  count(/ff000123 race 200283a spell 200d2f6 cast:/) === 1 && count(/ff000123 race 200283a spell 200d2f6 stop:/) === 1 &&
  count(/ff000456 race cdd84 anim variables update/) === 1, burst.lines);
check('a skip line keeps its format', burst.lines[0] === 'beast cast guard: ff000123 race 200283a anim variables update: caster variables not applied', burst.lines[0]);
burst.t = SKIP_LINE_INTERVAL_MS - 1;
check('a signed remote id is the same caster', !burst.note(LORD | 0, VAMPIRE_LORD, 'anim variables update'));
burst.t = SKIP_LINE_INTERVAL_MS;
check('after the interval the next line says how many it held back',
  burst.note(LORD, VAMPIRE_LORD, 'anim variables update') && / \(600 more since the last line\)$/.test(burst.lines[burst.lines.length - 1]), burst.lines[burst.lines.length - 1]);
const hour = logWith(SKIP_MAX_LINES);
for (; hour.t < 3600 * 1000; hour.t += 500) hour.note(LORD, VAMPIRE_LORD, 'anim variables update');
check('an hour of one Lord\'s updates is one line per interval', hour.lines.length === Math.ceil(3600 * 1000 / SKIP_LINE_INTERVAL_MS), hour.lines.length);
const capped = logWith(SKIP_MAX_LINES);
for (let id = 0; id < SKIP_MAX_LINES * 4; id++) capped.note(0xff000000 + id, WEREWOLF, 'cast', 0x0200d2f6);
const capLines = capped.lines.length;
capped.t += SKIP_LINE_INTERVAL_MS * 10;
for (let id = 0; id < SKIP_MAX_LINES * 4; id++) capped.note(0xff000000 + id, WEREWOLF, 'stop', 0x0200d2f6);
check('the session cap holds: SKIP_MAX_LINES lines and one closing line, then nothing', capLines === SKIP_MAX_LINES + 1 &&
  capped.lines.length === capLines && /stopped after \d+ lines this session$/.test(capped.lines[capLines - 1]), capped.lines.length);
const worst = 'beast cast guard: ffffffff race 200283a spell ffffffff anim variables update: caster variables not applied (4294967295 more since the last line)';
check('a whole session of skip lines is under 8 KB of the 60 KB Report a Problem sends', (SKIP_MAX_LINES + 1) * (worst.length + 2) < 8 * 1024,
  (SKIP_MAX_LINES + 1) * (worst.length + 2));

// ---- every place the client applies relayed variables is guarded ----------------------------------------------------
const rs = read('services/services/remoteServer.ts');
const castMsg = rs.slice(rs.indexOf('private onSpellCastMessage('), rs.indexOf('private stopCloneCast('));
check('onSpellCastMessage builds its variables through casterVariablesFor(beastRaceOf(ac), ...)',
  /const beastRace = beastRaceOf\(ac\);\s*const actorAnimationVariables: ActorAnimationVariables = casterVariablesFor\(beastRace, \{/.test(castMsg));
const guardAt = castMsg.indexOf('casterVariablesFor(beastRace');
check('...before both the stop and the cast use them', guardAt >= 0 && guardAt < castMsg.indexOf('this.stopCloneCast(ac') &&
  guardAt < castMsg.indexOf('castSpellImmediate('), guardAt);
check('...and notes each skip through the throttled noteBeastSkip', /if \(beastRace\) \{\s*noteBeastSkip\(msg\.data\.caster, beastRace, /.test(castMsg));
const sweep = rs.slice(rs.indexOf('private sweepCloneCasts('), rs.indexOf('private onUpdateAnimVariablesMessage('));
check('the sweep\'s stop of a stored clone is guarded too', /this\.stopCloneCast\(ac, watch\.casterRemoteId, watch\.castingSource, casterVariablesFor\(beastRaceOf\(ac\), watch\.animVars\)\)/.test(sweep));
const upd = rs.slice(rs.indexOf('private onUpdateAnimVariablesMessage('), rs.indexOf('private cloneCastWatch'));
check('a relayed anim-variables update is refused for a beast before applyAnimationVariablesToActor',
  upd.indexOf('beastRaceOf(ac)') > 0 && upd.indexOf('beastRaceOf(ac)') < upd.indexOf('applyAnimationVariablesToActor(') &&
  /if \(beastRace\) \{\s*noteBeastSkip\(msg\.data\.actorRemoteId, beastRace, "anim variables update"\);\s*return;/.test(upd));
const bareDiag = allSrc.filter((f) => f !== path.join('sync', 'beastRaces.ts') && /writeDiagLine\(/.test(read(f)));
check('no skip line bypasses the throttle (writeDiagLine is private to beastRaces.ts)', bareDiag.length === 0 &&
  !/export const writeDiagLine/.test(read('sync/beastRaces.ts')) && /export const noteBeastSkip = createBeastSkipLog\(writeDiagLine\)/.test(read('sync/beastRaces.ts')), bareDiag);
// the natives only: ac.interruptCast() is the Papyrus method, which carries no variables
const sites = (rs.match(/(?<![.\w])(castSpellImmediate|interruptCast|applyAnimationVariablesToActor)\(/g) || []).length;
check('no other call site applies relayed variables (castSpellImmediate, interruptCast, applyAnimationVariablesToActor)', sites === 3, sites);
const stopCalls = rs.match(/this\.stopCloneCast\([^;]*;/g) || [];
check('every stopCloneCast call passes guarded variables', stopCalls.length === 2 && stopCalls.every((c) => /actorAnimationVariables\)|casterVariablesFor\(/.test(c)), stopCalls);

// ---- writes through a remote copy's base (applyTints gave it the player's base id) --------------------------------
const fv = read('view/formView.ts');
check('formView\'s name-only update no longer renames through a copy\'s base', !/getBaseObject\(\)\??\.setName\(/.test(fv) && /refr\?\.setDisplayName\(model\.appearance\.name, true\)/.test(fv));
const baseRenames = allSrc.filter((f) => /getBaseObject\(\)[^;\n]*\.setName\(/.test(read(f)));
check('no client file calls setName on a base it got from a reference', allSrc.length > 100 && baseRenames.length === 0,
  { scanned: allSrc.length, baseRenames });
const inv = read('sync/inventory.ts');
check('inventory.ts never resets the player\'s base container through a copy', /const resetBase = [^]*?if \(baseIsPlayers\(refr\)\) \{\s*return;/.test(inv));
check('...nor reads it as the copy\'s base container', /const getBaseContainerAsInventory = [^]*?if \(baseIsPlayers\(refr\)\) \{\s*return \{ entries: \[\] \};/.test(inv));
check('appearance.ts explains the alias and exports baseIsPlayers', /export const baseIsPlayers = /.test(read('sync/appearance.ts')) && /reaches the LOCAL PLAYER's base/.test(read('sync/appearance.ts')));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
