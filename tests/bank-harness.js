// Scripted test for server\bank.js with a mock gamemode api: the TheBank activator opens the bank (the panel only for a UI
// that said it has one, chat otherwise), deposits and withdrawals move gold and balance together and refuse bad amounts,
// the balance lives on the character and is the same at every bank, you must still stand at the bank, a ruler and a
// faction leader can pay into their treasuries and nobody can take out, bank.json is written for landless factions, stale
// windows are ignored, and a hot reload keeps everything. No server and no game: run it from this folder's parent with
//
//   node tests\bank-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const BANK = path.resolve(__dirname, '..', 'bank.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-harness-')));

const GOLD = 0xf;
const BANK_BASE = 0x0b000005, CHEST = 0x02079b22, BANK_BRUMA = 0xff000501, BANK_FALK = 0xff000502, TABLE = 0xff000503;
const COUNT = 0x14, GUILDMASTER = 0x15, PEASANT = 0x16;
const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const inv = (id, gold) => set(id, 'inventory', { entries: gold ? [{ baseId: GOLD, count: gold }] : [] });
const goldOf = (id) => ((get(id, 'inventory') || {}).entries || []).filter((e) => e.baseId === GOLD).reduce((s, e) => s + e.count, 0);
inv(COUNT, 5000); inv(GUILDMASTER, 3000); inv(PEASANT, 100); inv(CHEST, 10000);
set(BANK_BRUMA, 'baseDesc', '5:DragonBreak.esp'); set(BANK_FALK, 'baseDesc', '5:DragonBreak.esp'); set(TABLE, 'baseDesc', '1234:Skyrim.esm');
let near = new Set([`${COUNT}|${BANK_BRUMA}`, `${GUILDMASTER}|${BANK_BRUMA}`, `${PEASANT}|${BANK_BRUMA}`]);

const out = { personal: [], widgets: [], closed: 0, audits: [] };
const handlers = new Map();
let failTake = false, failGive = false, failTreasury = false;
const zones = { bruma: { id: 'bruma', name: 'Bruma', treasury: '79b22:BSHeartland.esm' }, falkreath: { id: 'falkreath', name: 'Falkreath', treasury: null } };
globalThis.__dboGuildsOf = (a) => (a === GUILDMASTER ? [{ id: 'fighters-guild', name: 'Fighters Guild', role: 'leader', zone: '' }, { id: 'county-bruma', name: 'County of Bruma', role: 'member', zone: 'bruma' }] : a === COUNT ? [{ id: 'county-bruma', name: 'County of Bruma', role: 'leader', zone: 'bruma' }] : []);
const api = {
  mp: {
    get, set,
    getIdFromDesc: (d) => ({ '5:DragonBreak.esp': BANK_BASE, '79b22:BSHeartland.esm': CHEST, '1234:Skyrim.esm': 0x1234 }[d] || 0),
  },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), audit: (t) => out.audits.push(t), who: (a) => `P${a.toString(16)}`, cfg: {},
  openWidget: (a, w) => out.widgets.push({ a, w }), closeWidget: () => { out.closed++; },
  onUi: (ev, fn) => handlers.set(ev, fn), registerChatCommand: (n, fn) => handlers.set('/' + n, fn),
  takeGold: (a, n) => { if (failTake || goldOf(a) < n) return false; inv(a, goldOf(a) - n); return true; },
  giveItem: (a, base, n) => { if (failGive) return false; inv(a, goldOf(a) + n); return true; },
  goldOf,
  depositToTreasury: (zid, n) => { if (failTreasury || zid !== 'bruma') return 0; inv(CHEST, goldOf(CHEST) + n); return n; },
  zoneById: (id) => zones[id] || null, zoneOfActor: () => 'bruma',
  ranksOf: (pid) => (pid === 1 ? [{ zone: zones.bruma, rank: 'count' }] : pid === 3 ? [{ zone: zones.bruma, rank: 'steward' }] : []),
  profileOf: (a) => ({ [COUNT]: 1, [GUILDMASTER]: 2, [PEASANT]: 3 }[a] || -1),
  distanceMeters: (a, b) => (near.has(`${a}|${b}`) ? 2 : 50),
};
const load = () => { handlers.clear(); delete require.cache[BANK]; return require(BANK)(api); };
load();

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const last = () => out.personal[out.personal.length - 1].t;
const cmd = (a, args) => { out.personal.length = 0; handlers.get('/bank')(a, args); return out.personal.map((x) => x.t).join(' | '); };
const activate = (a, ref) => globalThis.__dboBankActivate(ref, a);

