// Scripted test for the client's part of the Character Journal (2026-09-30):
//   - idleControl.ts: a dboIdle with hold: true lasts until its dboIdleStop (the journal's page-turn while it is open),
//     bounded at 10 minutes; any other is held 1-10 s as before; a stop ends only the idle the server began;
//   - EmoteService wires them: dboIdleStop, the hold, and the wheel's own choice never being the server's idle;
//   - autoMoveClear.ts counts the journal with the mini-games, so an auto-running player stops when it takes the keyboard.
// Both modules have no imports and are transpiled here with the client's TypeScript. Run it from skymp5-client:
//
//   node tests/journalclient-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));
const load = (file) => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', file), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', js)(m, m.exports);
  return m.exports;
};
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- idleControl ----
const ic = load('idleControl.ts');
check('an ordinary idle is held the seconds asked, 1 to 10', ic.idleRequest({ seconds: 4 }).seconds === 4 && ic.idleRequest({ seconds: 99 }).seconds === 10 && ic.idleRequest({ seconds: 0.2 }).seconds === 1);
check('...3 s when none is given, and never held', ic.idleRequest({}).seconds === 3 && ic.idleRequest({ seconds: 'x' }).hold === false);
check('hold: true lasts until its stop, bounded at 10 minutes', ic.idleRequest({ seconds: 10, hold: true }).hold === true && ic.idleRequest({ seconds: 10, hold: true }).seconds === 600);
check('only a real true holds', ic.idleRequest({ hold: 'true' }).hold === false && ic.idleRequest({ hold: 1 }).hold === false);
const PT = 'IdleBook_PageTurn';
check('a stop ends the idle the server began', ic.stopsIdle(PT, PT, undefined) === true && ic.stopsIdle(PT, PT, PT) === true && ic.stopsIdle(PT, PT, '') === true);
check('...not one the player chose since (same clip or another)', ic.stopsIdle(PT, '', undefined) === false && ic.stopsIdle('IdleLute', PT, undefined) === false);
check('...not a different idle than the one named', ic.stopsIdle(PT, PT, 'IdleGive') === false);
check('...and nothing when nothing plays', ic.stopsIdle('', PT, undefined) === false && ic.stopsIdle('', '', undefined) === false);

// ---- EmoteService wiring ----
const es = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'emoteService.ts'), 'utf8');
const packet = es.slice(es.indexOf('private onCustomPacketMessage'), es.indexOf('public playActionIdle'));
check('dboIdleStop ends the server\'s idle gracefully, and only when stopsIdle says so',
  /content\["customPacketType"\] === "dboIdleStop"/.test(packet) && /if \(stopsIdle\(this\.activeEmote, this\.serverIdle, content\["anim"\]\)\) \{\s*this\.serverIdle = "";\s*this\.stopActiveEmote\(true\);/.test(packet));
check('dboIdle passes the hold on and marks the idle as the server\'s',
  /this\.playActionIdle\(anim, req\.seconds, content\["endsItself"\] === true, req\.hold, true\);/.test(packet));
check('...but a held idle never replaces the player\'s own emote (a seat, a lute)',
  /if \(req\.hold && this\.activeEmote && this\.activeEmote !== this\.serverIdle\) \{[\s\S]{0,120}return;/.test(packet));
const pai = es.slice(es.indexOf('public playActionIdle'), es.indexOf('private gameMenuOpen'));
check('...and it is the server\'s only once it really began (a refused idle leaves nothing for a stop to end)',
  /this\.playIdle\(anim, held, endsItself\);\s*\/\/[^\n]*\n\s*if \(fromServer && this\.activeEmote === anim\) this\.serverIdle = anim;/.test(pai));
check('no dboIdle sets serverIdle before the idle plays', !/this\.serverIdle = anim;\s*this\.playActionIdle/.test(es));
const fs2 = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'factionService.ts'), 'utf8');
check('F3 says it is opening the journal', /"Opening your journal…"/.test(fs2) && !/Opening your factions/.test(fs2));
check('a held idle is not cut to 10 s', /public playActionIdle\(anim: string, seconds: number, endsItself: boolean, hold = false, fromServer = false\): void \{\s*const held = hold \? seconds : Math\.min\(MAX_IDLE_SECONDS/.test(es));
check('the player\'s own wheel choice is never the server\'s idle', /if \(key === events\.play\) \{\s*const anim = [^\n]*\n\s*\/\/[^\n]*\n\s*this\.serverIdle = "";/.test(es));
check('the limits come from idleControl, not a second copy', /import \{ MIN_IDLE_SECONDS, MAX_IDLE_SECONDS, idleRequest, stopsIdle \} from "\.\/idleControl";/.test(es) && !/^const MAX_IDLE_SECONDS/m.test(es));

// ---- the auto-move clear ----
const am = load('autoMoveClear.ts');
check('the journal counts with the mini-games for the auto-move clear', am.isMinigameWidget('journal') === true && am.isMinigameWidget('labour') && am.isMinigameWidget('skinning'));
const run = { speed: 350, movementKeyHeld: false, airborne: false };
check('...so an auto-running player is stopped when the journal opens', am.shouldClearAutoMove('journal', [run, run, run]) === true);
check('...and a standing one is left alone', am.shouldClearAutoMove('journal', [{ speed: 0, movementKeyHeld: false, airborne: false }, { speed: 0, movementKeyHeld: false, airborne: false }]) === false);
check('an ordinary panel still is not', am.isMinigameWidget('playerMenu') === false);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
