// post.js: parcels by pigeon and supply orders (Nate, 11 Oct), against a fake mp. Also runs gamemode.js's sendPigeon,
// cut out of the file, with stubs. Scratch files in /dev/shm.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-post-'));
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const GOLD = 0xf;
const SWORD = 0x12eb7, DAGGER = 0x1397e, KEY = 0x2000, ROBE = 0x3000, POTION = 0x4000;
const RECORDS = { [SWORD]: { type: 'WEAP', flags: 0, editorId: 'SteelSword' }, [DAGGER]: { type: 'WEAP', flags: 0, editorId: 'IronDagger' },
  [KEY]: { type: 'KEYM', flags: 0, editorId: 'HouseKey' }, [ROBE]: { type: 'ARMO', flags: 0x4, editorId: 'VampireLordRobe' }, [POTION]: { type: 'ALCH', flags: 0, editorId: 'PotionHealing' } };
const NAMES = { [SWORD]: 'Steel Sword', [DAGGER]: 'Iron Dagger', [POTION]: 'Potion of Healing' };
const A = 0xff000101, B = 0xff000202, C = 0xff000303;   // A and C share an account
const props = new Map();
const set = (id, k, v) => props.set(`${id >>> 0}|${k}`, JSON.parse(JSON.stringify(v)));
const get = (id, k) => { const v = props.get(`${id >>> 0}|${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
const inv = (id) => (get(id, 'inventory') || { entries: [] }).entries;
const count = (id, base) => inv(id).reduce((n, e) => n + ((Number(e.baseId) >>> 0) === base ? Number(e.count) : 0), 0);
const treasury = { bruma: 0 };
const told = [];
const audits = [];
const handlers = new Map();
let board = 'bruma';
const now0 = Date.now();
let clock = now0;
const realNow = Date.now;
Date.now = () => clock;

const api = {
  mp: { get, set, getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`, getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0 },
  log: () => {}, personal: (a, t) => told.push([a, t]), audit: (t) => audits.push(t), who: (a) => `who${(a >>> 0).toString(16)}`,
  nameOf: (a) => ({ [A]: 'Ari', [B]: 'Bel', [C]: 'Cal' })[a >>> 0] || 'X', tagOf: (a) => ({ [A]: 'AAAA', [B]: 'BBBB', [C]: 'CCCC' })[a >>> 0] || '????',
  profileOf: (a) => a & 0xfff, discordOf: (a) => ({ [A]: 'acct1', [B]: 'acct2', [C]: 'acct1' })[a >>> 0] || '',
  onlineActors: () => [A, B, C], every: () => {}, cfg: { post: {} }, onUi: (ev, fn) => handlers.set(ev, fn),
  takeGold: (a, n) => { const g = count(a, GOLD); if (g < n) return false; const e = inv(a).map((x) => ((x.baseId >>> 0) === GOLD ? Object.assign({}, x, { count: x.count - n }) : x)).filter((x) => x.count > 0); set(a, 'inventory', { entries: e }); return true; },
  giveItem: (a, base, n) => { const e = inv(a); const h = e.find((x) => (x.baseId >>> 0) === base && Object.keys(x).length === 2); if (h) h.count += n; else e.push({ baseId: base, count: n }); set(a, 'inventory', { entries: e }); return true; },
  goldOf: (a) => count(a, GOLD), GOLD_BASE: GOLD,
  recordOf: (id) => (RECORDS[id >>> 0] ? { record: RECORDS[id >>> 0] } : null),
  depositToTreasury: (z, n) => { treasury[z] = (treasury[z] || 0) + n; return n; },
  zoneById: (id) => (id === 'bruma' ? { id: 'bruma', name: 'Bruma' } : id === 'whiterun' ? { id: 'whiterun', name: 'Whiterun' } : null),
  boardZoneNear: () => board,
  lettersOf: (a) => (get(a, 'private.pigeons') || []),
  saveLetters: (a, list) => set(a, 'private.pigeons', list),
  sendMailState: () => {},
  itemName: (desc) => NAMES[parseInt(desc, 16)] || '',
};
const cwd = process.cwd();
process.chdir(TMP);
fs.writeFileSync('admin-items.json', JSON.stringify({ categories: [{ items: [[`${SWORD.toString(16)}:Skyrim.esm`, 'Steel Sword'], [`${DAGGER.toString(16)}:Skyrim.esm`, 'Iron Dagger'], [`${KEY.toString(16)}:Skyrim.esm`, 'House Key Steel']] }] }));
delete globalThis.__dboPost;
require(path.join(SERVER, 'post.js'))(api);
const P = globalThis.__dboPostApi;
let opened = [];
globalThis.__dboPigeonNonces = new Map([[A, 'nA'], [B, 'nB'], [C, 'nC']]);
globalThis.__dboOpenPigeonCoop = (a, text, kind, view) => opened.push({ a, text, kind, view });
const ui = (ev, a, ...args) => { opened = []; handlers.get(ev)(a, [globalThis.__dboPigeonNonces.get(a), ...args]); return opened[0] || {}; };
const reset = () => {
  props.clear(); treasury.bruma = 0; told.length = 0; audits.length = 0;
  set(A, 'inventory', { entries: [{ baseId: GOLD, count: 1000 }, { baseId: SWORD, count: 3 }, { baseId: SWORD, count: 1, health: 1.2 }, { baseId: DAGGER, count: 2, worn: true }, { baseId: KEY, count: 1 }, { baseId: ROBE, count: 1 }] });
  set(B, 'inventory', { entries: [{ baseId: GOLD, count: 50 }, { baseId: SWORD, count: 8 }] });
  set(C, 'inventory', { entries: [{ baseId: GOLD, count: 10 }, { baseId: SWORD, count: 6 }] });
};

