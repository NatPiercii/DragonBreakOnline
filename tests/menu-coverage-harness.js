// The U menu (the player panel, gamemode.js "the player panel (U)") and /help, against every chat command this tree
// registers (Nate, 4 Oct: "make sure to update the U menu"). help-harness.js drives the menu's logic with stub commands;
// this one builds it from the real ones: it reads every registerChatCommand('<name>', ..., { admin, hidden, help }) in
// the gameplay modules, registers each with its own flags and help, and runs gamemode.js's own HELP_GROUPS, STAFF_HELP
// and panel code over them. It checks that
//   - every command the menu, /help or /help admin names is registered (a command still on its branch is allowed only
//     in PENDING, and must then be missing from every panel);
//   - every /word a hint names is a command or a chat word, and every key a hint names is the client's default for it
//     (keybindsService.ts in $FORK, when there is one);
//   - every player command has a menu entry, is named in a hint, or is in EXCLUDED with the reason; nothing falls
//     through to the Other tab, and every staff command has a /help admin topic;
//   - staff entries reach staff alone, and the panel keeps to what its front draws: a numeric widget id, unique entry
//     names and hint lines, boxes with no drop-downs, plain ASCII text.
// Run it from this folder's parent with
//   node tests/menu-coverage-harness.js            (FORK=<fork> for the key check; run-all.sh passes it)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined && !ok ? '   ' + detail : ''}`); if (!ok) failures++; };

// Named by the menu before they ship (a name shows only while its command is registered): name -> the branch
const PENDING = {};
// Player commands the menu leaves out on purpose, and why. A name here that the menu lists after all, or that is no
// longer registered, fails: the list is kept true.
const EXCLUDED = {
  bank: 'opened at a bank counter (hint: Your money)',
  board: 'opened at a notice board (hints: work for pay, pigeons)',
  business: 'opened from its ledger book (hint: Your business)',
  faction: 'F3, the Faction tab (hint)',
  rite: 'offered at a shrine (hint: Offerings and rites)',
  offer: 'made at a shrine (hint: Offerings and rites)',
  tomes: 'the shop inside the Synod Conclave (hint: Spell tomes)',
  contract: 'the Contracts tab of the expedition board (hint: Hunting work)',
  expedition: 'set out from the expedition board (hint: An expedition)',
  expeditions: 'set out from the expedition board (hint: An expedition)',
  respawn: 'the down panel offers it while you are down',
  level: 'folded into /status (hint: Spending a level)',
  hunger: 'folded into /status',
  rest: 'folded into /status',
  chill: 'folded into /status',
  sentence: 'folded into /status',
  whoami: 'F7 shows your ids (hint)',
  ping: 'a connection test',
  pigeonblock: 'rare: ignoring one person\'s pigeons',
  sign: 'rare: how a pigeon letter is signed',
  tokens: 'Patreon tiers, kept quiet while they are under legal review',
  reroll: 'Patreon tiers, kept quiet while they are under legal review',
  wildlife: 'rare: what roams the wilds',
  champions: 'rare: named beasts abroad',
  playtest: 'rare: what part of the world is open',
};
// Words the chat handler takes before it looks for a command (gamemode.js handleChat)
const CHAT_WORDS = new Set(['say', 'low', 'whisper', 'wide', 'shout', 'me', 'melow', 'melong', 'my', 'mylow', 'mylong', 'do', 'dolow',
  'dolong', 'looc', 'ooc', 'ooclow', 'ooclong', 'pm', 'dm', 'to', 'too', 'system', 'admin']);
// A key a hint names, the client binding whose default it must be (keybindsService.ts DEFAULTS), and what a line naming
// it must be about, so a key moved to another job (or a line given the wrong key) fails
const KEY_BINDING = { T: ['chatKeyCode'], U: ['personalMenuKeyCode'], F3: ['factionMenuKeyCode'], K: ['masteryMenuKeyCode'],
  X: ['playerActionKeyCode', 'housingMenuKeyCode'], B: ['emoteWheelKeyCode'], H: ['maskToggleKeyCode'], F7: ['adminMenuKeyCode'],
  F1: ['nametagKeyCode'], F2: ['hideUiKeyCode'], F8: ['freeCursorKeyCode'], V: ['voicePushToTalkKeyCode'] };
const KEY_ABOUT = { T: /chat|talk/i, U: /menu|panel/i, F3: /journal|faction|court|deity|settings|magic|supernatural|profile/i, K: /skill/i,
  X: /introduc|trad|inspect|door/i, B: /emote/i, H: /face|mask/i, F7: /admin panel|ids|place/i, F1: /name/i, F2: /interface|hide/i,
  F8: /cursor/i, V: /voice|talk/i };

