// Scripted test for server\robbery.js with a mock gamemode api: Rob is offered only when the target's UI has the panel,
// the victim gets the panel and nothing in chat to type, Accept takes 15% of the gold and 3 random things (never worn
// ones) and a key only at the key chance, Fight/Flee and silence both resist and let the robber finish on a downed victim,
// the waits, parties and beast forms, a robber who walked off, and a failed write that must not duplicate anything.
// Run it from this folder's parent with
//
//   node tests\robbery-harness.js
'use strict';
const path = require('path');

const ROB = path.resolve(__dirname, '..', 'robbery.js');
let now = 1790000000000;
Date.now = () => now;

const GOLD = 0xf, DAGGER = 0x1397e, BREAD = 0x65c9f, STRIPS = 0x800e4, HELM = 0x12e4d, ARROW = 0x1397d, KEY = 0x2a3f0;
const types = { [DAGGER]: 'WEAP', [BREAD]: 'ALCH', [STRIPS]: 'MISC', [HELM]: 'ARMO', [ARROW]: 'AMMO', [KEY]: 'KEYM', [GOLD]: 'MISC' };
const ROBBER = 0x14, VICTIM = 0x15, FRIEND = 0x16, FAR = 0x17;
const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const reset = () => {
  set(VICTIM, 'inventory', { entries: [{ baseId: GOLD, count: 1000 }, { baseId: DAGGER, count: 1 }, { baseId: BREAD, count: 4 }, { baseId: STRIPS, count: 2 }, { baseId: HELM, count: 1 }, { baseId: ARROW, count: 20 }, { baseId: KEY, count: 1 }] });
  set(VICTIM, 'equipment', { inv: { entries: [{ baseId: HELM, count: 1, worn: true }, { baseId: ARROW, count: 20, worn: true }] } });
  set(ROBBER, 'inventory', { entries: [{ baseId: GOLD, count: 5 }] });
};
reset();
for (const a of [ROBBER, VICTIM, FRIEND, FAR]) { set(a, 'worldOrCellDesc', 'c:Bruma'); set(a, 'pos', a === FAR ? [5000, 0, 0] : [0, 0, 0]); }
const count = (a, id) => ((get(a, 'inventory') || {}).entries || []).filter((e) => e.baseId === id).reduce((s, e) => s + e.count, 0);

const out = { personal: [], widgets: [], closed: [], audits: [], packets: [] };
const handlers = new Map(); const timers = new Map();
let failSetFor = 0; let random = 0.5;
Math.random = () => random;
globalThis.__dboPartyLeaderOf = (a) => (a === ROBBER || a === FRIEND ? 1 : null);
let downedSet = new Set();
globalThis.__dboIsDowned = (a) => downedSet.has(a);
let downer = 0;
globalThis.__dboDownedBy = (a) => (downedSet.has(a) ? (downer || ROBBER) : 0);
const api = {
  mp: {
    get, set: (id, p, v) => { if (failSetFor === id && p === 'inventory') throw new Error('write failed'); set(id, p, v); },
    getDescFromId: (id) => id.toString(16) + ':Skyrim.esm',
  },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), audit: (t) => out.audits.push(t), who: (a) => `P${a.toString(16)}`,
  onlineActors: () => [ROBBER, VICTIM, FRIEND, FAR], recordOf: (id) => (types[id] ? { record: { type: types[id], editorId: 'Item' + id.toString(16) } } : null),
  adminItemName: (desc) => ({ '1397e:skyrim.esm': 'Iron Dagger', '65c9f:skyrim.esm': 'Bread', '800e4:skyrim.esm': 'Leather Strips', '2a3f0:skyrim.esm': 'House Key' }[desc.toLowerCase()] || ''),
  openWidget: (a, w, focus) => out.widgets.push({ a, w, focus }), closeWidget: (a, id) => out.closed.push({ a, id }),
  onUi: (ev, fn) => handlers.set(ev, fn), sendPacket: (a, p) => out.packets.push({ a, p }),
  every: (name, ms, fn) => timers.set(name, fn), cfg: {},
};
const load = () => { handlers.clear(); delete require.cache[ROB]; return require(ROB)(api); };
const S_caps_clear = () => globalThis.__dboRobbery.caps.clear();
load();
const nameFor = (viewer, x) => ({ [ROBBER]: 'Stranger', [VICTIM]: 'Lydia' }[x] || 'Someone');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const menu = (a, t) => globalThis.__dboRobEntries(a, t);
const act = (a, t) => { out.personal.length = 0; globalThis.__dboRobAction(a, 'rob', t, nameFor); return out.personal.map((x) => `${x.a.toString(16)}:${x.t}`).join(' | '); };
const answer = (a, nonce, choice) => { out.personal.length = 0; handlers.get('robAnswer')(a, [nonce, choice]); return out.personal.map((x) => `${x.a.toString(16)}:${x.t}`).join(' | '); };

