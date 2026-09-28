// business.js against a stub mp, in a scratch directory (it reads housing.json and writes businesses.json / taxes.json
// in the working directory, so never run it from the live server folder).
// node tests/business-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'business.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-business-'));
process.chdir(scratch);

const CELL = 0x100, WORLD = 0x3c, DOOR = 0x200, OUTDOOR = 0x201, CHEST = 0x300, CHEST_BASE = 0x301;
const OWNER = 0xff000001, STAFF = 0xff000002, RENTER = 0xff000003, COUNT = 0xff000004, STRANGER = 0xff000005;
const PROFILE = { [OWNER]: 7, [STAFF]: 8, [RENTER]: 9, [COUNT]: 10, [STRANGER]: 11 };
const NAME = { [OWNER]: 'Olaf', [STAFF]: 'Sigrid', [RENTER]: 'Rena', [COUNT]: 'Count Carvain', [STRANGER]: 'Stray' };
fs.writeFileSync('housing.json', JSON.stringify([DOOR]));
const props = new Map();
const setp = (id, k, v) => props.set(`${id}|${k}`, v);
const desc = (id) => `${id.toString(16)}:Skyrim.esm`;
setp(DOOR, 'private.housing', { owner: 7, ownerName: 'Olaf', partner: OUTDOOR });
setp(DOOR, 'worldOrCellDesc', desc(CELL)); setp(OUTDOOR, 'worldOrCellDesc', desc(WORLD));
setp(CHEST, 'worldOrCellDesc', desc(CELL)); setp(CHEST, 'baseDesc', desc(CHEST_BASE));
for (const a of [OWNER, STAFF, RENTER, COUNT, STRANGER]) setp(a, 'worldOrCellDesc', desc(CELL));
const TYPES = { [CELL]: 'CELL', [WORLD]: 'WRLD', [CHEST_BASE]: 'CONT' };
const gold = { [OWNER]: 0, [STAFF]: 0, [RENTER]: 100, [COUNT]: 0, [STRANGER]: 5 };
const treasury = {}, said = [], cmds = {}, ui = {};
let ONLINE = [OWNER, STAFF, RENTER, COUNT, STRANGER];
const mp = {
  get: (id, k) => props.get(`${id}|${k}`),
  set: setp,
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
  lookupEspmRecordById: (id) => (TYPES[id] ? { record: { type: TYPES[id] } } : null),
  getActorsByProfileId: (p) => Object.keys(PROFILE).filter((a) => PROFILE[a] === p).map(Number),
  getDescFromId: (id) => (id >>> 0).toString(16),
  // PlaceAtMe makes a new reference in the caller's cell; SetPosition/SetAngle move it; Delete removes it
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    const id = parseInt(self.desc, 16) >>> 0;
    if (fn === 'PlaceAtMe') { const n = 0xff0000a0 + (placed.length); placed.push(n); setp(n, 'worldOrCellDesc', props.get(`${id}|worldOrCellDesc`)); setp(n, 'baseDesc', args[0].desc); return { desc: n.toString(16) }; }
    if (fn === 'SetPosition') setp(id, 'pos', args.slice(0, 3));
    if (fn === 'SetAngle') setp(id, 'angle', args.slice(0, 3));
    if (fn === 'Delete') { deleted.push(id); props.delete(`${id}|private.dboBizLedger`); }
    return null;
  },
};
const placed = [], deleted = [], panels = [];
const api = {
  mp, log: () => {}, audit: () => {}, who: (a) => NAME[a], display: (a) => NAME[a],
  personal: (a, t) => said.push([a, t]), cfg: { rest: { holdShare: 0.1 } },
  openWidget: (a, w) => (w.type === 'businessLedger' ? panels.push([a, w]) : said.push([a, 'MENU ' + w.targetName + ' | ' + w.actions.map((x) => x.id).join(',')])),
  closeWidget: (a, id) => said.push([a, 'CLOSE ' + id]),
  onUi: (n, f) => { ui[n] = f; }, registerChatCommand: (n, f) => { cmds[n] = f; },
  onlineActors: () => ONLINE, profileOf: (a) => PROFILE[a] ?? -1,
  findByName: (q) => Number(Object.keys(NAME).find((a) => NAME[a].toLowerCase() === String(q).toLowerCase())) || 0,
  takeGold: (a, n) => { if (gold[a] < n) return false; gold[a] -= n; return true; },
  giveGold: (a, n) => { gold[a] += n; return true; },
  depositToTreasury: (z, n) => { treasury[z] = (treasury[z] || 0) + n; return n; },
  zoneOfActor: () => 'bruma', zoneById: (id) => ({ id, name: 'Bruma' }),
  ranksOf: (p) => (p === 10 ? [{ zone: { id: 'bruma' }, rank: 'count' }] : []),
  distanceMeters: () => 1, isAdmin: () => false,
};
let fails = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fails++; };
const last = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };
globalThis.__dboBusiness = undefined; globalThis.__dboBusinessPass = undefined;
require(MODULE)(api);
const biz = () => JSON.parse(fs.readFileSync('businesses.json', 'utf8')).businesses[DOOR.toString(16)];
const H = 3600000;

