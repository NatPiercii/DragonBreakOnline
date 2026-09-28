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
const load = (cfg) => { delete require.cache[MODULE]; require(MODULE)({ mp, log: (...a) => logs.push(a.join(' ')), personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: () => 'Falcius Octavio', cfg: cfg || {} }); };
load();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };
const press = (desc) => globalThis.__dboRuinButton(fromDesc(desc), PLAYER);

const TELEPE_A = 'aed73:BSHeartland.esm', TELEPE_B = 'af0b0:BSHeartland.esm', STAIRS = 'aed72:BSHeartland.esm';
const SILORN_GATE = 'aa641:BSHeartland.esm', SILORN_STAIRS_BTN = 'aa271:BSHeartland.esm';

check('the data loads: 4 buttons in 2 ruins', logs.some((l) => /ruinbuttons on: 4 buttons in 2 ruins, 0 open/.test(l)), logs[logs.length - 1]);
check('an unknown reference is not ours', press('12345:BSHeartland.esm') === false && calls.length === 0);

check('Telepe\'s first button is ours: the engine\'s toggling chain is blocked', press(TELEPE_A) === true);
const STAIR_OPEN = ['PlayAnimation(Open)', 'PlayGamebryoAnimation(Open)', 'PlayGamebryoAnimation(open)', 'PlayGamebryoAnimation(Forward)'];
const STAIR_CLOSE = ['PlayAnimation(closed)', 'PlayGamebryoAnimation(Close)', 'PlayGamebryoAnimation(close)', 'PlayGamebryoAnimation(Backward)'];
const sig = (cs) => cs.map((c) => `${c.fn}(${c.arg})`);
check('the stair gets every plausible open call: PlayAnimation("Open") and gamebryo Open, open, Forward', JSON.stringify(sig(calls)) === JSON.stringify(STAIR_OPEN) && calls.every((c) => c.ref === STAIRS && c.cls === 'ObjectReference'), sig(calls));
check('a gamebryo call carries (name, startOver true, easeIn 0)', calls.filter((c) => c.fn === 'PlayGamebryoAnimation').every((c) => c.args.length === 3 && c.args[1] === true && c.args[2] === 0));
check('the calls that went out are logged', logs.some((l) => l === `ruinbuttons: open ${STAIRS} -> ${STAIR_OPEN.join(', ')}`), logs[logs.length - 1]);
check('the presser hears what happened out of sight', said[said.length - 1] === 'Somewhere below, stone grinds open.', said[said.length - 1]);
check('and the press is audited', /^RUINBUTTON Falcius Octavio pressed aed73:BSHeartland.esm in Telepe: 1 of 1 opened$/.test(audits[audits.length - 1]), audits[audits.length - 1]);

check('pressing it again changes nothing (no toggle back)', press(TELEPE_A) === true && calls.length === 4 && said[said.length - 1] === 'The button gives, but nothing more stirs.');
check('nor does Telepe\'s other button, which moves the same stair', press(TELEPE_B) === true && calls.length === 4);
const saidBefore = said.length;
press(TELEPE_A); press(TELEPE_B); press(TELEPE_A);
check('the "nothing more stirs" line is said once per player, not on every press', said.length === saidBefore, said.slice(saidBefore));
said.length = 0; globalThis.__dboRuinButton(fromDesc(TELEPE_A), 0xff000099);
check('a second player pressing is told once too', said.length === 1 && said[0] === 'The button gives, but nothing more stirs.');

load();
check('a hot reload keeps what is open', press(TELEPE_B) === true && calls.length === 4 && logs.some((l) => /4 buttons in 2 ruins, 1 open/.test(l)));

calls.length = 0;
check('Silorn\'s gate button opens all 13 poles with "open"', press(SILORN_GATE) === true && calls.length === 13 && calls.every((c) => c.arg === 'open' && /BSHeartland/.test(c.ref)) && new Set(calls.map((c) => c.ref)).size === 13, calls.length);
check('and says the way ahead opens', said[said.length - 1] === 'With a grinding of stone, the way ahead opens.', said[said.length - 1]);

calls.length = 0;
globalThis.__dboRuinLeaseEnded('CYRTelepeLocation');
check('Telepe\'s lease ending closes its stair with every close name, and nothing in Silorn', JSON.stringify(sig(calls)) === JSON.stringify(STAIR_CLOSE) && calls.every((c) => c.ref === STAIRS), sig(calls));
check('the next party\'s press opens it again', press(TELEPE_B) === true && calls.length === 8 && JSON.stringify(sig(calls.slice(4))) === JSON.stringify(STAIR_OPEN));

calls.length = 0;
globalThis.__dboRuinLeaseEnded('CYRSilornLocation');
check('Silorn\'s lease ending closes the 13 poles with "close"', calls.length === 13 && calls.every((c) => c.arg === 'close'));

calls.length = 0; failOn = 'aa273:BSHeartland.esm';
check('a target the server cannot reach is logged, the player is told nothing stirred', press(SILORN_STAIRS_BTN) === true && calls.length === 0 && logs.some((l) => /ruinbuttons: PlayAnimation\(Open\) on aa273:BSHeartland.esm failed: no such reference/.test(l)) && /0 of 1 opened/.test(audits[audits.length - 1]) && /nothing stirs\. Try it again/.test(said[said.length - 1]), said[said.length - 1]);
failOn = null;
check('and it is not recorded as open, so the next press tries again and works', press(SILORN_STAIRS_BTN) === true && calls.length === 4 && calls.every((c) => c.ref === 'aa273:BSHeartland.esm') && calls[0].arg === 'Open');

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
}
delete globalThis.__dboRuinButtons; load({ ruinButtons: { enabled: false } });
check('switched off in config, buttons are left to the engine', press(TELEPE_A) === false);

process.chdir(home);
fs.rmSync(scratch, { recursive: true, force: true });
delete globalThis.__dboRuinButtons; delete globalThis.__dboRuinButton; delete globalThis.__dboRuinLeaseEnded;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