// Rob on the menu whether or not the victim's UI has the panel (review C2)
check('Rob is offered even when the target\'s UI has no panel', menu(ROBBER, VICTIM).length === 1);
handlers.get('uiCaps')(VICTIM, ['bank', 'robPrompt']);
check('Rob for a target with the panel', menu(ROBBER, VICTIM).length === 1 && menu(ROBBER, VICTIM)[0].id === 'rob');
check('no Rob from far away', menu(FAR, VICTIM).length === 0);
handlers.get('uiCaps')(FRIEND, ['robPrompt']);
check('no Rob inside your own party', menu(ROBBER, FRIEND).length === 0);
set(ROBBER, 'private.beast', { form: 'werewolf' });
check('no Rob in beast form', menu(ROBBER, VICTIM).length === 0);
set(ROBBER, 'private.beast', null);

// The demand opens the victim's panel; nothing to type
act(ROBBER, VICTIM);
const w = out.widgets[out.widgets.length - 1];
check('the victim gets the panel (widget 49), focused, with the robber by the name they know', w.a === VICTIM && w.w.type === 'robPrompt' && w.w.id === 49 && w.focus === true && w.w.robber === 'Stranger' && w.w.seconds === 20, JSON.stringify(w));
check('the victim is told nothing in chat to type', !out.personal.some((x) => x.a === VICTIM && /\//.test(x.t)));
check('no second robbery while one is under way', menu(ROBBER, VICTIM).length === 0);

// Accept: 15% gold, 3 things one each, none of them worn, no key at the normal roll
let r = answer(VICTIM, w.w.nonce, 'accept');
check('accept takes 15% of the gold', count(VICTIM, GOLD) === 850 && count(ROBBER, GOLD) === 155, r);
const taken = [DAGGER, BREAD, STRIPS].filter((id) => count(ROBBER, id) === 1);
check('accept takes 3 things, one of each', taken.length === 3 && count(VICTIM, BREAD) === 3 && count(VICTIM, STRIPS) === 1 && count(VICTIM, DAGGER) === 0, r);
check('nothing worn is taken (the helmet, the equipped arrows)', count(VICTIM, HELM) === 1 && count(VICTIM, ARROW) === 20 && count(ROBBER, HELM) === 0);
check('no key at an ordinary roll', count(VICTIM, KEY) === 1 && count(ROBBER, KEY) === 0);
check('both are told what changed hands', /You take 150 gold, .* from Lydia/.test(r) && /Stranger takes 150 gold, .* from you/.test(r), r);
check('the panel closes', out.closed.some((c) => c.a === VICTIM && c.id === 49));
check('it is audited', /^ROBBERY P14 robbed P15: 150 gold of 1000; items \[/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);

// The waits
handlers.get('uiCaps')(FAR, ['robPrompt']); set(FAR, 'pos', [0, 0, 0]);
check('the robber waits before robbing anyone else', menu(ROBBER, FAR).length === 0 && /robbed someone moments ago/.test(act(ROBBER, FAR)));
set(FAR, 'pos', [5000, 0, 0]);
now += 11 * 60000;
check('the victim is left alone for a while', menu(ROBBER, VICTIM).length === 0);
now += 20 * 60000;
check('after the waits Rob comes back', menu(ROBBER, VICTIM).length === 1);

// A key at the key chance
reset(); random = 0.0001;
act(ROBBER, VICTIM);
answer(VICTIM, out.widgets[out.widgets.length - 1].w.nonce, 'accept');
check('a key goes at the 0.05% roll', count(ROBBER, KEY) === 1 && count(VICTIM, KEY) === 0);
random = 0.5; now += 31 * 60000;

// Fight/Flee: resists; the robber can finish on a downed victim, with no prompt
reset();
act(ROBBER, VICTIM);
r = answer(VICTIM, out.widgets[out.widgets.length - 1].w.nonce, 'fight');
check('fight/flee takes nothing and tells the robber', count(VICTIM, GOLD) === 1000 && /Lydia refuses/.test(r), r);
check('the robber cannot simply ask again', menu(ROBBER, VICTIM).length === 0);
downedSet.add(VICTIM); set(VICTIM, 'isDead', true);
check('a downed victim who refused can be robbed', menu(ROBBER, VICTIM).length === 1);
const widgetsBefore = out.widgets.length;
act(ROBBER, VICTIM);
check('with no prompt', out.widgets.length === widgetsBefore && count(VICTIM, GOLD) === 850);
downedSet.clear(); set(VICTIM, 'isDead', false); now += 31 * 60000;

// Silence: resists
reset();
act(ROBBER, VICTIM);
out.personal.length = 0; now += 21000; timers.get('robbery')();
check('no answer in 20 s counts as fight/flee', count(VICTIM, GOLD) === 1000 && out.personal.some((x) => x.a === ROBBER && /gives no answer/.test(x.t)) && out.closed.filter((c) => c.a === VICTIM).length >= 3);
now += 31 * 60000;

// Accept after the robber left: nothing changes hands
reset();
act(ROBBER, VICTIM);
const n = out.widgets[out.widgets.length - 1].w.nonce;
set(ROBBER, 'pos', [9000, 0, 0]);
r = answer(VICTIM, n, 'accept');
check('if the robber walked off, nothing is taken', count(VICTIM, GOLD) === 1000 && /gone before you hand anything over/.test(r), r);
set(ROBBER, 'pos', [0, 0, 0]); now += 31 * 60000;

// A stale answer is ignored; a failed write duplicates nothing
reset();
act(ROBBER, VICTIM);
answer(VICTIM, 'stale', 'accept');
check('a stale panel answer is ignored', count(VICTIM, GOLD) === 1000);
failSetFor = ROBBER;
answer(VICTIM, out.widgets[out.widgets.length - 1].w.nonce, 'accept');
check('a failed write to the robber puts the victim\'s things back', count(VICTIM, GOLD) === 1000 && count(VICTIM, DAGGER) === 1 && count(ROBBER, GOLD) === 5);
failSetFor = 0;

// A hot reload keeps the waits and pending robberies
now += 31 * 60000; reset();
act(ROBBER, VICTIM);
const n2 = out.widgets[out.widgets.length - 1].w.nonce;
load();
answer(VICTIM, n2, 'accept');
check('an answer after a hot reload still counts', count(VICTIM, GOLD) === 850);

// A target whose UI cannot draw the panel cannot answer: it counts as Fight/Flee at once (review C2)
now += 31 * 60000; reset();
S_caps_clear();
const widgetsNoPanel = out.widgets.length;
r = act(ROBBER, VICTIM);
check('no panel: no widget, and both are told it is Fight/Flee', out.widgets.length === widgetsNoPanel && /will not hand it over/.test(r) && /demands your coin\. You stand your ground/.test(r), r);
check('the contest is on, so downing them lets the robber take it', (() => { downedSet.add(VICTIM); act(ROBBER, VICTIM); downedSet.delete(VICTIM); return count(VICTIM, GOLD) === 850; })());
check('it is audited as a refusal', out.audits.some((t) => /no panel on their UI \(resists\)/.test(t)));

// Only the robber who brought the victim down takes it (m2); no demand mid-fight (m3); Escape answers (C5)
now += 31 * 60000; reset();
handlers.get('uiCaps')(VICTIM, ['robPrompt']);
act(ROBBER, VICTIM);
answer(VICTIM, out.widgets[out.widgets.length - 1].w.nonce, 'fight');
downedSet.add(VICTIM); downer = FRIEND;
r = act(ROBBER, VICTIM);
check('a victim someone else brought down is not the robber\'s take (m2)', count(VICTIM, GOLD) === 1000 && /Someone else brought them down/.test(r), r);
downer = 0; downedSet.delete(VICTIM);
now += 31 * 60000; reset();
globalThis.__dboPvpAt = new Map([[VICTIM, now - 5000]]);
check('no demand in the middle of a fight (m3)', menu(ROBBER, VICTIM).length === 0 && /middle of a fight/.test(act(ROBBER, VICTIM)));
globalThis.__dboPvpAt = new Map();
act(ROBBER, VICTIM);
out.personal.length = 0;
handlers.get('close')(VICTIM, [], 49);
check('Escape on the panel answers Fight/Flee at once (C5)', !globalThis.__dboRobbery.pending.has(VICTIM) && out.personal.some((x) => x.a === ROBBER && /refuses/.test(x.t)));
now += 31 * 60000; reset();
act(ROBBER, VICTIM);
set(ROBBER, 'pos', [9000, 0, 0]);
answer(VICTIM, out.widgets[out.widgets.length - 1].w.nonce, 'accept');
set(ROBBER, 'pos', [0, 0, 0]);
check('a robber who stepped away before the answer still waits before demanding again (m3)', /robbed someone moments ago/.test(act(ROBBER, VICTIM)));
globalThis.__dboRobLeave(VICTIM);
check('a UI\'s panels are forgotten when its player leaves (C6)', !globalThis.__dboRobbery.caps.has(VICTIM));

// Never a worn copy, even when a second copy of it sits in its own stack (review M2)
now += 31 * 60000; reset();
handlers.get('uiCaps')(VICTIM, ['robPrompt']);
set(VICTIM, 'inventory', { entries: [{ baseId: GOLD, count: 10 }, { baseId: HELM, count: 1, worn: true }, { baseId: HELM, count: 1 }, { baseId: DAGGER, count: 1 }] });
set(VICTIM, 'equipment', { inv: { entries: [{ baseId: HELM, count: 1, worn: true }] } });
act(ROBBER, VICTIM);
answer(VICTIM, out.widgets[out.widgets.length - 1].w.nonce, 'accept');
const inv = get(VICTIM, 'inventory').entries;
check('the spare helmet may go, the worn one stays', inv.some((e) => e.baseId === HELM && e.worn && e.count === 1) && count(ROBBER, HELM) <= 1 && count(VICTIM, HELM) + count(ROBBER, HELM) === 2, JSON.stringify(inv));
check('one of each kind at most', count(ROBBER, HELM) <= 1 && count(ROBBER, DAGGER) <= 1);

// An open trade: no Rob on either trader, and a stale click is refused in character (trade-robbery-guard)
now += 120 * 60000; reset();
handlers.get('uiCaps')(VICTIM, ['robPrompt']);
const trading = new Set();
globalThis.__alduinakInTrade = (a) => trading.has(a >>> 0);
check('Rob is offered when nobody is trading', menu(ROBBER, VICTIM).length === 1);
trading.add(VICTIM);
check('no Rob on a player whose trade window is open', menu(ROBBER, VICTIM).length === 0);
const tradeWidgets = out.widgets.length;
check('a stale Rob on them is refused in character, with no panel and nothing taken', /^14:They are in the middle of a trade/.test(act(ROBBER, VICTIM)) && out.widgets.length === tradeWidgets && count(VICTIM, GOLD) === 1000);
trading.clear(); trading.add(ROBBER);
check('no Rob from a player whose own trade window is open', menu(ROBBER, VICTIM).length === 0 && /^14:Finish your trade first/.test(act(ROBBER, VICTIM)));
trading.clear();
check('Rob comes back when the trade closes (the refusal started no wait)', menu(ROBBER, VICTIM).length === 1);
globalThis.__alduinakInTrade = () => { throw new Error('boom'); };
check('a failing trade hook blocks nothing', menu(ROBBER, VICTIM).length === 1);
delete globalThis.__alduinakInTrade;
check('a server without the hook blocks nothing', menu(ROBBER, VICTIM).length === 1);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