// Activation: only the bank, chat for a UI without the panel
check('another object is not a bank', activate(PEASANT, TABLE) === false);
out.personal.length = 0;
check('the bank activator is taken', activate(PEASANT, BANK_BRUMA) === true);
check('an old UI gets the chat bank, no widget', out.widgets.length === 0 && /Bank: your balance is 0 gold, and you carry 100/.test(out.personal[0].t), out.personal[0] && out.personal[0].t);

// Deposit and withdraw through chat
check('deposit moves gold into the account', /Deposited 60 gold\. Your balance is 60/.test(cmd(PEASANT, 'deposit 60')) && goldOf(PEASANT) === 40 && get(PEASANT, 'private.bankGold') === 60);
check('more than you carry is refused', /carry only 40/.test(cmd(PEASANT, 'deposit 41')) && goldOf(PEASANT) === 40);
check('nonsense amounts are refused', /whole number/.test(cmd(PEASANT, 'deposit -5')) && /whole number/.test(cmd(PEASANT, 'deposit 1.5')) && /whole number/.test(cmd(PEASANT, 'deposit lots')));
check('deposit all', /Deposited 40 gold\. Your balance is 100/.test(cmd(PEASANT, 'deposit all')) && goldOf(PEASANT) === 0);
check('withdraw', /Withdrew 30 gold\. Your balance is 70/.test(cmd(PEASANT, 'withdraw 30')) && goldOf(PEASANT) === 30);
check('more than the balance is refused', /balance is only 70/.test(cmd(PEASANT, 'withdraw 71')));
failTake = true;
check('if the gold cannot be taken nothing changes', /could not take your gold/.test(cmd(PEASANT, 'deposit 10')) && goldOf(PEASANT) === 30 && get(PEASANT, 'private.bankGold') === 70);
failTake = false; failGive = true;
check('if the gold cannot be handed over the balance is put back', /balance is unchanged/.test(cmd(PEASANT, 'withdraw 10')) && get(PEASANT, 'private.bankGold') === 70 && goldOf(PEASANT) === 30);
failGive = false;
check('every transaction is audited', out.audits.filter((t) => /^BANK P16 (deposited|withdrew)/.test(t)).length === 3, out.audits.join(' / '));
check('the history is kept on the character', (get(PEASANT, 'private.bankLog') || []).map((h) => h.kind).join(',') === 'deposit,deposit,withdraw');

// Being at the bank
near.delete(`${PEASANT}|${BANK_BRUMA}`);
check('walking away closes the bank', /not at a bank/.test(cmd(PEASANT, 'withdraw 10')) && goldOf(PEASANT) === 30);
check('/bank away from a bank still shows the balance', /balance is 70 gold/.test(cmd(PEASANT, '')));
near.add(`${PEASANT}|${BANK_FALK}`);
activate(PEASANT, BANK_FALK);
check('the same account at another town\'s bank', /Withdrew 70 gold\. Your balance is 0/.test(cmd(PEASANT, 'withdraw all')) && goldOf(PEASANT) === 100);

