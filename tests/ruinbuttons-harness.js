// Scripted test for server\ruinbuttons.js with the real ruin-buttons.json (tooling/ruin_buttons.py), against a stub mp.
//   node tests/ruinbuttons-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'ruinbuttons.js');
const DATA = path.resolve(__dirname, '..', 'ruin-buttons.json');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ruinbuttons-'));
fs.copyFileSync(DATA, path.join(scratch, 'ruin-buttons.json'));
const home = process.cwd();
process.chdir(scratch);

const fromDesc = (d) => { const [h, p] = String(d).split(':'); return /bsheartland/i.test(p) ? (0x08000000 | parseInt(h, 16)) >>> 0 : 0; };
const calls = []; const said = []; const logs = []; const audits = [];
let failOn = null;
const mp = {
  getIdFromDesc: fromDesc,
  callPapyrusFunction: (kind, cls, fn, self, args) => {
    if (failOn && self.desc === failOn) throw new Error('no such reference');
    calls.push({ kind, cls, fn, ref: self.desc, arg: args[0], args });
  },
};
const PLAYER = 0xff000014;
const packets = [];
const load = (cfg) => { delete require.cache[MODULE]; require(MODULE)({ mp, log: (...a) => logs.push(a.join(' ')), personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: () => 'Falcius Octavio', cfg: cfg || {}, sendPacket: (a, p) => packets.push([a, p]) }); };
load();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };
const press = (desc) => globalThis.__dboRuinButton(fromDesc(desc), PLAYER);

const TELEPE_A = 'aed73:BSHeartland.esm', TELEPE_B = 'af0b0:BSHeartland.esm', STAIRS = 'aed72:BSHeartland.esm';
const SILORN_GATE = 'aa641:BSHeartland.esm', SILORN_STAIRS_BTN = 'aa271:BSHeartland.esm';

check('the data loads: 6 buttons in 4 places (the two expedition ruins, Rielle and Anga)', logs.some((l) => /ruinbuttons on: 6 buttons in 4 ruins, 0 open/.test(l)), logs[logs.length - 1]);
check('an unknown reference is not ours', press('12345:BSHeartland.esm') === false && calls.length === 0);

check('Telepe\'s first button is ours: the engine\'s toggling chain is blocked', press(TELEPE_A) === true);
// bskarpitstairs01.nif: no behaviour graph, NiControllerSequences "Open" and "Close"
const STAIR_OPEN = ['PlayGamebryoAnimation(Open)'];
const STAIR_CLOSE = ['PlayGamebryoAnimation(Close)'];
const sig = (cs) => cs.map((c) => `${c.fn}(${c.arg})`);
check('the stair plays its NIF sequence: PlayGamebryoAnimation("Open")', JSON.stringify(sig(calls)) === JSON.stringify(STAIR_OPEN) && calls.every((c) => c.ref === STAIRS && c.cls === 'ObjectReference'), sig(calls));
check('a gamebryo call carries (name, startOver true, easeIn 0)', calls.filter((c) => c.fn === 'PlayGamebryoAnimation').every((c) => c.args.length === 3 && c.args[1] === true && c.args[2] === 0));
check('the calls that went out are logged', logs.some((l) => l === `ruinbuttons: open ${STAIRS} -> ${STAIR_OPEN.join(', ')}`), logs[logs.length - 1]);
check('the presser hears what happened out of sight', said[said.length - 1] === 'Somewhere below, stone grinds open.', said[said.length - 1]);
check('and the press is audited', /^RUINBUTTON Falcius Octavio pressed aed73:BSHeartland.esm in Telepe: 1 of 1 opened$/.test(audits[audits.length - 1]), audits[audits.length - 1]);

check('pressing it again changes nothing (no toggle back)', press(TELEPE_A) === true && calls.length === 1 && said[said.length - 1] === 'The button gives, but nothing more stirs.');
check('nor does Telepe\'s other button, which moves the same stair', press(TELEPE_B) === true && calls.length === 1);
const saidBefore = said.length;
press(TELEPE_A); press(TELEPE_B); press(TELEPE_A);
check('the "nothing more stirs" line is said once per player, not on every press', said.length === saidBefore, said.slice(saidBefore));
said.length = 0; globalThis.__dboRuinButton(fromDesc(TELEPE_A), 0xff000099);
check('a second player pressing is told once too', said.length === 1 && said[0] === 'The button gives, but nothing more stirs.');

load();
check('a hot reload keeps what is open', press(TELEPE_B) === true && calls.length === 1 && logs.some((l) => /6 buttons in 4 ruins, 1 open/.test(l)));

calls.length = 0;
check('Silorn\'s gate button opens all 13 poles with "open"', press(SILORN_GATE) === true && calls.length === 13 && calls.every((c) => c.arg === 'open' && /BSHeartland/.test(c.ref)) && new Set(calls.map((c) => c.ref)).size === 13, calls.length);
check('and says the way ahead opens', said[said.length - 1] === 'With a grinding of stone, the way ahead opens.', said[said.length - 1]);

