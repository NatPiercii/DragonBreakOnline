// Scripted test for the names of keys cut at a chest or inner door of a place (housingSystem.ts keyNameToCut; #bugs
// 1556227454769565796 "you cannot differentiate between two different storage keys"). Such a key read "Property Key (TAG)",
// so five keys to five chests could not be told apart (6 Oct: five "Property Key No. 2" handed over in a row). Now it is
// called after its place and its room as the Rooms and chests panel names them, and keeps its credential:
// "Key to the Castle Bruma: Strongbox 2 (806C502)". The credential is how a lock knows its keys past the 32 names it records,
// so the oldest copy still opens and a re-key (revoke keys, giving up, a hand-over, a revoke) still pulls every copy. Keys cut
// before keep working. Bundles housingSystem.ts with esbuild (or takes a bundle) and runs it on a fake mp.
//
//   node tests/housing-room-key-names-harness.js [bundled housingSystem.js]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-b-roomkeys-'));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// A named place (the castle), an unnamed one doors.json names (the shack), and a chest in no place
const CASTLE = 0x0806c473, BOX1 = 0x0806c501, BOX2 = 0x0806c502, WARDROBE = 0x0806c503, HALL_DOOR = 0x0806c504, HALL_FAR = 0x0806c505;
const SHACK = 0x0806766b, SHACK_BOX = 0x08067701, LONE = 0x08070001;
const CASTLE_CELL = '6c4d9:BSHeartland.esm', SHACK_CELL = '6765c:BSHeartland.esm', WORLD = 'a764b:BSHeartland.esm';
const OWNER = 0xff000014, FRIEND = 0xff000015, STAFF = 0xff000016;
const USER = { [OWNER]: 3, [FRIEND]: 4, [STAFF]: 5 }, PROFILE = { [OWNER]: 70, [FRIEND]: 91, [STAFF]: 55 };
const KEY_BASE = 0xdb0e2;

