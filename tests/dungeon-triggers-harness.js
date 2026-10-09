// One-way puzzle triggers (Nate, 9 Oct: the Echo Cave barrier "won't come back"). Echo Cave's barrier af77d has the
// defaultDisableSelfOnActivate trigger b06ad as its enable parent, and pulling chain b06ae disables it for good: the
// script goes to state Disabled, and this server never resets a cell. ruinbuttons.js now disables the trigger itself on
// the chain pull, enables it again when the dungeon's lease ends, and at load for any dungeon nobody holds. Loads the
// real ruinbuttons.js and the real disable-triggers.json and ruin-buttons.json in a scratch folder.
//   node tests/dungeon-triggers-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const data = JSON.parse(fs.readFileSync(path.join(SERVER, 'disable-triggers.json'), 'utf8'));
const echo = data.triggers.find((t) => t.ref === 'b06ad:BSHeartland.esm');
ok(echo && echo.dungeon === 'CYREchoCaveLocation' && echo.chains.includes('b06ae:BSHeartland.esm'), 'disable-triggers.json lists Echo Cave\'s trigger b06ad, pulled by chain b06ae', echo);
ok(data.triggers.every((t) => t.ref && t.dungeon && Array.isArray(t.chains)), 'every trigger names its dungeon and chains');

const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-triggers-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
for (const f of ['disable-triggers.json', 'ruin-buttons.json']) fs.copyFileSync(path.join(SERVER, f), path.join(dir, f));
process.chdir(dir);
const TRIGGER = 0x080b06ad, CHAIN = 0x080b06ae, P = 0x14;
const idOf = (d) => { const [h, p] = String(d).split(':'); return (/bsheartland/i.test(p) ? (0x08 << 24) : 0x7f000000) | parseInt(h, 16); };
const state = new Map([[TRIGGER, true]]);   // the live world: off since before 8 Oct
const audits = [], logs = [];
const load = (leases) => {
  globalThis.__dboDungeons = leases ? { leases } : undefined;
  delete require.cache[path.join(SERVER, 'ruinbuttons.js')];
  require(path.join(SERVER, 'ruinbuttons.js'))({
    mp: { getIdFromDesc: idOf, get: (id, k) => (k === 'isDisabled' ? state.get(id) === true : undefined), set: (id, k, v) => { if (k === 'isDisabled') state.set(id, v); }, callPapyrusFunction: () => {} },
    log: (...a) => logs.push(a.join(' ')), personal: () => {}, audit: (t) => audits.push(t), who: String, cfg: {}, sendPacket: () => true,
  });
};
load(new Map([['CYREchoCaveLocation', {}]]));
ok(state.get(TRIGGER) === true, 'at load, a dungeon under a lease keeps its trigger as it is (the party may have pulled it)');
load(new Map());
ok(state.get(TRIGGER) === false && logs.some((l) => /CYREchoCaveLocation no lease at load, 1 one-way trigger/.test(l)), 'at load, a dungeon nobody holds gets its trigger back on: the barrier returns', logs);
ok(globalThis.__dboRuinButton(CHAIN, P) === false, 'pulling the chain is not blocked: it plays and fires as before');
ok(state.get(TRIGGER) === true && audits.some((t) => /pulled 80b06ae in CYREchoCaveLocation: b06ad:BSHeartland\.esm off/.test(t)), '...and the trigger goes off, so the barrier drops (whatever state its script is in)', audits);
audits.length = 0;
globalThis.__dboRuinButton(CHAIN, P);
ok(state.get(TRIGGER) === true && audits.length === 0, 'pulling it again changes nothing and logs nothing');
globalThis.__dboRuinLeaseEnded('CYRAngaLocation');
ok(state.get(TRIGGER) === true, 'another dungeon\'s lease ending leaves it alone');
globalThis.__dboRuinLeaseEnded('CYREchoCaveLocation');
ok(state.get(TRIGGER) === false, 'Echo Cave\'s lease ending puts the barrier back for the next party');
ok(globalThis.__dboRuinButton(0x08012345, P) === false && state.get(TRIGGER) === false, 'any other activation is untouched');
const src = fs.readFileSync(path.join(SERVER, 'tools/spawns/disable_triggers.py'), 'utf8');
ok(/if fl & \(DISABLED \| DELETED\):/.test(src), 'the generator leaves out triggers the plugins disable (the 209 puzzle blockers stay off)');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