// A late arrival (dungeons.js late join / login inside a claim): the open gamebryo stair is played for them alone
const LATE = 0xff000077;
packets.length = 0;
check('an arrival in Telepe gets its open stair as a dboRefAnim, for them alone', globalThis.__dboRuinArrived('CYRTelepeLocation', LATE) === 1 && packets.length === 1 && packets[0][0] === LATE && JSON.stringify(packets[0][1]) === JSON.stringify({ customPacketType: 'dboRefAnim', refId: fromDesc(STAIRS), name: 'Open', gamebryo: true }), packets);
packets.length = 0;
check('an arrival in Silorn gets nothing for the gate: PlayAnimation poles already reach a newcomer as lastAnimation', globalThis.__dboRuinArrived('CYRSilornLocation', LATE) === 0 && packets.length === 0);
check('the arrival is logged', logs.some((l) => l === 'ruinbuttons: Falcius Octavio arrived in CYRTelepeLocation, 1 opened sequence(s) played for them'));

calls.length = 0;
globalThis.__dboRuinLeaseEnded('CYRTelepeLocation');
check('Telepe\'s lease ending closes its stair with PlayGamebryoAnimation("Close"), and nothing in Silorn', JSON.stringify(sig(calls)) === JSON.stringify(STAIR_CLOSE) && calls.every((c) => c.ref === STAIRS), sig(calls));
packets.length = 0;
check('once closed, an arrival in Telepe gets nothing', globalThis.__dboRuinArrived('CYRTelepeLocation', LATE) === 0 && packets.length === 0);
check('the next party\'s press opens it again', press(TELEPE_B) === true && calls.length === 2 && JSON.stringify(sig(calls.slice(1))) === JSON.stringify(STAIR_OPEN));

calls.length = 0;
globalThis.__dboRuinLeaseEnded('CYRSilornLocation');
check('Silorn\'s lease ending closes the 13 poles with "close"', calls.length === 13 && calls.every((c) => c.arg === 'close'));

calls.length = 0; failOn = 'aa273:BSHeartland.esm';
check('a target the server cannot reach is logged, the player is told nothing stirred', press(SILORN_STAIRS_BTN) === true && calls.length === 0 && logs.some((l) => /ruinbuttons: PlayGamebryoAnimation\(Open\) on aa273:BSHeartland.esm failed: no such reference/.test(l)) && /0 of 1 opened/.test(audits[audits.length - 1]) && /nothing stirs\. Try it again/.test(said[said.length - 1]), said[said.length - 1]);
failOn = null;
check('and it is not recorded as open, so the next press tries again and works', press(SILORN_STAIRS_BTN) === true && calls.length === 1 && calls[0].ref === 'aa273:BSHeartland.esm' && calls[0].fn === 'PlayGamebryoAnimation' && calls[0].arg === 'Open');