// Treasuries: the Count pays in, a peasant and a steward have none, no withdrawal exists
check('a peasant answers for no treasury', /no such treasury/.test(cmd(PEASANT, 'treasury bruma 10')));
activate(COUNT, BANK_BRUMA);
check('the Count sees the Bruma treasury in chat', out.personal.some((x) => x.a === COUNT && /Bruma treasury: 10000 gold \(you rule it\)/.test(x.t)));
check('the Count pays into the Bruma treasury', /Paid 500 gold into the Bruma treasury\. No one can take it out/.test(cmd(COUNT, 'treasury bruma 500')) && goldOf(CHEST) === 10500 && goldOf(COUNT) === 4500);
failTreasury = true;
check('a treasury that refuses gold hands it back', /returned to you/.test(cmd(COUNT, 'treasury bruma 100')) && goldOf(COUNT) === 4500 && goldOf(CHEST) === 10500);
failTreasury = false;
const mod = load();
check('a ruler and a hold faction leader see one Bruma treasury, not two', mod.treasuriesOf(COUNT).length === 1);
activate(GUILDMASTER, BANK_BRUMA);
check('a guild leader sees their landless faction treasury, not the hold they are only a member of', mod.treasuriesOf(GUILDMASTER).map((t) => t.key).join(',') === 'faction:fighters-guild');
check('pays into it by name', /Paid 1000 gold into the Fighters Guild treasury/.test(cmd(GUILDMASTER, 'treasury fighters 1000')) && goldOf(GUILDMASTER) === 2000);
check('bank.json holds the faction treasury', JSON.parse(fs.readFileSync('bank.json', 'utf8')).factions['fighters-guild'] === 1000);
const chestBefore = goldOf(CHEST), gmGold = goldOf(GUILDMASTER);
cmd(GUILDMASTER, 'withdraw 500'); cmd(GUILDMASTER, 'treasury fighters -500'); cmd(COUNT, 'withdraw 500');
check('there is no way to take gold out of a treasury: withdraw uses only your own balance, negative pay-ins are refused',
  goldOf(CHEST) === chestBefore && JSON.parse(fs.readFileSync('bank.json', 'utf8')).factions['fighters-guild'] === 1000 && goldOf(GUILDMASTER) === gmGold);
check('the panel has no treasury withdrawal event, and the module exports none',
  [...handlers.keys()].sort().join(',') === '/bank,bankClose,bankDeposit,bankTreasury,bankWithdraw,uiCaps' && Object.keys(mod).sort().join(',') === 'balanceOf,deposit,payIn,treasuriesOf,withdraw');

// The panel, for a UI that has it
handlers.get('uiCaps')(COUNT, ['bank']);
out.widgets.length = 0;
activate(COUNT, BANK_BRUMA);
const w = out.widgets[0] && out.widgets[0].w;
check('a UI with the panel gets widget 48', !!w && w.type === 'bank' && w.id === 48 && w.balance === 0 && w.carried === 4500 && w.where === 'Bruma' && w.treasuries.length === 1 && w.treasuries[0].balance === 10500, JSON.stringify(w));
handlers.get('bankDeposit')(COUNT, [w.nonce, '1000']);
const w2 = out.widgets[out.widgets.length - 1].w;
check('a deposit from the panel answers in the panel', w2.balance === 1000 && w2.resultKind === 'ok' && /Deposited 1000/.test(w2.result));
handlers.get('bankWithdraw')(COUNT, ['stale-nonce', '1000']);
check('a stale window is ignored', get(COUNT, 'private.bankGold') === 1000);
handlers.get('bankTreasury')(COUNT, [w2.nonce, 'zone:bruma', 'all']);
check('treasury pay-in from the panel', goldOf(COUNT) === 0 && goldOf(CHEST) === 14000, `${goldOf(COUNT)} ${goldOf(CHEST)}`);
handlers.get('bankClose')(COUNT, []);
check('closing clears the window', out.closed === 1);

// A hot reload keeps who stands where, the panels, and the balances
load();
check('after a reload the Count is still at the bank and still has the panel', /Withdrew 500 gold/.test(cmd(COUNT, 'withdraw 500')) && out.widgets.length > 2);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
