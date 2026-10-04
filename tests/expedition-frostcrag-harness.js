// The expedition boards in Frostcrag Spire (dungeons.js): DragonBreak Online Edits places seven ExpeditionBoard boxes in
// CYRFrostCragSpire (144975-14497b, beside the ones in the Synod Conclave and the Fighters Guild), but the board only
// answered in the two Bruma halls, so the College of Whispers' tower told its players to go to the city. This drives the
// real dungeons.js with a mock gamemode api: the board there opens the panel, a party member up in the tower counts as
// present, and the party comes home to Frostcrag's front hall, not to the Synod.
//   node tests/expedition-frostcrag-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-expedition-frostcrag-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

// Frostcrag's cells (BSHeartland.esm) and the live board placements' server ids (DragonBreak Online Edits.esp, index 0x3c)
const SPIRE = '6ff7d:BSHeartland.esm', TOWER = '781ad:BSHeartland.esm', VAULT = '6ff7e:BSHeartland.esm';
const SYNOD = '20ff:BSHeartland.esm', FG = 'f8d:BSHeartland.esm', BRUMA = 'a764b:BSHeartland.esm';
const RUIN = 'ef1aa:BSHeartland.esm', DOOR = 0xef1ad;
const BOARDS = [0x3c144975, 0x3c144976, 0x3c144977, 0x3c144978, 0x3c144979, 0x3c14497a, 0x3c14497b];
const BOARD = BOARDS[0];
// The front door's arrival spot inside the Spire (859ad:BSHeartland.esm's XTEL, read with ck-mcp/esplib.py on 4 Oct)
const FRONT = [809.2, 690.0, -551.9];
const A = 0x14, B = 0xff000020;
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'CYRNiryastareLocation', name: 'Niryastare', type: 'ayleid', county: 'Kvatch County',
  cells: [{ desc: RUIN }, { desc: 'ef1a9:BSHeartland.esm' }], chests: [], zones: [],
  entrances: [{ expedition: true, cell: SYNOD, pos: [-8.8, -578.4, -114.9], rot: [0, 0, 0], doorPos: [-8.8, -578.4, -114.9],
    insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [-197.1, 2401.9, 393.9], insideRot: [0, 0, -1.4006] }] }] }));
const props = new Map([[`${A}|worldOrCellDesc`, SPIRE], [`${A}|pos`, [-560, 700, -539]], [`${B}|worldOrCellDesc`, BRUMA], [`${B}|pos`, [0, 0, 0]]]);
for (const b of BOARDS) props.set(`${b}|baseDesc`, '6:DragonBreak.esp');
const widgets = [], said = [], moves = [];
const commands = new Map(), ui = new Map();
let party = [];
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : id === B ? 2 : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => { props.set(`${id}|${p}`, v); if (p === 'locationalData') { moves.push([id, v]); props.set(`${id}|worldOrCellDesc`, v.cellOrWorldDesc); props.set(`${id}|pos`, v.pos); } },
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
    getActorsByProfileId: (p) => (p === 1 ? [A] : p === 2 ? [B] : []),
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
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };
const last = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === a) return said[i][1]; return ''; };
const activate = globalThis.__dboDungeonActivate;

