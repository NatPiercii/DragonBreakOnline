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
    calls.push({ kind, cls, fn, ref: self.desc, arg: args[0] });
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
check('it plays the stair\'s open animation "Open" once, for the whole cell', calls.length === 1 && calls[0].fn === 'PlayAnimation' && calls[0].cls === 'ObjectReference' && calls[0].ref === STAIRS && calls[0].arg === 'Open', calls);
check('the presser hears what happened out of sight', said[said.length - 1] === 'Somewhere below, stone grinds open.', said[said.length - 1]);
check('and the press is audited', /^RUINBUTTON Falcius Octavio pressed aed73:BSHeartland.esm in Telepe: 1 of 1 opened$/.test(audits[audits.length - 1]), audits[audits.length - 1]);

check('pressing it again changes nothing (no toggle back)', press(TELEPE_A) === true && calls.length === 1 && said[said.length - 1] === 'The button gives, but nothing more stirs.');
check('nor does Telepe\'s other button, which moves the same stair', press(TELEPE_B) === true && calls.length === 1);

load();
check('a hot reload keeps what is open', press(TELEPE_B) === true && calls.length === 1 && logs.some((l) => /4 buttons in 2 ruins, 1 open/.test(l)));

calls.length = 0;
check('Silorn\'s gate button opens all 13 poles with "open"', press(SILORN_GATE) === true && calls.length === 13 && calls.every((c) => c.arg === 'open' && /BSHeartland/.test(c.ref)) && new Set(calls.map((c) => c.ref)).size === 13, calls.length);
check('and says the way ahead opens', said[said.length - 1] === 'With a grinding of stone, the way ahead opens.', said[said.length - 1]);

calls.length = 0;
globalThis.__dboRuinLeaseEnded('CYRTelepeLocation');
check('Telepe\'s lease ending closes its stair with "closed", and nothing in Silorn', calls.length === 1 && calls[0].ref === STAIRS && calls[0].arg === 'closed', calls);
check('the next party\'s press opens it again', press(TELEPE_B) === true && calls.length === 2 && calls[1].arg === 'Open');

calls.length = 0;
globalThis.__dboRuinLeaseEnded('CYRSilornLocation');
check('Silorn\'s lease ending closes the 13 poles with "close"', calls.length === 13 && calls.every((c) => c.arg === 'close'));

calls.length = 0; failOn = 'aa273:BSHeartland.esm';
check('a target the server cannot reach is logged, the player is told nothing stirred', press(SILORN_STAIRS_BTN) === true && calls.length === 0 && logs.some((l) => /ruinbuttons: Open on aa273:BSHeartland.esm failed: no such reference/.test(l)) && /0 of 1 opened/.test(audits[audits.length - 1]) && /nothing stirs\. Try it again/.test(said[said.length - 1]), said[said.length - 1]);
failOn = null;
check('and it is not recorded as open, so the next press tries again and works', press(SILORN_STAIRS_BTN) === true && calls.length === 1 && calls[0].ref === 'aa273:BSHeartland.esm' && calls[0].arg === 'Open');

delete globalThis.__dboRuinButtons; load({ ruinButtons: { enabled: false } });
check('switched off in config, buttons are left to the engine', press(TELEPE_A) === false);

process.chdir(home);
fs.rmSync(scratch, { recursive: true, force: true });
delete globalThis.__dboRuinButtons; delete globalThis.__dboRuinButton; delete globalThis.__dboRuinLeaseEnded;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