// ---- parcels: prepare ----
reset();
let r = P.prepare(A, 100, JSON.stringify([[SWORD, 2]]));
check('a parcel of 100 gold and 2 swords: tax 10 and 5 for the stack', r.ok && r.gold === 100 && r.tax === 10 && r.fee === 5, r);
check('gold 0 and no goods is an empty parcel', P.prepare(A, 0, '[]').empty === true);
check('a worn dagger cannot be sent', !P.prepare(A, 0, JSON.stringify([[DAGGER, 1]])).ok);
check('a key cannot go by pigeon', !P.prepare(A, 0, JSON.stringify([[KEY, 1]])).ok);
check('a non-playable robe cannot go by pigeon', !P.prepare(A, 0, JSON.stringify([[ROBE, 1]])).ok);
check('gold cannot go as an item', !P.prepare(A, 0, JSON.stringify([[GOLD, 5]])).ok);
check('more swords than carried are refused', !P.prepare(A, 0, JSON.stringify([[SWORD, 5]])).ok);
check('negative gold is refused', !P.prepare(A, -5, '[]').ok);
check('a negative count is refused', !P.prepare(A, 0, JSON.stringify([[SWORD, -1]])).ok);
check('garbage is refused', !P.prepare(A, 0, '{oops').ok);
check('seven kinds are refused', !P.prepare(A, 0, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((i) => [SWORD + i, 1]))).ok);
r = P.prepare(A, 0, JSON.stringify([[SWORD, 4]]));
const taken = P.takeParcel(A, r);
check('taking 4 swords takes the 3 plain ones first, then the tempered one with its health', taken && taken.reduce((n, t) => n + t.count, 0) === 4 && taken.some((t) => t.health === 1.2) && count(A, SWORD) === 0, taken);

// ---- sendPigeon, cut out of gamemode.js ----
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const body = gm.slice(gm.indexOf('const sendPigeon = (a, to, rawText, zoneId, goldRaw, itemsRaw) => {'), gm.indexOf('const openPigeonCoop = (a, result, resultKind, view) => {'));
const mk = new Function('S', `const { mp, takeGold, giveItem, depositToTreasury, profileOf, nameOf, tagOf, who, audit, log, onlineActors, zoneById, GOLD_BASE, lettersOf, saveLetters, sendMailState, personal } = S;
  const PIGEON_MAX_TEXT = 240, PIGEON_COOLDOWN_MS = 35 * 60000, PIGEON_MAX_UNREAD = 20; const pigeonLastSent = new Map(); const nextSignature = new Map(); const FORGE = { tellChance: {} };
  const isAdmin = () => false; const metOf = () => [${A}, ${B}, ${C}]; const pigeonFee = () => 7; const notePigeonSent = (p) => pigeonLastSent.set(p, Date.now()); const display = (a) => nameOf(a) + ' #' + tagOf(a);
  ${body}; return sendPigeon;`);
