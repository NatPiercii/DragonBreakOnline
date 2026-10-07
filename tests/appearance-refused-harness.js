// An editor result the server never opened (appearance.js refused, gamemode.js appearanceHook). The engine stores a
// client's UpdateAppearance only while the server has RaceMenu open (fork ActionListener.cpp OnUpdateAppearance,
// IsRaceMenuOpen) and still fires the hook with isAllowed false, so a console showracemenu edit showed on the player's
// screen and was silently gone at the next login. Now a real change is explained, at most once a minute; a pure echo
// (the client sends its look on every RaceSex Menu close) and the server-opened flows (creation, /appearance, /chargen,
// all isAllowed true) say nothing. Runs the real appearance.js, and gamemode.js's own appearanceHook cut out of the file
// with its neighbours stubbed.
//   node tests/appearance-refused-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, label, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${label}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const A = 0xff000101, B = 0xff000102;
const props = new Map();
let said = [], audits = [], sets = 0;
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: (id, k, v) => { sets++; props.set(`${id}|${k}`, v); },
  setRaceMenuOpen: () => {},
};
const look = () => ({ raceId: 0x13741, isFemale: false, name: 'Brand Stoneborn', weight: 50, skinColor: 13021352, hairColor: 2,
  headpartIds: [0x51633, 0x51631, 0x8555f], headTextureSetId: 3, options: [-0.30000001192092896, 0.699999988079071, 3.4028234663852886e+38], presets: [4, -1, 0, 4],
  tints: [{ argb: -4337957, texturePath: 'Actors\\Character\\Character Assets\\TintMasks\\SkinTone.dds', type: 6 }] });
const cmds = new Map();
globalThis.__dboAppearanceRefusedAt = new Map();
const mod = require(path.join(ROOT, 'appearance.js'))({
  mp, log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: () => 'Brand',
  registerChatCommand: (n, f) => cmds.set(n, f), cfg: { appearance: { cost: 500, cooldownHours: 24 } },
  userOf: () => 3, profileOf: (a) => (a === B ? -1 : 7), later: () => {},
});
const E = globalThis.__dboAppearanceEdit;
const NOTICE = "That change to your look wasn't saved. Only /appearance (or a GM) can change your saved look, and edits made with the console's showracemenu are lost when you log out.";
const reset = () => { props.clear(); props.set(`${A}|appearance`, look()); said = []; audits = []; sets = 0; globalThis.__dboAppearanceRefusedAt.clear(); };

// gamemode.js's appearanceHook, as written there, over stubs of what it calls
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const hookSrc = src.slice(src.indexOf('const appearanceHook = '), src.indexOf('appearanceHook.__dbo = true;'));
ok(hookSrc.length > 200, 'gamemode.js has its appearanceHook');
const steps = [];
let prevCalls = [];
globalThis.__dboAppearanceHookPrev = (actorId, app, isAllowed) => { prevCalls.push(isAllowed); return true; };
globalThis.__dboCreatorName = null; globalThis.__dboRerollDone = null;
const hook = new Function('mp', 'log', 'creationPending', 'moveToHubWhenReady', 'giveStarterKit', 'creatorClosedAt', 'endCreation', 'CREATION_MOVE_MS', 'setTimeout',
  `${hookSrc}\nreturn appearanceHook;`)(mp, () => {}, (a) => props.get(`${a}|private.creationPending`) === true || props.get(`${a}|appearance`) == null,
  (a) => steps.push('hub'), (a) => steps.push('kit'), { set: () => steps.push('closedAt') }, (a) => steps.push('end'), 9000, (fn, ms) => steps.push(`timer ${ms}`));

// 1. Pure echoes say nothing
reset();
ok(E.refused(A, look()) === false && said.length === 0 && audits.length === 0, 'the stored look sent back (a close with no change): nothing');
const reordered = Object.assign(look(), { headpartIds: [0x8555f, 0x51633, 0x51631], options: [-0.3000000119, 0.6999999881, 3.4028234663852886e+38] });
ok(E.refused(A, reordered) === false && said.length === 0, 'the same look with head parts reordered and float noise: nothing');
ok(E.refused(A, Object.assign(look(), { tints: [{ argb: 4290629339, texturePath: look().tints[0].texturePath, type: 6 }] })) === false, 'a tint colour signed one way and unsigned the other: nothing');