// Every one of the seven boxes is the board, and answers in the Spire
fire('uiCaps', A, ['expeditionBoard']);
for (const b of BOARDS) {
  widgets.length = 0;
  const v = activate(b, A);
  const w = widgets.find((x) => x[1].type === 'expeditionBoard');
  if (!(v === false && w && w[1].hall === 'Frostcrag Spire')) { check(`board ${b.toString(16)} in the Spire opens the panel`, false, { v, said: last(A), w: w && w[1].hall }); break; }
  fire('expeditionClose', A, []);
}
check('all seven Frostcrag boards open the expedition board panel, from Frostcrag Spire', !failures);
widgets.length = 0;
activate(BOARD, A);
const panel = widgets.find((w) => w[1].type === 'expeditionBoard');
check('the panel lists the ruins, open from here', !!panel && panel[1].expeditions.length === 1 && panel[1].expeditions[0].name === 'Niryastare' && panel[1].expeditions[0].state === 'open', panel && panel[1]);
check('...and was not refused with "set out from the boards in ..."', !/set out from the boards/.test(last(A)), last(A));
// Away from every hall the board still says where they are, Frostcrag included
said.length = 0;
check('a board used outside the halls is refused', activate(BOARD, B) === false && !widgets.some((w) => w[0] === B));
check('...naming Frostcrag Spire beside the two Bruma halls', /Synod Conclave/.test(last(B)) && /Fighters Guild/.test(last(B)) && /Frostcrag Spire/.test(last(B)), last(B));
commands.get('expedition')(B, '');
check('/expedition points at the boards, Frostcrag included', /expedition board/.test(last(B)) && /Frostcrag Spire/.test(last(B)), last(B));

// Setting out: the gate panel, from Frostcrag
fire('expeditionPick', A, ['CYRNiryastareLocation']);
const gate = widgets.find((w) => w[1].type === 'dungeonGate');
check('picking a ruin opens the party and difficulty panel', !!gate && gate[1].name === 'Niryastare');
const pend = globalThis.__dboDungeons.pending.get(A);
check('the expedition leaves from Frostcrag Spire, its front hall the way home', !!pend && pend.entrance.from === 'Frostcrag Spire' && pend.entrance.cell === SPIRE
  && JSON.stringify(pend.entrance.pos) === JSON.stringify(FRONT), pend && pend.entrance);
check('...and the whole tower is the hall: Spire, Tower and Vault', !!pend && [SPIRE, TOWER, VAULT].every((c) => pend.entrance.startCells.includes(c.toLowerCase())), pend && pend.entrance.startCells);
// The leader claims from up in the tower: still at the entrance
props.set(`${A}|worldOrCellDesc`, TOWER);
fire('dungeonClaim', A, [pend && pend.nonce, 'normal']);
check('claiming from the Tower is still at the entrance', !said.some((x) => x[0] === A && /wandered from the entrance/.test(x[1])), said.filter((x) => x[0] === A).map((x) => x[1]));
const lease = globalThis.__dboDungeons.leases.get('CYRNiryastareLocation');
check('the claim started a lease', !!lease);
if (lease) {
  props.set(`${A}|worldOrCellDesc`, RUIN); moves.length = 0;
  check("the ruin's main door refuses the engine", activate(DOOR, A) === false);
  check('...and brings the party home to Frostcrag, at its front door', moves.length === 1 && moves[0][1].cellOrWorldDesc === SPIRE && JSON.stringify(moves[0][1].pos) === JSON.stringify(FRONT), moves[0]);
  check('...with a line about the journey home to Frostcrag Spire, not to the Synod or "in Bruma"', /journey back from Niryastare to Frostcrag Spire/.test(last(A)) && !/Synod/.test(last(A)) && !/Spire in Bruma/.test(last(A)), last(A));
  props.set(`${A}|worldOrCellDesc`, 'ef1a9:BSHeartland.esm'); moves.length = 0;
  commands.get('expedition')(A, 'leave');
  check('/expedition leave also goes home to Frostcrag', moves.length === 1 && moves[0][1].cellOrWorldDesc === SPIRE && /to Frostcrag Spire/.test(last(A)), last(A));
}
// The Bruma halls are unchanged: the home line still names the city
props.set(`${A}|worldOrCellDesc`, FG); props.set(`${A}|pos`, [0, -500, -221]);
widgets.length = 0;
activate(BOARD, A);
const fgPanel = widgets.find((w) => w[1].type === 'expeditionBoard');
check('the same board box in the Fighters Guild opens it from the Guild', !!fgPanel && fgPanel[1].hall === 'the Fighters Guild');
fire('expeditionClose', A, []);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
