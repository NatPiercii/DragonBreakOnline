// naming.js against a stub mp, in a scratch folder with its own name-filter.json: a character left as "Prisoner" is
// held in the Realm and asked for a name, /name applies the creator's rules and uniqueness, and a named one goes on.
//   node tests/naming-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'naming.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-naming-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
fs.writeFileSync('name-filter.json', JSON.stringify({ maxWords: 3, minLength: 2, maxLength: 30, maxRepeatedLetters: 2, blocked: ['nwah'], reserved: ['talos'] }));

const PRISONER = 0xff000001, NAMED = 0xff000002, CREATING = 0xff000003, OTHER = 0xff000004;
const props = new Map();
const setp = (id, k, v) => props.set(`${id}|${k}`, v);
setp(PRISONER, 'appearance', { name: 'Prisoner', race: 1 });
setp(NAMED, 'appearance', { name: 'Aela Brightwater' });
setp(CREATING, 'appearance', { name: 'Stranger' });
setp(OTHER, 'appearance', { name: 'Vaeric Stone' }); setp(OTHER, 'private.indexed.charName', 'vaericstone');
const said = [], audits = [], cmds = {}, timers = {}, named = [], widgets = [], closed = [], ui = {};
const PANEL_USER = 0xff000005, HUB_USER = 0xff000006;
let ONLINE = [PRISONER, NAMED, CREATING];
setp(PANEL_USER, 'appearance', { name: 'Prisoner' });
setp(HUB_USER, 'appearance', { name: 'Prisoner' });
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: setp,
  findFormsByPropertyValue: (k, v) => [...props.keys()].filter((key) => key.endsWith(`|${k}`) && props.get(key) === v).map((key) => Number(key.split('|')[0])),
};
globalThis.__dboNameAsked = undefined; globalThis.__dboNamingCaps = undefined; globalThis.__dboNamingNonces = undefined;
require(MODULE)({
  mp, log: () => {}, personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who: String, display: String,
  registerChatCommand: (n, fn) => { cmds[n] = fn; }, onlineActors: () => ONLINE, every: (n, ms, fn) => { timers[n] = fn; },
  profileOf: (a) => (a >= 0xff000000 ? 1 : -1), inCreation: (a) => a === CREATING,
  onUi: (n, fn) => { (ui[n] = ui[n] || []).push(fn); }, openWidget: (a, w, focus) => widgets.push([a, w, focus]), closeWidget: (a, id) => closed.push([a, id]),
  inHub: (a) => a === HUB_USER,
});
const fire = (n, a, args, wid) => (ui[n] || []).forEach((f) => f(a, args || [], wid || 0));
globalThis.__dboNamed = (a) => named.push(a);
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const last = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };

check('a character left as "Prisoner" is held in the Realm', globalThis.__dboNameHold(PRISONER) === true);
check('...and told how to name itself', /Type \/name and their name/.test(last(PRISONER)));
check('a named character goes on', globalThis.__dboNameHold(NAMED) === false);
check('a character still in the race menu ("Stranger") is left alone', globalThis.__dboNameHold(CREATING) === false && !last(CREATING));
said.length = 0; timers.naming();
check('the reminder asks only the unnamed, and not again within a minute', said.length === 0);
globalThis.__dboNameAsked.set(PRISONER, 0); timers.naming();
check('...a minute later it asks again', said.length === 1 && said[0][0] === PRISONER);