(async () => {
  let bundle = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (!bundle) {
    bundle = path.join(out, 'housing.js');
    await require(path.join(root, 'node_modules', 'esbuild')).build({
      entryPoints: [path.join(root, 'ts', 'systems', 'housingSystem.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    });
  }
  const { HousingSystem } = require(bundle);
  const HP = (/HOUSING_PROP\s*=\s*"([^"]+)"/.exec(fs.readFileSync(bundle, 'utf8')) || [])[1];
  fs.writeFileSync(path.join(out, 'doors.json'), JSON.stringify({ doors: { '6766b:BSHeartland.esm': 'Bruma Shack' } }));
  const cwd0 = process.cwd();
  process.chdir(out);

  // A fresh server with both places claimed by the owner; the friend and a staff member are online too
  const world = () => {
    const CELLS = { [CASTLE]: CASTLE_CELL, [BOX1]: CASTLE_CELL, [BOX2]: CASTLE_CELL, [WARDROBE]: CASTLE_CELL, [HALL_DOOR]: CASTLE_CELL,
      [HALL_FAR]: CASTLE_CELL, [SHACK]: SHACK_CELL, [SHACK_BOX]: SHACK_CELL, [LONE]: WORLD };
    const TYPES = { [CASTLE]: 'DOOR', [HALL_DOOR]: 'DOOR', [HALL_FAR]: 'DOOR', [SHACK]: 'DOOR', [BOX1]: 'CONT', [BOX2]: 'CONT', [WARDROBE]: 'CONT',
      [SHACK_BOX]: 'CONT', [LONE]: 'CONT' };
    const LABELS = { [BOX1]: 'Strongbox', [BOX2]: 'Strongbox', [WARDROBE]: 'Wardrobe', [HALL_DOOR]: 'Door to Great Hall', [SHACK_BOX]: 'Barrel', [LONE]: 'Chest' };
    const PARTNER = { [HALL_DOOR]: HALL_FAR, [HALL_FAR]: HALL_DOOR };
    const props = new Map();
    const actorOfUser = Object.fromEntries(Object.entries(USER).map(([a, u]) => [u, Number(a)]));
    const mp = {
      get: (id, key) => {
        if (key === 'profileId') return PROFILE[id >>> 0] || 0;
        if (key === 'worldOrCellDesc') return CELLS[id >>> 0] || '';
        if (key === 'appearance') return { name: id === FRIEND ? 'Hroki' : id === STAFF ? 'Staff' : 'Frigga' };
        const v = props.get(`${id >>> 0}:${key}`);
        return v === undefined ? undefined : JSON.parse(v);
      },
      set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
      getUserByActor: (id) => (USER[id >>> 0] === undefined ? -1 : USER[id >>> 0]),
      getUserActor: (u) => actorOfUser[u] || 0,
      getDescFromId: (id) => ({ [SHACK]: '6766b:BSHeartland.esm' }[id >>> 0] || `${(id >>> 0).toString(16)}:Unknown.esp`),
      getIdFromDesc: () => 0, lookupEspmRecordById: () => null,
      isConnected: (u) => !!actorOfUser[u], sendCustomPacket: () => { },
    };
    const ctx = { svr: mp };
    const sys = new HousingSystem(() => { });
    sys.placeMigration = 'apply';
    sys.holdOf = () => null; sys.holdRanks = () => []; sys.saveRegistry = () => { };
    sys.isAdmin = (c, a) => (a >>> 0) === STAFF;
    sys.overCap = () => '';
    sys.nearProperty = () => true; sys.notice = () => { }; sys.sendMenu = () => { };
    sys.partnerOf = (c, id) => PARTNER[id >>> 0] || 0;
    sys.primaryOf = (c, id) => (id >>> 0) === HALL_FAR ? HALL_DOOR : id >>> 0;
    sys.baseTypeOf = (c, id) => TYPES[id >>> 0] || '';
    sys.isWorldDesc = (c, d) => d === WORLD;
    sys.refsInCell = (c, desc) => Object.keys(CELLS).map(Number).filter((id) => CELLS[id] === desc);
    sys.labelOf = (c, id) => LABELS[id >>> 0] || 'Door';
    sys.claimed = [CASTLE, SHACK, LONE, BOX1];
    const record = (o) => Object.assign({ owner: 70, ownerName: 'Frigga', name: null, locked: false, serial: 1, partner: 0, containers: [], issued: [] }, o);
    mp.set(CASTLE, HP, record({ name: 'Castle Bruma', place: { cells: [CASTLE_CELL], builtAt: 1 } }));
    mp.set(SHACK, HP, record({ place: { cells: [SHACK_CELL], builtAt: 1 } }));
    mp.set(LONE, HP, record({}));
    // A chest the migration took into the castle, with a key cut before; the second strongbox and the wardrobe nobody claimed yet
    mp.set(BOX1, HP, record({ memberOf: CASTLE, ownerOnly: true, issued: ['Property Key (806C501)'] }));

    const recOf = (id) => sys.read(ctx, id);
    const request = (actor, target, action, extra) => {
      sys.lastRequestMs = new Map();
      sys.onPropertyRequest(ctx, USER[actor], Object.assign({ target, action }, extra || {}));
    };
    const cut = (id) => { request(OWNER, id, 'createkey'); const r = recOf(id); return r && r.issued ? r.issued.slice(-1)[0] : undefined; };
    // Whether a stranger holding only this key gets in; a lock given up is checked as if claimed again
    const opens = (id, keyName) => {
      const r = recOf(id);
      if (!r) return false;
      const lock = r.owner === 0 ? Object.assign({}, r, { owner: 70 }) : r;
      return sys.hasAccessWith(ctx, id, lock, { actorId: 0, profileId: 999, admin: false, ranks: [], keys: new Set([keyName]) });
    };
    const pack = (actor) => ((mp.get(actor, 'inventory') || {}).entries || []).map((e) => e.name);
    const hand = (actor, names) => mp.set(actor, 'inventory', { entries: names.map((name) => ({ baseId: KEY_BASE, count: 1, name })) });
    return { sys, mp, ctx, CELLS, TYPES, LABELS, PARTNER, recOf, request, cut, opens, pack, hand };
  };

  // ── Names ──
  {
    const w = world();
    const b1 = w.cut(BOX1), b1b = w.cut(BOX1);
    check('a key cut at a chest of a named place is called after the place and the chest, credential kept', b1 === 'Key to the Castle Bruma: Strongbox (806C501)', b1);
    check('...and its copies are numbered, credential kept', b1b === 'Key to the Castle Bruma: Strongbox No. 2 (806C501)', b1b);
    const b2 = w.cut(BOX2);
    check('two chests of one kind are told apart as the Rooms and chests panel tells them apart', b2 === 'Key to the Castle Bruma: Strongbox 2 (806C502)', b2);
    const wd = w.cut(WARDROBE);
    check('another chest of the place has a name of its own', wd === 'Key to the Castle Bruma: Wardrobe (806C503)', wd);
    check('each chest key opens its own chest', w.opens(BOX1, b1) && w.opens(BOX1, b1b) && w.opens(BOX2, b2) && w.opens(WARDROBE, wd));
    check('...and no other chest, nor the place', !w.opens(BOX2, b1) && !w.opens(BOX1, b2) && !w.opens(WARDROBE, b1) && !w.opens(CASTLE, b1) && !w.opens(CASTLE, wd));
    const d = w.cut(HALL_DOOR);
    check('an inner door doors.json does not name is called after its room too', d === 'Key to the Castle Bruma: Door to Great Hall (806C504)', d);
    check('...and opens that door only', w.opens(HALL_DOOR, d) && !w.opens(BOX1, d) && !w.opens(CASTLE, d));
    const s = w.cut(SHACK_BOX);
    check('a chest of an unnamed place is called after the place\'s door', s === 'Key to Bruma Shack: Barrel (8067701)', s);
    const l = w.cut(LONE);
    check('a chest in no place keeps the credential name', l === 'Property Key (8070001)', l);
    const h = w.cut(CASTLE);
    check('the place\'s own key keeps its name and opens no chest of it', h === 'Key to the Castle Bruma' && !w.opens(BOX1, h) && !w.opens(BOX2, h), h);
    const all = [b1, b1b, b2, wd, d, s, l, h];
    check('every key cut has a name of its own', new Set(all).size === all.length, all);
  }

  // ── Keys cut before ──
  {
    const w = world();
    // A copy cut before (not recorded) and a key named without the credential, as the first version of this fix cut them
    const r = w.recOf(BOX1); r.issued.push('Key to the Castle Bruma: Strongbox'); w.mp.set(BOX1, HP, r);
    check('a "Property Key (TAG)" cut before keeps opening its chest', w.opens(BOX1, 'Property Key (806C501)') && !w.opens(BOX2, 'Property Key (806C501)'));
    check('...and so does an unrecorded copy of it', w.opens(BOX1, 'Property Key No. 2 (806C501)'));
    check('a key cut with no credential opens while its name is recorded', w.opens(BOX1, 'Key to the Castle Bruma: Strongbox'));
    const n = w.cut(BOX1);
    check('a key cut now beside them gets a name none of them has', n === 'Key to the Castle Bruma: Strongbox (806C501)' && w.opens(BOX1, n), n);
    const before = ['Property Key (806C501)', 'Property Key No. 2 (806C501)', 'Key to the Castle Bruma: Strongbox', n];
    w.hand(FRIEND, before);
    w.request(OWNER, BOX1, 'revokekeys');
    check('revoking keys pulls all of them from the friend\'s pack and none opens any more', w.pack(FRIEND).length === 0 && before.every((k) => !w.opens(BOX1, k)), w.pack(FRIEND));
  }

  // ── The 32 recorded names ──
  {
    const w = world();
    w.mp.set(BOX1, HP, Object.assign(w.recOf(BOX1), { issued: [] }));
    const names = []; for (let i = 0; i < 33; i++) names.push(w.cut(BOX1));
    const first = names[0];
    check('past 32 copies the first one\'s name is no longer recorded (precondition)', !w.recOf(BOX1).issued.includes(first), w.recOf(BOX1).issued.length);
    check('...and that first copy still opens its chest by the credential', w.opens(BOX1, first) && !w.opens(BOX2, first), first);
  }

  // ── Re-keys: each must pull every key to the chest from the packs of those online, past the recorded names too ──
  const rekeyWorld = () => {
    const w = world();
    const names = []; for (let i = 0; i < 33; i++) names.push(w.cut(BOX1));
    const other = w.cut(BOX2);
    const held = { pastCap: names[0], newest: names[32], old: 'Property Key (806C501)', oldCopy: 'Property Key No. 2 (806C501)' };
    w.hand(FRIEND, [...Object.values(held), other]);
    w.hand(OWNER, []);
    return { w, held, other };
  };
  const pulled = (label, run, otherStays) => {
    const { w, held, other } = rekeyWorld();
    check(`${label}: before, the friend's chest keys open it (precondition)`, Object.values(held).every((n) => w.opens(BOX1, n)), held);
    run(w);
    const left = w.pack(FRIEND);
    check(`${label}: every key to the chest is pulled from the friend's pack, the copy past the recorded names too`,
      Object.values(held).every((n) => !left.includes(n)), left);
    check(`${label}: ...and none of them opens it any more`, Object.values(held).every((n) => !w.opens(BOX1, n)));
    if (otherStays) check(`${label}: ...while the key to the other chest stays and opens it`, left.includes(other) && w.opens(BOX2, other), left);
  };
  pulled('revoke keys at the chest', (w) => w.request(OWNER, BOX1, 'revokekeys'), true);
  pulled('revoke keys of the place', (w) => w.request(OWNER, CASTLE, 'revokekeys'));
  pulled('giving the place up', (w) => w.request(OWNER, CASTLE, 'abandon'));
  pulled('handing the place over', (w) => w.request(OWNER, CASTLE, 'transfer', { recipient: FRIEND }));
  pulled('staff taking the place back', (w) => w.request(STAFF, CASTLE, 'revoke'));
  {
    const { w } = rekeyWorld();
    w.request(OWNER, BOX1, 'revokekeys');
    const n = w.cut(BOX1);
    check('a key cut after a re-key carries the new credential and opens', /\(806C501-2\)$/.test(n) && w.opens(BOX1, n), n);
  }

  // ── Length ──
  {
    const w = world();
    // The longest room label there is: a door's 40-character name to a 40-character cell, in a 32-character place
    const LONG = 0x0806c506, LONG_FAR = 0x0806c507;
    w.CELLS[LONG] = CASTLE_CELL; w.CELLS[LONG_FAR] = CASTLE_CELL; w.TYPES[LONG] = 'DOOR'; w.TYPES[LONG_FAR] = 'DOOR';
    w.LABELS[LONG] = `${'D'.repeat(40)} to ${'C'.repeat(40)}`;
    const primaryOf0 = w.sys.primaryOf;
    w.PARTNER[LONG] = LONG_FAR; w.PARTNER[LONG_FAR] = LONG;
    w.sys.primaryOf = (c, id) => (id >>> 0) === LONG_FAR ? LONG : primaryOf0(c, id);
    const r0 = w.recOf(CASTLE); r0.name = 'N'.repeat(32); w.mp.set(CASTLE, HP, r0);
    w.mp.set(LONG, HP, { owner: 70, ownerName: 'Frigga', name: null, locked: false, serial: 999, partner: LONG_FAR, containers: [], issued: [], memberOf: CASTLE });
    w.sys.claimed.push(LONG);
    let longest = ''; for (let i = 0; i < 12; i++) longest = w.cut(LONG);
    check('a key name stays under the 128 characters an item name is cropped at, credential kept', longest.length < 128 && /\(806C506-999\)$/.test(longest), [longest.length, longest]);
    check('...and it opens its door', w.opens(LONG, longest));
  }

  process.chdir(cwd0);
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