// ---- every registered command, read from the modules ------------------------------------------------------------
const unquote = (lit) => {
  if (/^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/.test(lit)) return new Function(`return ${lit}`)();
  if (/^`[^`]*`$/.test(lit)) return lit.slice(1, -1); // a template: kept as written, ${...} and all
  return `(${lit})`;                                   // a name: the text is built elsewhere
};
const registered = new Map(); // name -> { file, admin, hidden, help }
const scanProblems = [];
const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const calls = [...src.matchAll(/registerChatCommand\s*\(/g)].map((m) => m.index);
  for (let k = 0; k < calls.length; k++) {
    const at = calls[k];
    const before = src.slice(Math.max(0, at - 6), at);
    const head = src.slice(at, at + 200);
    if (/const\s+$/.test(src.slice(Math.max(0, at - 6), at)) || /^registerChatCommand\s*\(\s*oldName\b/.test(head)) continue; // the definitions
    void before;
    const m = head.match(/^registerChatCommand\s*\(\s*(['"])([^'"]+)\1\s*,/);
    if (!m) { scanProblems.push(`${f}:${src.slice(0, at).split('\n').length} registers a command by a computed name`); continue; }
    const name = m[2].toLowerCase();
    const window = src.slice(at + m[0].length, k + 1 < calls.length ? calls[k + 1] : at + 30000);
    const opt = window.match(/,\s*(\{\s*(?:admin|hidden|help)\s*:[^\n]*?\})\s*\)/);
    const o = opt ? opt[1] : '';
    const help = (o.match(/\bhelp\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$.[\]]*)/) || [])[1];
    registered.set(name, { file: f, admin: /\badmin\s*:\s*true\b/.test(o), dynamicAdmin: /\badmin\s*:/.test(o) && !/\badmin\s*:\s*(true|false)\b/.test(o),
      hidden: /\bhidden\s*:\s*true\b/.test(o), help: help ? unquote(help) : '' });
  }
  for (const m of src.matchAll(/aliasChatCommand\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) if (!/const aliasChatCommand/.test(m[0])) registered.set(m[1], { file: f, admin: false, hidden: true, help: `now part of /${m[2]}` });
}
check('every command is registered by a plain name the scan can read', scanProblems.length === 0, scanProblems.join('; '));
check('the scan finds the modules\' commands (over 90)', registered.size > 90, registered.size);
// The scan reads options by pattern, so it proves itself on commands whose flags are known
const known = { kick: { admin: true }, forget: { hidden: true }, monitor: { admin: true }, ping: { help: 'connection test' }, bug: { admin: false }, ticket: { admin: false } };
for (const [n, want] of Object.entries(known)) {
  const r = registered.get(n);
  check(`the scan reads /${n}'s options right`, !!r && Object.entries(want).every(([k, v]) => r[k] === v), JSON.stringify(r));
}
const dyn = [...registered].filter(([, r]) => r.dynamicAdmin).map(([n]) => n);
check('no command decides admin at run time (the menu could not tell)', dyn.length === 0, dyn.join(', '));

// ---- the menu, built by gamemode.js's own code over those commands ----------------------------------------------
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const s0 = src.indexOf('const commands = new Map();'), s1 = src.indexOf("registerChatCommand('players'");
const p0 = src.indexOf('// ---- the player panel (U)'), p1 = src.indexOf('globalThis.__dboPanelLeave');
if (s0 < 0 || s1 < s0 || p0 < 0 || p1 < p0) { console.log('FAIL the chat command or panel markers are gone from gamemode.js'); process.exit(1); }
const PLAYER = 1, STAFF = 2, RANKED = 3, BEAST = 4;
const opened = [], chatted = [];
const ui = new Map();
const api = new Function('personal', 'isAdmin', 'deliver', 'C', 'profileOf', 'ranksOf', 'openWidget', 'closeWidget', 'onUi', 'userOf', 'handleChat',
  src.slice(s0, s1) + src.slice(p0, p1) + `
return { commands, registerChatCommand, helpGroupsFor, panelTabsFor, staffTopics, HELP_GROUPS, HELP_BY_OBJECT, STAFF_HELP,
  PANEL_ASK, PANEL_LABEL: typeof PANEL_LABEL === 'undefined' ? {} : PANEL_LABEL, PANEL_SPLIT: typeof PANEL_SPLIT === 'undefined' ? {} : PANEL_SPLIT,
  PANEL_STAFF: typeof PANEL_STAFF === 'undefined' ? { names: [], hints: [] } : PANEL_STAFF, PANEL_EXTRA, PANEL_WIDGET_ID };`)(
  () => {}, (a) => a === STAFF, () => {}, { WHITE: 'fafafa', SYS: 'eda841' }, (a) => a, (pid) => (pid === RANKED ? [{ zone: { id: 'bruma' }, rank: 'steward' }] : []),
  (a, widget, focus) => opened.push({ a, widget, focus }), () => {}, (ev, fn) => { const l = ui.get(ev) || []; l.push(fn); ui.set(ev, l); }, (a) => a,
  (userId, text) => chatted.push({ userId, text }));