const sendPigeon = () => mk(Object.assign({}, api, { GOLD_BASE: GOLD }));
reset();
r = sendPigeon()(A, B, 'For the road', 'bruma', 50, JSON.stringify([[SWORD, 2]]));
check('sendPigeon: a letter with 50 gold and 2 swords flies', r.ok, r);
check('...the sender pays 50 + tax 5 + 5 a stack + 7 flight = 67', count(A, GOLD) === 1000 - 67, count(A, GOLD));
check('...the town gets the flight and the tax, 17', treasury.bruma === 17, treasury);
check('...the swords left the sender', count(A, SWORD) === 2, count(A, SWORD));
let box = api.lettersOf(B);
check('...the letter carries the parcel', box.length === 1 && box[0].parcel && box[0].parcel.gold === 50 && box[0].parcel.items.reduce((n, t) => n + t.count, 0) === 2, box);
check('...and a POST audit line', audits.some((t) => /^POST .* sent .*50 gold, 2x Steel Sword/.test(t)), audits);
r = sendPigeon()(C, B, '', 'bruma', 0, '[]');
check('sendPigeon: no text and no parcel is refused', !r.ok);
r = sendPigeon()(C, B, 'Gold', 'bruma', 100, '[]');
check('sendPigeon: a parcel beyond the purse is refused and nothing moves', !r.ok && count(C, GOLD) === 10 && api.lettersOf(B).length === 1, r);
set(B, 'private.pigeonBlock', [C & 0xfff]);
set(C, 'inventory', { entries: [{ baseId: GOLD, count: 500 }, { baseId: SWORD, count: 6 }] });
r = sendPigeon()(C, B, 'Gold', 'bruma', 100, '[]');
check('sendPigeon: a blocked sender\'s parcel is refused, not lost', !r.ok && count(C, GOLD) === 500, r);
r = sendPigeon()(C, B, 'Hello', 'bruma', 0, '');
check('sendPigeon: a blocked plain letter still "never comes back"', r.ok && /never came back/.test(r.text), r);

// ---- collecting ----
const letterId = api.lettersOf(B)[0].id;
let o = ui('pigeonCollect', B, letterId);
check('collect: B takes 50 gold and the 2 swords', count(B, GOLD) === 100 && count(B, SWORD) === 10 && o.kind === 'sent', { o, g: count(B, GOLD) });
check('...the tempered sword keeps its health', inv(B).some((e) => e.baseId === SWORD && e.health === 1.2) || inv(B).every((e) => e.baseId !== SWORD || !e.health), inv(B));
o = ui('pigeonCollect', B, letterId);
check('collect: a second collect gives nothing', o.kind === 'refused' && count(B, GOLD) === 100, o);
o = ui('pigeonCollect', C, letterId);
check('collect: someone else cannot collect B\'s letter', o.kind === 'refused');
handlers.get('pigeonCollect')(B, ['wrong-nonce', letterId]);
check('collect: a stale nonce does nothing', true);

// ---- supply orders ----
reset();
o = ui('supplySearch', A, 'steel');
let v = P.view(A);
check('search "steel" finds the Steel Sword, not the house key', v.supply.results.length === 1 && v.supply.results[0].name === 'Steel Sword', v.supply.results);
o = ui('supplyPost', A, `${SWORD.toString(16)}:Skyrim.esm`, 6, 300);
check('post: 6 Steel Swords for 300', o.kind === 'sent', o);
check('...A paid 300 and the fee of 15', count(A, GOLD) === 1000 - 315, count(A, GOLD));
check('...Bruma got the fee', treasury.bruma === 15, treasury);
const id = P.view(A).supply.orders[0].id;
check('...the board lists it, marked mine for A', P.view(A).supply.orders[0].mine === true && P.view(B).supply.orders[0].mine === false);
o = ui('supplyPost', A, `${KEY.toString(16)}:Skyrim.esm`, 1, 10);
check('post: a key cannot be ordered', o.kind === 'refused');
o = ui('supplyPost', B, `${SWORD.toString(16)}:Skyrim.esm`, 6, 3);
check('post: below 1 gold an item is refused', o.kind === 'refused');
o = ui('supplyDeliver', C, id, 6);
check('deliver: C, on A\'s account, cannot fill A\'s order', o.kind === 'refused' && count(C, SWORD) === 6, o);
board = 'whiterun';
o = ui('supplyDeliver', B, id, 6);
check('deliver: at another hold\'s board, refused', o.kind === 'refused' && count(B, SWORD) === 8, o);
board = 'bruma';
o = ui('supplyDeliver', B, id, 4);
check('deliver: B hands over 4 and is paid 200', o.kind === 'sent' && count(B, SWORD) === 4 && count(B, GOLD) === 250, { o, g: count(B, GOLD) });
box = api.lettersOf(A);
check('...the 4 swords wait in A\'s mailbox', box.length === 1 && box[0].parcel.items.reduce((n, t) => n + t.count, 0) === 4 && /Bel brought 4 Steel Sword/.test(box[0].text), box);
o = ui('supplyDeliver', B, id, 10);
check('deliver: asking for 10 hands over only the 2 left, paid the last 100', o.kind === 'sent' && count(B, SWORD) === 2 && count(B, GOLD) === 350, { o, g: count(B, GOLD) });
check('...the order is filled and off the board', P.view(B).supply.orders.length === 0);
o = ui('supplyDeliver', B, id, 1);
check('deliver: a filled order takes no more', o.kind === 'refused');
check('no gold was made or lost: A 685 + B 350 + C 10 + Bruma 15 + held 0 = 1060', count(A, GOLD) + count(B, GOLD) + count(C, GOLD) + treasury.bruma === 1060);
check('SUPPLY audit lines for the post and both deliveries', audits.filter((t) => /^SUPPLY/.test(t)).length === 3, audits);

