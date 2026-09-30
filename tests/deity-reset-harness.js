// Staff reset of a character's god (Nate 2026-09-30: "an admin command to reset someone's deity so they can choose
// again"). Loads the real prayer.js with the real skills.json deities against a stub api:
//   - /deity reset <player> and the admin panel's dbo:deityReset clear the faith and its conversion clock, a blessing
//     (its spell taken back), an offering, the shrine rests and a prayer in flight, and nothing else
//   - Lead GM and above only; a GM and a player are refused and the refusal is audited
//   - offline characters by #TAG; an unreachable record, an ambiguous name and a character with no god are answered
//   - the old faith is kept in private.dboDeityHistory; the audit line names who, whom and what
// node tests/deity-reset-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const store = new Map();
const said = [], audits = [], packets = [], widgets = [], closed = [], papyrus = [];
const ui = {}, cmds = {};
let online = [];
const noop = () => {};
const SKILLS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'skills.json'), 'utf8'));
const LEAD = 1, GM = 2, PLAYER = 3, WORSHIPPER = 10, OFFLINE = 11, BROKEN = 12, PLAIN = 13;
const TAGS = { [OFFLINE]: 'off1', [WORSHIPPER]: 'wor1', [PLAIN]: 'pln1' };
const mp = {
  get: (id, p) => { if (id === BROKEN) throw new Error('form not loaded'); return store.get(`${id}|${p}`); },
  set: (id, p, v) => { if (id === BROKEN) throw new Error('form not loaded'); store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
  callPapyrusFunction: (kind, cls, method, self, args) => { papyrus.push([method, self && self.desc, args && args[0] && args[0].desc]); return null; },
  lookupEspmRecordById: () => null,
};
const findAnyByName = (q) => {
  const s = String(q).trim().toLowerCase();
  const m = s.match(/#([a-z0-9]{4})$/);
  if (m) { const hit = Object.keys(TAGS).find((k) => TAGS[k] === m[1]); return hit ? Number(hit) : 0; }
  if (s === 'twin') return -2;
  if (s === 'broken') return BROKEN;
  if (s === 'vaeric') return WORSHIPPER;
  if (s === 'plain') return PLAIN;
  return 0;
};
require(path.resolve(__dirname, '..', 'prayer.js'))({
  mp, log: noop, audit: (t) => audits.push(t), personal: (a, t) => said.push({ a, t }), display: (a) => `P${a}`, who: (a) => `W${a}`, cfg: {},
  openWidget: (a, w) => { widgets.push([a, w]); return true; }, closeWidget: (a, id) => closed.push([a, id]),
  onUi: (n, f) => { ui[n] = f; }, registerChatCommand: (n, f) => { cmds[n] = f; }, onlineActors: () => online, every: noop, skills: SKILLS,
  takeGold: () => true, treasuryHere: () => 0,
  isLeadStaff: (a) => a === LEAD, findAnyByName, sendPacket: (a, p) => packets.push([a, p]),
});

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 300)}`); if (!c) fail++; };
const heard = (a, re) => said.some((s) => s.a === a && re.test(s.t));
const get = (a, p) => store.get(`${a}|${p}`);
const deity = SKILLS.deities.choices.find((d) => d.id === 'talos') || SKILLS.deities.choices[0];
const BLESS = 0xfb988;
const worship = (a) => {
  store.set(`${a}|private.dboDeity`, { id: deity.id, name: deity.name, kind: deity.kind, at: Date.now() - 86400000, convertedAt: Date.now() - 3600000, warnedUnlawful: true });
  store.set(`${a}|private.dboBlessing`, { deity: deity.id, spell: BLESS, until: Date.now() + 3600000 });
  store.set(`${a}|private.dboOffering`, { deityId: deity.id, gold: 50, until: Date.now() + 600000 });
  store.set(`${a}|private.prayedShrines`, { abc: Date.now() + 600000 });
  store.set(`${a}|private.supernatural`, { kind: 'vampire', stage: 2 });
  store.set(`${a}|inventory`, { entries: [{ baseId: 0xf, count: 400 }] });
  store.set(`${a}|private.indexed.tagKey`, TAGS[a] || 'xxxx');
};
worship(WORSHIPPER); worship(OFFLINE);
online = [LEAD, GM, PLAYER, WORSHIPPER];
globalThis.__dboPrayerRounds.set(WORSHIPPER, { nonce: 'n1', deityId: deity.id });

// ---- who may ---------------------------------------------------------------------------------------------------
cmds.deity(GM, 'reset vaeric');
ok(heard(GM, /Lead GM and above/) && get(WORSHIPPER, 'private.dboDeity'), 'a GM is refused (and nothing changes)');
ok(audits.some((t) => /W2 was refused a deity reset/.test(t)), 'the refusal is audited');
ui.deityReset(PLAYER, ['a', 'vaeric']);
ok(packets.some(([a, p]) => a === PLAYER && p.customPacketType === 'adminActionResult' && p.ok === false) && get(WORSHIPPER, 'private.dboDeity'), 'a player sending the panel event is refused');

// ---- the reset -----------------------------------------------------------------------------------------------------
said.length = 0; papyrus.length = 0; audits.length = 0;
cmds.deity(LEAD, 'reset vaeric');
ok(!get(WORSHIPPER, 'private.dboDeity'), 'the faith is gone, and with it the conversion clock');
ok(!get(WORSHIPPER, 'private.dboBlessing') && papyrus.some(([m, , spell]) => m === 'RemoveSpell' && spell === `${BLESS.toString(16)}:Skyrim.esm`), "the blessing is lifted and its spell taken back");
ok(!get(WORSHIPPER, 'private.dboOffering') && Object.keys(get(WORSHIPPER, 'private.prayedShrines') || {}).length === 0, 'the offering and the shrine rests are cleared');
ok(!globalThis.__dboPrayerRounds.has(WORSHIPPER) && closed.some(([a, id]) => a === WORSHIPPER && id === 35), 'a prayer in flight is ended and its panel closed');
ok(JSON.stringify(get(WORSHIPPER, 'private.supernatural')) === '{"kind":"vampire","stage":2}' && get(WORSHIPPER, 'inventory').entries[0].count === 400, 'the curse and the gold are left alone');
const hist = get(WORSHIPPER, 'private.dboDeityHistory');
ok(Array.isArray(hist) && hist.length === 1 && hist[0].id === deity.id && hist[0].resetBy === 'W1', 'the old faith is kept in the history, with who reset it', hist);
ok(heard(WORSHIPPER, /set your faith aside\. You may choose a god again/), 'the player is told in game');
ok(heard(LEAD, new RegExp(`P10: cleared ${deity.name}, with its conversion clock; the blessing of ${deity.name}; an offering of 50 gold; the shrine rests; a prayer in progress\\. They were told\\.`)), 'the staff member is told what was cleared', said.filter((s) => s.a === LEAD));
ok(audits.some((t) => new RegExp(`^DEITY W1 reset W10: ${deity.name}`).test(t)), 'the audit line names who, whom and what', audits);
widgets.length = 0;
globalThis.__dboDeityPicker(WORSHIPPER);
const picker = widgets.find(([a, w]) => a === WORSHIPPER && w.type === 'deityPicker');
ok(picker && picker[1].canChoose === true && picker[1].first === true && picker[1].current === '', 'the deity menu lets them choose again at once', picker && picker[1]);

// ---- offline, unreachable, ambiguous, nothing to do ---------------------------------------------------------------
said.length = 0;
cmds.deity(LEAD, 'reset Somebody #off1');
ok(!get(OFFLINE, 'private.dboDeity') && heard(LEAD, /offline and will be offered the choice when they return/), 'an offline character is reset by #TAG');
ok(!said.some((s) => s.a === OFFLINE), 'and nobody tries to tell an offline player');
said.length = 0;
cmds.deity(LEAD, 'reset broken');
ok(heard(LEAD, /record cannot be reached/), 'an unreachable record is said to be unreachable');
cmds.deity(LEAD, 'reset twin');
ok(heard(LEAD, /2 characters are called "twin"\. Use their #TAG/), 'an ambiguous name asks for the #TAG');
cmds.deity(LEAD, 'reset nobody');
ok(heard(LEAD, /No character matches "nobody"/), 'an unknown name is said so');
store.set(`${PLAIN}|private.indexed.tagKey`, 'pln1');
cmds.deity(LEAD, 'reset plain');
ok(heard(LEAD, /P13 follows no god; nothing to reset/), 'a character with no god is left alone');
cmds.deity(LEAD, 'reset');
ok(heard(LEAD, /Usage: \/deity reset/), 'no name gives the usage');

// ---- the panel -----------------------------------------------------------------------------------------------------
worship(WORSHIPPER);
packets.length = 0;
ui.deityReset(LEAD, [WORSHIPPER.toString(16), 'Vaeric']);
const res = packets.find(([a, p]) => a === LEAD && p.customPacketType === 'adminActionResult');
ok(res && res[1].ok === true && /cleared/.test(res[1].text) && !get(WORSHIPPER, 'private.dboDeity'), "the panel's button resets the live character and answers in the panel", res && res[1]);
worship(OFFLINE);
packets.length = 0;
ui.deityReset(LEAD, ['', 'Somebody #off1']);
ok(packets.some(([a, p]) => a === LEAD && p.ok === true) && !get(OFFLINE, 'private.dboDeity'), 'an offline row (no live actor) is found by its name');

// ---- the player's own /deity still works ----------------------------------------------------------------------------
said.length = 0;
cmds.deity(PLAYER, 'reset');
ok(heard(PLAYER, /Lead GM and above/), 'a player typing /deity reset is refused');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