globalThis.__dboSuperKind = (a) => (a === BEAST ? 'werewolf' : null);
for (const [n, r] of registered) if (!api.commands.has(n)) api.registerChatCommand(n, () => {}, { admin: r.admin, hidden: r.hidden, help: r.help });
const { commands, HELP_GROUPS, HELP_BY_OBJECT, STAFF_HELP, PANEL_ASK, PANEL_LABEL, PANEL_SPLIT, PANEL_STAFF, PANEL_EXTRA } = api;
const isCmd = (n) => commands.has(n);
const extraNames = new Set(Object.values(PANEL_EXTRA).flat().map((e) => e.name));

// ---- what the menu names exists ---------------------------------------------------------------------------------
const missing = (list) => list.filter((n) => !isCmd(n) && !PENDING[n]);
check('every command a /help topic names is registered', missing(HELP_GROUPS.flatMap((g) => g.names)).length === 0, missing(HELP_GROUPS.flatMap((g) => g.names)).join(', '));
const staffWords = STAFF_HELP.flatMap((t) => t.items.map((it) => (Array.isArray(it) ? it[0] : it).split(' ')[0]));
check('every command /help admin names is registered (or the admin chat word)', missing(staffWords.filter((w) => w !== 'admin')).length === 0, missing(staffWords.filter((w) => w !== 'admin')).join(', '));
const panelKeys = [...Object.keys(PANEL_ASK), ...Object.keys(PANEL_LABEL), ...Object.keys(PANEL_SPLIT)].filter((n) => !extraNames.has(n));
check('every command the panel words, labels or splits is registered', missing(panelKeys).length === 0, missing(panelKeys).join(', '));
check('the panel\'s extras (/pm) are chat words, not commands', [...extraNames].every((n) => CHAT_WORDS.has(n) && !isCmd(n)), [...extraNames].join(', '));
const staffTab = (PANEL_STAFF.names || []).filter((n) => !(isCmd(n) && commands.get(n).admin));
check('the Staff tab\'s buttons are all staff commands', staffTab.length === 0, staffTab.join(', '));
for (const [n, why] of Object.entries(PENDING)) {
  if (isCmd(n)) { console.log(`note /${n} is registered here now; PENDING may drop it (${why})`); continue; }
  const shown = [PLAYER, STAFF, RANKED, BEAST].some((a) => api.panelTabsFor(a).some((t) => t.entries.some((e) => e.name.split(' ')[0] === n)));
  check(`/${n} is named but not registered, and no panel shows it (${why})`, !shown);
}