// Opening and the ledger's keepers
cmds.business(STRANGER, 'open Stolen Inn');
ok(!fs.existsSync('businesses.json'), 'only the claim owner can open a business');
cmds.business(OWNER, 'open The Silver Jug');
ok(biz() && biz().name === 'The Silver Jug' && biz().zone === 'bruma', 'the owner opens a business on their claim');
cmds.business(OWNER, 'rent 25');
ok(globalThis.__dboBusinessRent(CELL) === 25, 'the bed rent rest.js asks for is the business price');
cmds.business(OWNER, 'rent 5000');
ok(globalThis.__dboBusinessRent(CELL) === 25, 'a rent outside the limits is refused');
cmds.business(OWNER, 'staff add Sigrid');
ok(biz().staff.length === 1 && biz().staff[0].profile === 8, 'the owner takes on staff');
cmds.business(STAFF, 'note Delivery of mead on Tirdas');
ok(biz().notes.length === 1 && biz().notes[0].by === 'Sigrid', 'staff write in the logbook');
cmds.business(RENTER, 'notes');
ok(/The Silver Jug, kept by Olaf/.test(last(RENTER)) && !/mead/.test(last(RENTER)), 'anyone else gets the public page, not the notes');
cmds.business(STAFF, 'staff add Rena');
ok(biz().staff.length === 1, 'staff cannot name staff');

// The hold's tax
ok(globalThis.__dboHoldTax('bruma', 0.1) === 0.1, 'until an official sets it, the tax is holdShare');
cmds.tax(STRANGER, '0');
ok(globalThis.__dboHoldTax('bruma', 0.1) === 0.1, 'someone without office cannot set the tax');
cmds.tax(COUNT, '20');
ok(globalThis.__dboHoldTax('bruma', 0.1) === 0.2, 'the Count sets the tax');
cmds.tax(COUNT, '90');
ok(globalThis.__dboHoldTax('bruma', 0.1) === 0.2, 'a tax above maxTax is refused');

// A chest for rent
cmds.business(OWNER, 'chest 10');
ok(globalThis.__dboBusinessActivate(CHEST, OWNER) === true && biz().chests[CHEST.toString(16)].price === 10, 'the owner puts a chest up by opening it');
ok(globalThis.__dboBusinessActivate(CHEST, STAFF) === false, 'an unrented chest opens for staff');
ok(globalThis.__dboBusinessActivate(CHEST, RENTER) === true && /MENU Storage for rent/.test(last(RENTER)), 'anyone else is offered the rent');
ui.bizChoose(RENTER, ['rent3']);
ok(gold[RENTER] === 70 && biz().chests[CHEST.toString(16)].renter === 9, 'renting 3 days takes 30 gold and names the renter');
ok(treasury.bruma === 6 && gold[OWNER] === 24, 'the hold takes 20 % (6) and the owner the rest (24)');
ok(globalThis.__dboBusinessActivate(CHEST, OWNER) === true, 'the owner cannot open a rented chest');
ok(globalThis.__dboBusinessActivate(CHEST, RENTER) === false, 'the renter opens it (more than a day left)');
ok(biz().log.some((e) => /rented a chest for 3 days, 30 gold/.test(e.text)), 'the rental is written in the ledger');