const tryName = (n) => { cmds.name(PRISONER, n); return last(PRISONER); };
check('a lower-case run of capitals is refused', /Capitals only at the start of a word/.test(tryName('AeLa Stone')));
check('capitals throughout are refused', /not written in capitals/.test(tryName('AELA STONE')));
check('four words are too many', /at most 3 words/.test(tryName('Aela Of The Stone')));
check('a blocked word is refused, however it is spaced', /will not do here/.test(tryName("Big N'wah")));
check('a reserved name is refused', /reserved/.test(tryName('Talos')));
check('digits are refused', /letters, spaces, apostrophes and hyphens/.test(tryName('Aela2')));
check('"Prisoner" itself is refused', /Choose a name of your own/.test(tryName('Prisoner')));
check("another character's name is refused (case and marks folded)", /already carries that name/.test(tryName("vaeric-Stone".replace('v', 'V'))));
check('still held after the refusals', globalThis.__dboNameHold(PRISONER) === true && props.get(`${PRISONER}|appearance`).name === 'Prisoner');
check('a good name is taken', /now Flo'Riahn Snow-Hand/.test(tryName("Flo'Riahn  Snow-Hand")));
check('...on the appearance, the look kept', props.get(`${PRISONER}|appearance`).name === "Flo'Riahn Snow-Hand" && props.get(`${PRISONER}|appearance`).race === 1);
check('...and in the uniqueness index', props.get(`${PRISONER}|private.indexed.charName`) === 'floriahnsnowhand');
check('...audited', audits.some((t) => /named themselves "Flo'Riahn Snow-Hand" \(was "Prisoner", chat\)/.test(t)));
check('...and the gamemode is told, so it can send them on', named.length === 1 && named[0] === PRISONER);
check('no longer held', globalThis.__dboNameHold(PRISONER) === false);
cmds.name(NAMED, 'Someone Else');
check('/name does nothing for a character that has a name', /already has a name/.test(last(NAMED)) && props.get(`${NAMED}|appearance`).name === 'Aela Brightwater');

// The panel (front namePrompt, widget 68) for a client that draws it
ONLINE = [PRISONER, NAMED, CREATING, PANEL_USER, HUB_USER];
fire('uiCaps', PANEL_USER, ['bank', 'namePrompt']);
said.length = 0;
check('a client that draws the panel is asked in it, not in chat', globalThis.__dboNameHold(PANEL_USER) === true && widgets.length === 1 && !said.some((x) => x[0] === PANEL_USER));
const w = widgets[0];
check('...a focused namePrompt, id 68, with a nonce and the limits', w[0] === PANEL_USER && w[1].type === 'namePrompt' && w[1].id === 68 && w[2] === true && !!w[1].nonce && w[1].maxLength === 30 && w[1].maxWords === 3 && w[1].events.choose === 'dbo:nameChoose');
globalThis.__dboNameAsked.set(PANEL_USER, 0); timers.naming();
check('an open panel is not opened again by the reminder', widgets.length === 1);
fire('nameChoose', PANEL_USER, ['stale', 'Aela Stone']);
check('a stale panel changes nothing', props.get(`${PANEL_USER}|appearance`).name === 'Prisoner' && widgets.length === 1);
fire('nameChoose', PANEL_USER, [w[1].nonce, 'AELA STONE']);
const again = widgets.at(-1);
check('a refused name reopens the panel with the reason (no close in between)', widgets.length === 2 && /not written in capitals/.test(again[1].error) && !closed.length && again[1].nonce !== w[1].nonce);
fire('nameChoose', PANEL_USER, [again[1].nonce, 'Aela Stone']);
check('a good name is taken from the panel, and the panel closes', props.get(`${PANEL_USER}|appearance`).name === 'Aela Stone' && closed.length === 1 && closed[0][1] === 68 && audits.some((t) => /"Aela Stone" \(was "Prisoner", panel\)/.test(t)));
// Escape, then the reminder
setp(PANEL_USER, 'appearance', { name: 'Prisoner' });
globalThis.__dboNameAsked.set(PANEL_USER, 0); timers.naming();
const third = widgets.at(-1);
fire('close', PANEL_USER, [], 68);
globalThis.__dboNameAsked.set(PANEL_USER, 0); timers.naming();
check('after Escape the reminder opens it again', widgets.at(-1) !== third && widgets.at(-1)[1].type === 'namePrompt');
// In the Realm the reminder waits for the hold (after the deity picker)
fire('uiCaps', HUB_USER, ['namePrompt']);
const before = widgets.length; globalThis.__dboNameAsked.set(HUB_USER, 0); timers.naming();
check('in the Realm the reminder does not open it over the creation panels', widgets.length === before);
check('...the hold in sendToArrival does', globalThis.__dboNameHold(HUB_USER) === true && widgets.length === before + 1 && widgets.at(-1)[0] === HUB_USER);

// Names typed in the race menu (__dboCreatorName, from the gamemode's appearance hook), checked after the engine applies
(async () => {
  const NEWBIE = 0xff000010, REROLL = 0xff000011;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  setp(NEWBIE, 'appearance', { name: 'Stranger' });
  let p = globalThis.__dboCreatorName(NEWBIE, { name: 'XxSlayerxX' }, 'creation');
  setp(NEWBIE, 'appearance', { name: 'XxSlayerxX', race: 3 }); await tick();
  check('a creation name that breaks the rules is refused, not the look', !!p && props.get(`${NEWBIE}|appearance`).name === 'Prisoner' && props.get(`${NEWBIE}|appearance`).race === 3);
  check('...the reason is kept for the name panel', /"XxSlayerxX" will not do: Capitals only/.test(props.get(`${NEWBIE}|private.dboNameRefused`) || ''));
  check('...and the character is held and asked, with the reason', globalThis.__dboNameHold(NEWBIE) === true && /will not do/.test(last(NEWBIE)));
  cmds.name(NEWBIE, 'Brynja Frost');
  check('naming it clears the reason', props.get(`${NEWBIE}|appearance`).name === 'Brynja Frost' && props.get(`${NEWBIE}|private.dboNameRefused`) === null);
  setp(NEWBIE, 'appearance', { name: 'Stranger' });
  p = globalThis.__dboCreatorName(NEWBIE, { name: 'Vaeric Stone' }, 'creation');
  setp(NEWBIE, 'appearance', { name: 'Vaeric Stone' }); await tick();
  check("another character's name at creation is refused", /already carries/.test(p || '') && props.get(`${NEWBIE}|appearance`).name === 'Prisoner');
  setp(NEWBIE, 'appearance', { name: 'Stranger' });
  p = globalThis.__dboCreatorName(NEWBIE, { name: 'Ingrid Hale' }, 'creation');
  setp(NEWBIE, 'appearance', { name: 'Ingrid Hale' }); await tick();
  check('a good creation name stands and goes into the index', p === null && props.get(`${NEWBIE}|appearance`).name === 'Ingrid Hale' && props.get(`${NEWBIE}|private.indexed.charName`) === 'ingridhale');
  setp(NEWBIE, 'appearance', { name: 'Stranger' });
  p = globalThis.__dboCreatorName(NEWBIE, { name: 'Prisoner' }, 'creation');
  setp(NEWBIE, 'appearance', { name: 'Prisoner' }); await tick();
  check("a dead name box (\"Prisoner\") is left to the name panel, not refused", p === null && !props.get(`${NEWBIE}|private.dboNameRefused`));
  setp(REROLL, 'appearance', { name: 'Old Name' });
  p = globalThis.__dboCreatorName(REROLL, { name: 'Talos' }, 'reroll');
  setp(REROLL, 'appearance', { name: 'Talos', race: 5 }); await tick();
  check('a refused reroll name goes back to the name before, the new look kept', /reserved/.test(p || '') && props.get(`${REROLL}|appearance`).name === 'Old Name' && props.get(`${REROLL}|appearance`).race === 5);
  p = globalThis.__dboCreatorName(REROLL, { name: 'Prisoner' }, 'reroll');
  setp(REROLL, 'appearance', { name: 'Prisoner' }); await tick();
  check('a reroll with no name keeps the old one', props.get(`${REROLL}|appearance`).name === 'Old Name');
  // A forged pigeon signature holds to the reserved names and blocked words (2026-09-30)
  fs.writeFileSync('name-filter.json', JSON.stringify({ maxWords: 3, minLength: 2, maxLength: 30, maxRepeatedLetters: 2, blocked: ['nwah'], reserved: ['talos', 'staff', 'dragonbreak', 'system'] }));
  const sig = globalThis.__dboSignatureProblem;
  check('a signature that is a reserved name is refused', /reserved/.test(sig('Talos') || ''));
  check('...and one with a reserved name as any word of it ("DragonBreak Staff")', /reserved/.test(sig('DragonBreak Staff') || '') && /reserved/.test(sig('The Staff') || ''));
  check('...however it is spelt (St4ff)', /reserved/.test(sig('Server St4ff') || ''));
  check('a blocked word anywhere in it is refused', /will not do/.test(sig('Your friend Nwah') || ''));
  check('an ordinary forged name passes, and a word merely containing a reserved one', sig('Jarl Skald') === null && sig('Staffordshire Bull') === null);
  // A real character's name is exactly what a forger may sign, reserved word or not (Worker E: "Dennis Sy'Stem")
  props.set(`${0x777}|private.indexed.charName`, 'dennissystem');
  check('a signature that is an existing character\'s name passes, though a word of it is reserved', sig("Dennis Sy'Stem") === null, sig("Dennis Sy'Stem"));
  check('...but the same reserved word in a name nobody carries is still refused', /reserved/.test(sig("Sy'Stem Clerk") || ''));
  props.set(`${0x778}|private.indexed.charName`, 'nwahtest');
  check('...and a blocked word is refused even in a real character\'s name', /will not do/.test(sig('Nwah Test') || ''));
  const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
  const signCmd = gm.slice(gm.indexOf("registerChatCommand('sign'"), gm.indexOf("registerChatCommand('sign'") + 1800);
  check('/sign asks it before it keeps a forged name', signCmd.indexOf('__dboSignatureProblem(want)') > 0 && signCmd.indexOf('__dboSignatureProblem(want)') < signCmd.indexOf('nextSignature.set(a, { name: want, tier })'));
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
