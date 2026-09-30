// Expeditions from the Synod (dungeons.js /expedition): the list, the claim panel, the arrival at the ruin and the
// main door that brings the party home. Loads the real dungeons.js with a mock gamemode api in a scratch folder.
//   node tests/expedition-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-expedition-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

const SYNOD = '20ff:BSHeartland.esm', RUIN = 'ef1aa:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';
const DOOR = 0xef1ad;
const BOARD = 0x3413a556; // an ExpeditionBoard placement in the Synod (DragonBreak Online Edits)
const A = 0x14, B = 0xff000020;
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'CYRNiryastareLocation', name: 'Niryastare', type: 'ayleid', county: 'Kvatch County',
  cells: [{ desc: RUIN }, { desc: 'ef1a9:BSHeartland.esm' }], chests: [], zones: [],
  entrances: [{ expedition: true, cell: SYNOD, pos: [-8.8, -578.4, -114.9], rot: [0, 0, 0], doorPos: [-8.8, -578.4, -114.9],
    insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [-197.1, 2401.9, 393.9], insideRot: [0, 0, -1.4006] }] }] }));
const props = new Map([[`${BOARD}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, SYNOD], [`${A}|pos`, [0, -500, -114]], [`${B}|worldOrCellDesc`, BRUMA], [`${B}|pos`, [0, 0, 0]]]);
const widgets = [], said = [], moves = [];
const commands = new Map(), ui = new Map();
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : id === B ? 2 : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => { props.set(`${id}|${p}`, v); if (p === 'locationalData') { moves.push([id, v]); props.set(`${id}|worldOrCellDesc`, v.cellOrWorldDesc); props.set(`${id}|pos`, v.pos); } },
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
    lookupEspmRecordById: (id) => (id === 6 ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }),
  },
  log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: () => {},
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: (a, w, focus) => { widgets.push([a, w, focus]); return true; }, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : a === B ? 2 : -1), nameOf: () => 'P', onlineActors: () => [A, B],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };
const last = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };

// Setting out is the board's job (Nate, 2026-09-28: "no more /expedition")
const activate = globalThis.__dboDungeonActivate;
commands.get('expeditions')(A, '');
check('/expeditions no longer opens anything; it points at the board', !widgets.length && /expedition board in the Synod Conclave or the Fighters Guild/.test(last(A)), last(A));
commands.get('expedition')(A, 'nir');
check('...nor does /expedition with a name', !widgets.length && !globalThis.__dboDungeons.pending.get(A));
check('a board used away from the two halls says where they are', activate(BOARD, B) === false && !widgets.length && /boards in the Synod Conclave and the Fighters Guild/.test(last(B)), last(B));
check('an older client (no uiCaps) gets the list menu, not an invisible panel', activate(BOARD, A) === false && widgets.length === 1 && widgets[0][1].type === 'contextMenu' && widgets[0][1].events.action === 'dbo:expeditionPick' && /Niryastare, Boss dungeon, Kvatch County \(open\)/.test(widgets[0][1].actions[0].label), widgets[0] && widgets[0][1]);
fire('expeditionClose', A, []); widgets.length = 0;
fire('uiCaps', A, ['bank', 'expeditionBoard']);
check('the board refuses the engine and opens the expedition board panel', activate(BOARD, A) === false);
const list = widgets.find((w) => w[1].type === 'expeditionBoard');
check('the panel lists the ruins with county, state and status, from this hall', !!list && list[1].hall === 'the Synod Conclave' && list[1].expeditions[0].name === 'Niryastare' && list[1].expeditions[0].county === 'Kvatch County' && list[1].expeditions[0].state === 'open' && list[1].expeditions[0].status === 'open' && list[1].events.pick === 'dbo:expeditionPick' && list[1].events.close === 'dbo:expeditionClose', list && list[1]);
// The Contracts tab (Nate, 2026-09-30): the board carries the hold's hunting work from contracts.js
globalThis.__dboContractsBoard = { view: () => ({ enabled: true, zone: 'Bruma', note: '', held: null, list: [{ id: 'c1', what: '3 wolves', reward: 36, state: 'open' }], canPost: false }) };
fire('expeditionClose', A, []); widgets.length = 0;
activate(BOARD, A);
const withContracts = widgets.find((w) => w[1].type === 'expeditionBoard');
check('the board carries the Contracts tab, opening on Expeditions', !!withContracts && withContracts[1].contracts && withContracts[1].contracts.zone === 'Bruma' && withContracts[1].tab === 'expeditions'
  && withContracts[1].events.contractTake === 'dbo:contractTake' && withContracts[1].events.contractAbandon === 'dbo:contractAbandon');
widgets.length = 0;
globalThis.__dboExpeditionBoardRefresh(A, 'contracts');
check('a take or give-up redraws it on the Contracts tab', widgets.length === 1 && widgets[0][1].tab === 'contracts');
fire('expeditionClose', A, []); widgets.length = 0;
globalThis.__dboExpeditionBoardRefresh(A, 'contracts');
check('...but not once the board is closed', !widgets.length);
globalThis.__dboContractsBoard = { view: () => { throw new Error('boom'); } };
activate(BOARD, A);
check('a failing contracts view still opens the board, without the tab', widgets.length === 1 && widgets[0][1].type === 'expeditionBoard' && widgets[0][1].contracts === undefined);
delete globalThis.__dboContractsBoard;
widgets.length = 0;
check('something that is not the board is not ours', activate(0x12345, A) === null);
fire('expeditionPick', A, ['CYRNiryastareLocation']);
const gate = widgets.find((w) => w[1].type === 'dungeonGate');
check('picking one opens the party and difficulty panel', !!gate && gate[1].name === 'Niryastare' && gate[1].kind === 'Ayleid ruin, boss dungeon');
fire('dungeonCancel', A, []);
check('turning back leaves them standing in the Synod', !moves.length);
// The claim itself goes through startLease; here the door and the return are what is new
props.set(`${A}|worldOrCellDesc`, RUIN);
const r = activate(DOOR, A);
check("the ruin's main door refuses the engine and brings them to the Synod", r === false && moves.length === 1 && moves[0][1].cellOrWorldDesc === SYNOD);
check('with a line about the journey home', /journey back from Niryastare/.test(last(A)));
// From the Fighters Guild: the panel opens there, a member in its basement counts as present, and home is the Guild
const FG = 'f8d:BSHeartland.esm', FGB = '6c150:BSHeartland.esm';
props.set(`${A}|worldOrCellDesc`, FG); props.set(`${A}|pos`, [0, -500, -221]);
widgets.length = 0; moves.length = 0;
activate(BOARD, A); fire('expeditionPick', A, ['CYRNiryastareLocation']);
const g2 = widgets.find((w) => w[1].type === 'dungeonGate');
check('the Fighters Guild in Bruma is a starting hall too', !!g2);
const pend = globalThis.__dboDungeons.pending.get(A);
check('the expedition leaves from the Guild', pend && pend.entrance.from === 'the Fighters Guild' && pend.entrance.cell === FG);
props.set(`${A}|worldOrCellDesc`, FGB);
fire('dungeonClaim', A, [pend.nonce, 'normal']);
check('claiming from the Guild basement is still at the entrance', !said.some((x) => x[0] === A && /wandered from the entrance/.test(x[1])));
const lease = globalThis.__dboDungeons.leases.get('CYRNiryastareLocation');
if (lease) {
  props.set(`${A}|worldOrCellDesc`, RUIN); moves.length = 0;
  activate(DOOR, A);
  check('the main door brings the party home to the Guild', moves.length === 1 && moves[0][1].cellOrWorldDesc === FG && /to the Fighters Guild in Bruma/.test(last(A)));
  // /expedition leave (Nate, 2026-09-28): the same way home from anywhere in the ruin, its deeper cell included
  props.set(`${A}|worldOrCellDesc`, 'ef1a9:BSHeartland.esm'); moves.length = 0;
  commands.get('expedition')(A, 'leave');
  check('/expedition leave brings the party home from deep in the ruin', moves.length === 1 && moves[0][1].cellOrWorldDesc === FG && /journey back from Niryastare to the Fighters Guild/.test(last(A)), last(A));
  props.set(`${A}|worldOrCellDesc`, RUIN); moves.length = 0;
  globalThis.__dboIsDowned = (x) => x === A;
  commands.get('expedition')(A, 'leave');
  check('...but not while down', !moves.length && /Not while you are down/.test(last(A)), last(A));
  delete globalThis.__dboIsDowned;
} else check('the claim started a lease', false);
props.set(`${B}|worldOrCellDesc`, FG); moves.length = 0;
commands.get('expedition')(B, 'leave');
check('/expedition leave outside a ruin says what it is for', !moves.length && /You are not on an expedition/.test(last(B)), last(B));
props.set(`${B}|worldOrCellDesc`, RUIN); moves.length = 0;
commands.get('expedition')(B, 'home');
check('with no claim of its own it still goes home, to the Synod', moves.length === 1 && moves[0][1].cellOrWorldDesc === SYNOD, last(B));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