// 2. A real change: told once, audited, nothing stored
reset();
ok(E.refused(A, Object.assign(look(), { hairColor: 9 })) === true, 'a console edit (new hair) is refused with a notice');
ok(said.length === 1 && said[0][0] === A && said[0][1] === NOTICE, 'the player gets the notice', said);
ok(audits.length === 1 && audits[0] === 'APPEARANCE Brand editor result refused (not opened by the server)', 'audited', audits);
ok(sets === 0 && props.get(`${A}|appearance`).hairColor === 2, 'nothing is written: the stored look stands');
// 3. Once a minute
ok(E.refused(A, Object.assign(look(), { skinColor: 1 })) === false && said.length === 1 && audits.length === 1, 'another refused edit within the minute: no second notice');
globalThis.__dboAppearanceRefusedAt.set(A, Date.now() - 61000);
ok(E.refused(A, Object.assign(look(), { skinColor: 1 })) === true && said.length === 2, 'a minute later: told again');
props.set(`${B}|appearance`, look());
// 4. Who is never told
reset(); props.set(`${A}|private.creationPending`, true);
ok(E.refused(A, Object.assign(look(), { hairColor: 9 })) === false && said.length === 0, 'a character still in creation: nothing');
reset(); props.set(`${A}|private.rerollPending`, true);
ok(E.refused(A, Object.assign(look(), { hairColor: 9 })) === false && said.length === 0, 'a reroll in progress: nothing');
reset(); props.delete(`${A}|appearance`);
ok(E.refused(A, look()) === false && said.length === 0, 'no stored look yet: nothing');
reset(); props.set(`${B}|appearance`, look());
ok(E.refused(B, Object.assign(look(), { hairColor: 9 })) === false && said.length === 0, 'not a player character: nothing');

// 5. Through gamemode.js's hook: a refused close reaches refused() and none of creation's steps
reset(); steps.length = 0; prevCalls = [];
ok(hook(A, Object.assign(look(), { hairColor: 9 }), false) === true && said.length === 1 && said[0][1] === NOTICE, 'the hook tells the player of a refused close');
ok(steps.length === 0 && prevCalls.length === 1 && prevCalls[0] === false, 'no creation step runs, and the chain still hears it (isAllowed false)', steps);
reset(); steps.length = 0;
hook(A, look(), false);
ok(said.length === 0 && steps.length === 0, 'the hook with an echo: nothing');

// 6. The server-opened flows never notice
// Character creation: the creator closes allowed
reset(); props.delete(`${A}|appearance`); props.set(`${A}|private.creationPending`, true);
hook(A, Object.assign(look(), { hairColor: 9 }), true);
ok(!said.some((x) => x[1] === NOTICE) && steps.includes('hub') && steps.includes('timer 6000') && steps.includes('timer 9000'), 'creation: no notice, creation\'s steps run as before', steps);
// /appearance: the pending edit is settled by finish()
reset(); props.set(`${A}|inventory`, { entries: [{ baseId: 0xf, count: 800 }] });
cmds.get('appearance')(A, ''); said = [];
props.set(`${A}|appearance`, Object.assign(look(), { hairColor: 9 }));
hook(A, Object.assign(look(), { hairColor: 9 }), true);
ok(!said.some((x) => x[1] === NOTICE) && said.some((x) => /new look is saved/.test(x[1])), '/appearance: settled and charged, no notice', said);
// A GM's /chargen on an existing character
reset(); steps.length = 0;
E.chargenOpened(A);
props.set(`${A}|appearance`, Object.assign(look(), { hairColor: 9 }));
hook(A, Object.assign(look(), { hairColor: 9 }), true);
ok(!said.some((x) => x[1] === NOTICE) && !props.get(`${A}|private.dboChargenEdit`) && steps.includes('timer 6000') && steps.includes('timer 9000'), '/chargen: no notice, the snapshot settled, creation\'s steps still run', steps);
// An allowed close is never a refusal, even one that differs
reset();
hook(A, Object.assign(look(), { hairColor: 9 }), true);
ok(!said.some((x) => x[1] === NOTICE), 'any allowed close: no notice');

// 7. Login sends nothing: the client sends its look only when RaceSex Menu goes from shown to closed, and starts closed
const fork = process.env.FORK || path.resolve(ROOT, '..', 'fork');
const sis = path.join(fork, 'skymp5-client/src/services/services/sendInputsService.ts');
if (fs.existsSync(sis)) {
  const t = fs.readFileSync(sis, 'utf8');
  ok(/private isRaceSexMenuShown = false;/.test(t) && /if \(shown != this\.isRaceSexMenuShown\)/.test(t) && /if \(!shown\)/.test(t), 'the client sends its look only on a RaceSex Menu close (none at login)');
} else console.log('ok    (no client here to read: the login check is skipped)');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