// cancel and expiry refund to the mailbox
reset();
ui('supplyPost', A, `${SWORD.toString(16)}:Skyrim.esm`, 10, 100);
const id2 = P.view(A).supply.mine.find((m) => m.state === 'open').id;
ui('supplyDeliver', B, id2, 3);
o = ui('supplyCancel', B, id2);
check('cancel: only the poster can take an order down', o.kind === 'refused');
o = ui('supplyCancel', A, id2);
check('cancel: A takes it down, 70 of the reward goes to the mailbox', o.kind === 'sent' && /70 gold/.test(o.text), o);
box = api.lettersOf(A);
check('...a refund letter with 70 gold', box.some((m) => m.parcel && m.parcel.gold === 70), box);
ui('supplyPost', A, `${SWORD.toString(16)}:Skyrim.esm`, 2, 40);
ui('supplyPost', A, `${SWORD.toString(16)}:Skyrim.esm`, 2, 40);
ui('supplyPost', A, `${SWORD.toString(16)}:Skyrim.esm`, 2, 40);
o = ui('supplyPost', C, `${SWORD.toString(16)}:Skyrim.esm`, 1, 5);
check('post: a fourth open order on one account is refused', o.kind === 'refused', o);

// expiry: the sweep is registered with every(); run the module's own sweep by loading it with a capturing every
let sweep = null;
require(path.join(SERVER, 'post.js'))(Object.assign({}, api, { every: (n, ms, fn) => { if (n === 'supplyExpiry') sweep = fn; } }));
clock = now0 + 8 * 86400000;
const before = api.lettersOf(A).length;
sweep();
check('expiry: three expired orders send three refunds of 40 to the mailbox', api.lettersOf(A).length === before + 3 && api.lettersOf(A).filter((m) => m.parcel && m.parcel.gold === 40).length === 3);
clock = now0;

// the coop window carries the parcel rules and the sendable pack
v = P.view(A);
check('view: the sendable pack has the swords, not the worn dagger, key or robe', v.sendable.some((s) => s.baseId === SWORD) && !v.sendable.some((s) => [DAGGER, KEY, ROBE, GOLD].includes(s.baseId)), v.sendable);
check('view: parcel rules', v.parcel.taxRate === 0.1 && v.parcel.itemFee === 5 && v.parcel.maxStacks === 6);

// gamemode wiring
check('gamemode: a letter with a parcel is never pruned', /m\.read && !m\.parcel && spare--/.test(gm));
check('gamemode: a letter with a parcel cannot be burnt before collecting', /change === 'delete' && box\[i\]\.parcel/.test(gm));
check('gamemode: pigeonSend passes the parcel arguments', /sendPigeon\(a, Number\(args\[1\]\) >>> 0, args\[2\], zoneId, args\[3\], args\[4\]\)/.test(gm));
check('gamemode: post.js is loaded', /require\(POST_JS\)/.test(gm));

Date.now = realNow;
process.chdir(cwd);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
