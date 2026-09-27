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
const A = 0x14, B = 0xff000020;
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'CYRNiryastareLocation', name: 'Niryastare', type: 'ayleid', county: 'Kvatch County',
  cells: [{ desc: RUIN }], chests: [], zones: [],
  entrances: [{ expedition: true, cell: SYNOD, pos: [-8.8, -578.4, -114.9], rot: [0, 0, 0], doorPos: [-8.8, -578.4, -114.9],
    insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [-197.1, 2401.9, 393.9], insideRot: [0, 0, -1.4006] }] }] }));
const props = new Map([[`${A}|worldOrCellDesc`, SYNOD], [`${A}|pos`, [0, -500, -114]], [`${B}|worldOrCellDesc`, BRUMA], [`${B}|pos`, [0, 0, 0]]]);
const widgets = [], said = [], moves = [];
const commands = new Map(), ui = new Map();
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : id === B ? 2 : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => { props.set(`${id}|${p}`, v); if (p === 'locationalData') { moves.push([id, v]); props.set(`${id}|worldOrCellDesc`, v.cellOrWorldDesc); props.set(`${id}|pos`, v.pos); } },
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
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

commands.get('expeditions')(B, '');
check('outside the two halls, /expeditions says where to go', /Synod Conclave or the Fighters Guild in Bruma/.test(last(B)) && !widgets.length);
commands.get('expedition')(A, '');
const list = widgets.find((w) => w[1].type === 'contextMenu');
check('in the Synod it lists the ruins, with the county and status', !!list && /Niryastare, Kvatch County \(open\)/.test(list[1].actions[0].label) && /from the Synod Conclave/.test(list[1].targetName));
check('/expedition works too', commands.has('expedition'));
fire('expeditionPick', A, ['CYRNiryastareLocation']);
const gate = widgets.find((w) => w[1].type === 'dungeonGate');
check('picking one opens the party and difficulty panel', !!gate && gate[1].name === 'Niryastare' && gate[1].kind === 'Ayleid ruin');
fire('dungeonCancel', A, []);
check('turning back leaves them standing in the Synod', !moves.length);
// The claim itself goes through startLease; here the door and the return are what is new
const activate = globalThis.__dboDungeonActivate;
props.set(`${A}|worldOrCellDesc`, RUIN);
const r = activate(DOOR, A);
check("the ruin's main door refuses the engine and brings them to the Synod", r === false && moves.length === 1 && moves[0][1].cellOrWorldDesc === SYNOD);
check('with a line about the journey home', /journey back from Niryastare/.test(last(A)));
// From the Fighters Guild: the panel opens there, a member in its basement counts as present, and home is the Guild
const FG = 'f8d:BSHeartland.esm', FGB = '6c150:BSHeartland.esm';
props.set(`${A}|worldOrCellDesc`, FG); props.set(`${A}|pos`, [0, -500, -221]);
widgets.length = 0; moves.length = 0;
commands.get('expeditions')(A, 'nir');
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
} else check('the claim started a lease', false);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