// A target marked "call": "gamebryo" plays as a NIF controller sequence
{
  const data = JSON.parse(fs.readFileSync('ruin-buttons.json', 'utf8'));
  data.ruins.find((r) => r.name === 'Telepe').buttons.forEach((b) => b.targets.forEach((t) => { t.call = 'gamebryo'; t.open = 'Forward'; t.close = 'Backward'; delete t.also; }));
  fs.writeFileSync('ruin-buttons.json', JSON.stringify(data));
  delete globalThis.__dboRuinButtons; load(); calls.length = 0;
  press(TELEPE_A);
  check('a "gamebryo" target is played with PlayGamebryoAnimation(name, true, 0)', calls.length === 1 && calls[0].fn === 'PlayGamebryoAnimation' && calls[0].arg === 'Forward', calls);
  calls.length = 0; globalThis.__dboRuinLeaseEnded('CYRTelepeLocation');
  check('and closed the same way', calls.length === 1 && calls[0].fn === 'PlayGamebryoAnimation' && calls[0].arg === 'Backward', calls);
  // "also" alternatives are played after a target's own call
  const data2 = JSON.parse(fs.readFileSync('ruin-buttons.json', 'utf8'));
  data2.ruins.find((r) => r.name === 'Telepe').buttons.forEach((b) => b.targets.forEach((t) => { t.also = [{ call: 'gamebryo', open: 'Extend', close: 'Retract' }, { open: 'Up', close: 'Down' }]; }));
  fs.writeFileSync('ruin-buttons.json', JSON.stringify(data2));
  delete globalThis.__dboRuinButtons; load(); calls.length = 0;
  press(TELEPE_A);
  check('a target\'s "also" calls follow its own, each by its own kind', JSON.stringify(calls.map((c) => `${c.fn}(${c.arg})`)) === JSON.stringify(['PlayGamebryoAnimation(Forward)', 'PlayGamebryoAnimation(Extend)', 'PlayAnimation(Up)']), calls.map((c) => `${c.fn}(${c.arg})`));
}
// Rielle and Anga (dungeons.json): the same Beyond Skyrim stair behind an ordinary dungeon's button
{
  delete globalThis.__dboRuinButtons; fs.copyFileSync(DATA, 'ruin-buttons.json'); load(); calls.length = 0;
  const RIELLE_BTN = 'cbadf:BSHeartland.esm', RIELLE_STAIR = 'cbade:BSHeartland.esm', ANGA_BTN = 'b4e6e:BSHeartland.esm', ANGA_STAIR = 'b4f27:BSHeartland.esm';
  check('Rielle\'s button plays its stair\'s NIF sequence', press(RIELLE_BTN) === true && calls.length === 1 && calls[0].ref === RIELLE_STAIR && calls[0].fn === 'PlayGamebryoAnimation' && calls[0].arg === 'Open', calls);
  check('Anga\'s button plays its stair\'s NIF sequence', press(ANGA_BTN) === true && calls.length === 2 && calls[1].ref === ANGA_STAIR && calls[1].fn === 'PlayGamebryoAnimation' && calls[1].arg === 'Open', calls);
  calls.length = 0; globalThis.__dboRuinLeaseEnded('CYRRielleLocation');
  check('Rielle\'s lease ending closes only Rielle\'s stair', calls.length === 1 && calls[0].ref === RIELLE_STAIR && calls[0].arg === 'Close', calls);
  calls.length = 0; globalThis.__dboRuinLeaseEnded('CYRAngaLocation');
  check('and Anga\'s lease ending closes Anga\'s', calls.length === 1 && calls[0].ref === ANGA_STAIR && calls[0].arg === 'Close', calls);
  packets.length = 0; press(RIELLE_BTN); globalThis.__dboRuinArrived('CYRRielleLocation', LATE);
  check('a late arrival in Rielle gets its open stair too', packets.length === 1 && packets[0][1].refId === fromDesc(RIELLE_STAIR) && packets[0][1].name === 'Open', packets);
}
// A gamebryo sequence is not kept: a player who leaves the stair's cell (Rielle has two) and comes back sees it shut,
// so pressing the open stair's button again plays it for them, at most once every 30 s per player (a replay restarts
// the rise for someone who already sees it open)
{
  delete globalThis.__dboRuinButtons; fs.copyFileSync(DATA, 'ruin-buttons.json'); load(); calls.length = 0; packets.length = 0;
  const RIELLE_BTN = 'cbadf:BSHeartland.esm', RIELLE_STAIR = 'cbade:BSHeartland.esm', FRIEND = 0xff000101;
  const realNow = Date.now; let now = 1_790_000_000_000; Date.now = () => now;
  press(RIELLE_BTN);
  check('the first press sends no packet: the engine plays it to everyone in the interior', packets.length === 0 && calls.length === 1, packets);
  const to = (a) => packets.filter(([x]) => x === a).map(([, p]) => p);
  globalThis.__dboRuinButton(fromDesc(RIELLE_BTN), FRIEND);
  check('pressing the open stair\'s button again plays it for that player alone', to(FRIEND).length === 1 && to(FRIEND)[0].refId === fromDesc(RIELLE_STAIR) && to(FRIEND)[0].name === 'Open' && packets.length === 1 && calls.length === 1, packets);
  now += 10000; globalThis.__dboRuinButton(fromDesc(RIELLE_BTN), FRIEND); globalThis.__dboRuinButton(fromDesc(RIELLE_BTN), FRIEND);
  check('pressing on within 30 s replays nothing more', to(FRIEND).length === 1, packets);
  now += 21000; globalThis.__dboRuinButton(fromDesc(RIELLE_BTN), FRIEND);
  check('after 30 s a press replays it again', to(FRIEND).length === 2, packets);
  globalThis.__dboRuinButton(fromDesc(RIELLE_BTN), PLAYER);
  check('each player has their own 30 s', to(PLAYER).length === 1, packets);
  globalThis.__dboRuinLeaseEnded('CYRRielleLocation'); packets.length = 0;
  press(RIELLE_BTN); globalThis.__dboRuinButton(fromDesc(RIELLE_BTN), FRIEND);
  check('a new lease starts the count afresh', to(FRIEND).length === 1, packets);
  globalThis.__dboRuinLeaseEnded('CYRRielleLocation');
  Date.now = realNow;
}
delete globalThis.__dboRuinButtons; load({ ruinButtons: { enabled: false } });
check('switched off in config, buttons are left to the engine', press(TELEPE_A) === false);

process.chdir(home);
fs.rmSync(scratch, { recursive: true, force: true });
delete globalThis.__dboRuinButtons; delete globalThis.__dboRuinButton; delete globalThis.__dboRuinLeaseEnded;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