// ---- hints: the commands and keys they name -----------------------------------------------------------------------
const playerHints = HELP_GROUPS.flatMap((g) => (g.hints || []).map((h) => ({ g: g.key, h })));
const allHints = playerHints.concat((PANEL_STAFF.hints || []).map((h) => ({ g: 'staff', h })));
const slashWords = (h) => [...h.matchAll(/(?:^|[\s(,;])\/([a-z]+)\b/g)].map((m) => m[1]);
const badWords = allHints.flatMap(({ g, h }) => slashWords(h).filter((w) => !isCmd(w) && !CHAT_WORDS.has(w) && !PENDING[w]).map((w) => `${g}: /${w}`));
check('every /word in a hint is a command or a chat word', badWords.length === 0, badWords.join(', '));
const staffWordsInPlayerHints = playerHints.flatMap(({ g, h }) => slashWords(h).filter((w) => isCmd(w) && commands.get(w).admin).map((w) => `${g}: /${w}`));
check('a player\'s hints name no staff command', staffWordsInPlayerHints.length === 0, staffWordsInPlayerHints.join(', '));
const keysNamed = new Set();
for (const { h } of allHints) {
  for (const m of h.matchAll(/\bpress ([A-Z]|F\d{1,2})\b/g)) keysNamed.add(m[1]);
  for (const m of h.matchAll(/\b(F\d{1,2})\b/g)) keysNamed.add(m[1]);
  for (const m of h.matchAll(/\(([A-Z])\)/g)) keysNamed.add(m[1]);
}
const offTopic = allHints.flatMap(({ g, h }) => [...h.matchAll(/\bpress ([A-Z]|F\d{1,2})\b|\b(F\d{1,2})\b|\(([A-Z])\)/g)]
  .map((m) => m[1] || m[2] || m[3]).filter((k) => KEY_ABOUT[k] && !KEY_ABOUT[k].test(h)).map((k) => `${g}: ${k} in "${h}"`));
check('every line that names a key is about what that key does', offTopic.length === 0, offTopic.join('; '));
const unknownKeys = [...keysNamed].filter((k) => !KEY_BINDING[k]);
check('every key a hint names is one this harness knows the binding of', unknownKeys.length === 0, unknownKeys.join(', '));
const FORK = process.env.FORK || path.resolve(ROOT, '..', 'fork');
const KB = path.join(FORK, 'skymp5-client', 'src', 'services', 'services', 'keybindsService.ts');
if (fs.existsSync(KB)) {
  const kb = fs.readFileSync(KB, 'utf8');
  const defaults = {};
  for (const m of kb.matchAll(/(\w+KeyCode)\s*:\s*DxScanCode\.(\w+)/g)) if (!(m[1] in defaults)) defaults[m[1]] = m[2];
  const wrong = [...keysNamed].filter((k) => KEY_BINDING[k]).flatMap((k) => KEY_BINDING[k].filter((b) => defaults[b] !== k).map((b) => `${k}: ${b} is ${defaults[b] || 'not a binding'}`));
  check(`every key a hint names is the client's default (${path.relative(FORK, KB)})`, wrong.length === 0, wrong.join('; '));
} else console.log(`note the key check did not run: no ${KB}`);

// ---- coverage: every player command is in the menu, or left out on purpose ------------------------------------------
const listed = new Set(HELP_GROUPS.flatMap((g) => g.names));
const hinted = new Set(playerHints.flatMap(({ h }) => slashWords(h)));
const playerCmds = [...registered].filter(([n, r]) => !r.admin && !r.hidden && n !== 'help').map(([n]) => n).sort();
const uncovered = playerCmds.filter((n) => !listed.has(n) && !hinted.has(n) && !EXCLUDED[n]);
check('every player command has a menu entry, a hint, or a reason in EXCLUDED', uncovered.length === 0, uncovered.join(', '));
const staleEx = Object.keys(EXCLUDED).filter((n) => !registered.has(n) || listed.has(n) || registered.get(n).admin || registered.get(n).hidden);
check('EXCLUDED names only registered player commands the menu does not list', staleEx.length === 0, staleEx.join(', '));
const byObjectUnexplained = [...HELP_BY_OBJECT].filter((n) => isCmd(n) && !hinted.has(n) && !EXCLUDED[n] && !listed.has(n));
check('every command kept out of the lists (HELP_BY_OBJECT) is hinted at or excluded with a reason', byObjectUnexplained.length === 0, byObjectUnexplained.join(', '));
const otherFor = (a) => (api.helpGroupsFor(a).find((g) => g.key === 'other') || { names: [] }).names;
check('nothing falls through to Other for a player (place a new command in a topic)', otherFor(PLAYER).length === 0, otherFor(PLAYER).join(', '));
check('...nor for staff', otherFor(STAFF).length === 0, otherFor(STAFF).join(', '));
const staffOther = (api.staffTopics().find((t) => t.key === 'other') || { items: [] }).items.map((i) => i.words);
check('every staff command has a /help admin topic (none under Other staff tools)', staffOther.length === 0, staffOther.join(', '));
console.log(`     ${playerCmds.length} player commands: ${playerCmds.filter((n) => listed.has(n)).length} listed, ${playerCmds.filter((n) => !listed.has(n) && hinted.has(n)).length} named in a hint, ${playerCmds.filter((n) => EXCLUDED[n]).length} excluded`);

// ---- who sees what ------------------------------------------------------------------------------------------------
for (const a of [PLAYER, STAFF, RANKED, BEAST]) ui.get('uiCaps').forEach((fn) => fn(a, ['playerMenu']));
const panelOf = (a) => { opened.length = 0; ui.get('menuOpen').forEach((fn) => fn(a, [''])); return opened[0] && opened[0].widget; };
const P = panelOf(PLAYER), S = panelOf(STAFF), R = panelOf(RANKED), W = panelOf(BEAST);
const entriesOf = (w) => w.tabs.flatMap((t) => t.entries);
const tabKeys = (w) => w.tabs.map((t) => t.key);
const adminIn = (w) => entriesOf(w).filter((e) => { const c = commands.get(e.name.split(' ')[0]); return c && c.admin; }).map((e) => e.name);
check('a player\'s panel offers no staff command', adminIn(P).length === 0 && adminIn(R).length === 0 && adminIn(W).length === 0, adminIn(P).concat(adminIn(R), adminIn(W)).join(', '));
check('...and no Staff tab', !tabKeys(P).includes('staff') && !tabKeys(R).includes('staff') && !tabKeys(W).includes('staff'), tabKeys(P).join(','));
check('staff are given the Staff tab, last', tabKeys(S)[tabKeys(S).length - 1] === 'staff', tabKeys(S).join(','));
check('the Rule tab is for officials (and staff), the beast tab for the cursed (and staff)', tabKeys(R).includes('rule') && !tabKeys(P).includes('rule')
  && tabKeys(W).includes('beast') && !tabKeys(P).includes('beast') && tabKeys(S).includes('rule') && tabKeys(S).includes('beast'), `${tabKeys(P)} | ${tabKeys(R)} | ${tabKeys(W)}`);
check('a tenant finds /property without holding office', entriesOf(P).some((e) => e.name === 'property'));
check('/ticket is one button per kind, each asking what happened', ['ticket mod', 'ticket report', 'ticket pk'].every((n) => { const e = entriesOf(P).find((x) => x.name === n); return e && e.ask && e.ask.length === 1; })
  && !entriesOf(P).some((e) => e.name === 'ticket'), entriesOf(P).filter((e) => e.name.startsWith('ticket')).map((e) => e.name).join(', '));
const nonce = P.nonce; chatted.length = 0;
ui.get('menuRun').forEach((fn) => fn(PLAYER, [nonce, 'ticket report', 'someone took my horse']));
check('...and a kind\'s button sends "/ticket <kind> <words>"', chatted.length === 1 && chatted[0].text === '/ticket report someone took my horse', JSON.stringify(chatted));

// ---- what the front can draw -------------------------------------------------------------------------------------
check('the widget id is a number (the relay drops any other)', Number.isInteger(api.PANEL_WIDGET_ID) && api.PANEL_WIDGET_ID > 0, api.PANEL_WIDGET_ID);
for (const [label, w] of [['player', P], ['staff', S]]) {
  const names = entriesOf(w).map((e) => e.name);
  check(`${label}: entry names are unique (menuRun and the front's keys)`, new Set(names).size === names.length, names.join(','));
  const dupHints = w.tabs.filter((t) => new Set(t.hints).size !== t.hints.length).map((t) => t.key);
  check(`${label}: hint lines are unique within a tab (the front keys them by text)`, dupHints.length === 0, dupHints.join(','));
  const boxes = entriesOf(w).flatMap((e) => e.ask || []);
  check(`${label}: every box is a label and text (no drop-downs: a native select never draws)`, boxes.every((b) => typeof b.label === 'string' && b.label
    && Object.keys(b).every((k) => ['label', 'placeholder', 'lines'].includes(k))), JSON.stringify(boxes));
  const texts = w.tabs.flatMap((t) => [t.title, ...t.hints, ...t.entries.flatMap((e) => [e.label, e.desc, ...(e.ask || []).flatMap((b) => [b.label, b.placeholder || ''])])]);
  const odd = texts.filter((t) => typeof t !== 'string' || /[^\x20-\x7e]/.test(t));
  check(`${label}: every line is plain ASCII`, odd.length === 0, odd.slice(0, 3).join(' | '));
  const empty = entriesOf(w).filter((e) => !e.desc).map((e) => e.name);
  check(`${label}: every button says what it does`, empty.length === 0, empty.join(', '));
}
const unexpanded = entriesOf(S).filter((e) => /\$\{/.test(e.desc) && !/^unstuck$/.test(e.name)).map((e) => e.name);
check('no help text shows an unfilled ${...} (the scan keeps templates as written; only /unstuck has one, filled at load)', unexpanded.length === 0, unexpanded.join(', '));

delete globalThis.__dboSuperKind;
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