// Rent runs out: grace for the renter, then back to the owner
const data = globalThis.__dboBusiness.data;
data.businesses[DOOR.toString(16)].chests[CHEST.toString(16)].until = Date.now() - H;
ok(globalThis.__dboBusinessActivate(CHEST, RENTER) === true && /rent ran out/.test(last(RENTER)), 'in the grace period the renter is offered to pay or open');
ui.bizChoose(RENTER, ['open']);
ok(globalThis.__dboBusinessActivate(CHEST, RENTER) === false, 'the renter can still empty it in the grace period');
ok(globalThis.__dboBusinessActivate(CHEST, STAFF) === true, 'staff are kept out during the grace period');
data.businesses[DOOR.toString(16)].chests[CHEST.toString(16)].until = Date.now() - 100 * H;
ok(globalThis.__dboBusinessActivate(CHEST, STRANGER) === true && /waits for its owner/.test(last(STRANGER)), 'a lapsed chest cannot be rented before it is cleared');
ok(globalThis.__dboBusinessActivate(CHEST, OWNER) === false && !data.businesses[DOOR.toString(16)].chests[CHEST.toString(16)].renter, 'the owner opens a lapsed chest and it is free again');

// The ledger book and its panel
const panelOf = (a) => { for (let i = panels.length - 1; i >= 0; i--) if (panels[i][0] === a) return panels[i][1]; return null; };
setp(OWNER, 'pos', [1000, 2000, 50]); setp(OWNER, 'angle', [0, 0, 90]);
for (const a of [OWNER, STAFF, RENTER]) ui.uiCaps(a, ['bank', 'businessLedger']);
cmds.business(OWNER, 'ledger');
const L1 = placed[0];
ok(biz().ledger && biz().ledger.ref === L1.toString(16) && props.get(`${L1}|private.dboBizLedger`).claim === DOOR.toString(16), 'the owner places the ledger, tagged with the claim');
const lp = props.get(`${L1}|pos`);
ok(Math.abs(lp[0] - 1070) < 0.01 && Math.abs(lp[1] - 2000) < 0.01 && lp[2] === 145 && props.get(`${L1}|angle`)[2] === 270, 'in front of the owner at counter height, facing them', JSON.stringify([lp, props.get(`${L1}|angle`)]));
ok(globalThis.__dboBusinessActivate(L1, OWNER) === true && panelOf(OWNER) && panelOf(OWNER).role === 'owner' && Array.isArray(panelOf(OWNER).notes), 'activating it opens the full panel for the owner');
ok(globalThis.__dboBusinessActivate(L1, STAFF) === true && panelOf(STAFF).role === 'staff' && panelOf(STAFF).owed === 0, 'and for staff, without the takings held');
globalThis.__dboBusinessActivate(L1, RENTER);
const pub = panelOf(RENTER);
ok(pub && pub.role === 'customer' && pub.notes === undefined && pub.log === undefined && pub.staff === undefined && pub.chests.every((c) => c.renter === ''), 'a customer gets the public page only');
const nonce = panelOf(OWNER).nonce;
ui.bizLedger(OWNER, ['wrong', 'rent', 30]);
ok(globalThis.__dboBusinessRent(CELL) === 25, 'an action with a stale nonce is ignored');
ui.bizLedger(OWNER, [nonce, 'rent', 30]);
ok(globalThis.__dboBusinessRent(CELL) === 30 && panelOf(OWNER).resultKind === 'ok' && panelOf(OWNER).rent === 30, 'the panel sets the bed rent and answers with the new page');
ui.bizLedger(OWNER, [nonce, 'note', 'Order more ale']);
ok(biz().notes.some((n) => n.text === 'Order more ale') && panelOf(OWNER).notes[0].text === 'Order more ale', 'the panel writes in the logbook, newest first');
ui.bizLedger(STAFF, [panelOf(STAFF).nonce, 'rename', 'Sigrid\'s']);
ok(biz().name === 'The Silver Jug' && panelOf(STAFF).resultKind === 'refused', 'staff cannot do owner-only things');
ui.bizLedger(RENTER, [pub.nonce, 'rent', 1]);
ok(globalThis.__dboBusinessRent(CELL) === 30 && panelOf(RENTER).resultKind === 'refused', 'a customer can change nothing');
ui.bizLedger(OWNER, [nonce, 'nudge', 'up', 10]);
ui.bizLedger(OWNER, [nonce, 'nudge', 'turnRight']);
ok(props.get(`${L1}|pos`)[2] === 155 && props.get(`${L1}|angle`)[2] === 285, 'the arrows raise and turn it', JSON.stringify([props.get(`${L1}|pos`), props.get(`${L1}|angle`)]));
ui.bizLedger(OWNER, [nonce, 'nudge', 'away', 50]);
ok(Math.abs(props.get(`${L1}|pos`)[0] - 1120) < 0.01, 'away follows where the owner looks', props.get(`${L1}|pos`)[0]);
for (let i = 0; i < 20; i++) ui.bizLedger(OWNER, [nonce, 'nudge', 'away', 50]);
ok(Math.hypot(props.get(`${L1}|pos`)[0] - 1000, props.get(`${L1}|pos`)[1] - 2000) <= 700 && panelOf(OWNER).resultKind === 'refused', 'it cannot be pushed out of reach');
const weekBefore = panelOf(OWNER).week;
globalThis.__dboBusinessLog(CELL, 'Rena rented a bed for 10 gold', 9);
ui.bizLedger(OWNER, [nonce, 'rent', 30]);
ok(weekBefore === 24 && panelOf(OWNER).week === 33 && panelOf(OWNER).month === 33, 'the week\'s takings count chest and bed rent', `${weekBefore} -> ${panelOf(OWNER).week}`);
// A restart gives the book a new id: the one opened is the one the arrows move
const L2 = 0xff0000ee; setp(L2, 'worldOrCellDesc', desc(CELL)); setp(L2, 'pos', [1, 2, 3]); setp(L2, 'private.dboBizLedger', { claim: DOOR.toString(16) });
globalThis.__dboBusinessActivate(L2, OWNER);
ok(biz().ledger.ref === L2.toString(16), 'after a restart the ledger follows the book that was opened');
ui.bizLedger(OWNER, [panelOf(OWNER).nonce, 'place']);
ok(deleted.includes(L2) && biz().ledger.ref === placed[placed.length - 1].toString(16), 'placing it again moves it (the old book is removed)');
setp(OWNER, 'worldOrCellDesc', desc(WORLD));
ui.bizLedger(OWNER, [panelOf(OWNER).nonce, 'rent', 40]);
ok(globalThis.__dboBusinessRent(CELL) === 30 && /CLOSE 64/.test(said.filter((x) => x[0] === OWNER).map((x) => x[1]).join('|')), 'outside the business the panel closes and changes nothing');
setp(OWNER, 'worldOrCellDesc', desc(CELL));

// Takings for an offline owner, and a claim that changed hands
ONLINE = [RENTER];
globalThis.__dboBusinessActivate(CHEST, RENTER); ui.bizChoose(RENTER, ['rent1']);
ok(data.businesses[DOOR.toString(16)].owed === 8, "an offline owner's takings are held");
ONLINE = [OWNER, STAFF, RENTER, COUNT, STRANGER];
globalThis.__dboBusinessLogin(OWNER);
ok(gold[OWNER] === 32 && data.businesses[DOOR.toString(16)].owed === 0, 'the owner collects them at login');
setp(DOOR, 'private.housing', { owner: 11, ownerName: 'Stray', partner: OUTDOOR });
ok(globalThis.__dboBusinessRent(CELL) === null, 'a claim that changed hands closes the business');

console.log(fails ? `${fails} FAILED` : 'all checks passed');
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
