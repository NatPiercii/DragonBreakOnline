// Staff hits, the gameplay half (fork client-staff-hits sends a staff hit as its enchantment, fork staff-hits lands it
// through OnSpellHit):
//   - isConcentration reads a staff enchantment's ENIT, so a Sparks staff is held to one damaging hit a second;
//   - combat.js paces a fire-and-forget staff's hits like a spell's (spellHitMinMs);
//   - the staff trace: /staffdiag (Lead GM and above) or the login switch opens a window, the client's "staff shot"
//     lines are written to the log only inside one, at most 60 a window.
// Lifts the blocks out of gamemode.js and runs them on stubs.
//   node tests/staff-hits-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const cut = (start, end) => { const a = SRC.indexOf(start), b = SRC.indexOf(end, a); return a < 0 || b < 0 ? null : SRC.slice(a, b); };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

// ---- records: what the client now names as a staff hit's source ------------------------------------------------------
const u32 = (n, at, size) => { const d = new Uint8Array(size); new DataView(d.buffer).setUint32(at, n, true); return d; };
const SPARKS_SPELL = 0x2dd29, FIREBOLT_SPELL = 0x12fd0, SPARKS_ENCH = 0x4dedc, FIREBOLT_ENCH = 0x4c6cb, STAFF = 0x4dee2, SHORT_ENIT = 0x7000001;
const RECS = {
  [SPARKS_SPELL]: { type: 'SPEL', fields: [{ type: 'SPIT', data: u32(2, 16, 36) }] },
  [FIREBOLT_SPELL]: { type: 'SPEL', fields: [{ type: 'SPIT', data: u32(1, 16, 36) }] },
  // ENIT as on Skyrim.esm: cast type at offset 8 (StaffEnchSparks 2, StaffEnchFirebolt 1)
  [SPARKS_ENCH]: { type: 'ENCH', fields: [{ type: 'ENIT', data: u32(2, 8, 36) }] },
  [FIREBOLT_ENCH]: { type: 'ENCH', fields: [{ type: 'ENIT', data: u32(1, 8, 36) }] },
  [SHORT_ENIT]: { type: 'ENCH', fields: [{ type: 'ENIT', data: new Uint8Array(8) }] },
  [STAFF]: { type: 'WEAP', fields: [{ type: 'DNAM', data: new Uint8Array([8, 0, 0, 0]) }] },
};
const recordOf = (id) => (RECS[id] ? { record: RECS[id] } : null);

// ---- isConcentration ---------------------------------------------------------------------------------------------------
const CONC = cut('// castType 2 = concentration', '// Two actors that are neither');
if (!CONC) { console.log('FAIL the concentration block is gone from gamemode.js'); process.exit(1); }
delete globalThis.__dboConcCache;
const isConcentration = new Function('recordOf', CONC + '\nreturn isConcentration;')(recordOf);
ok(isConcentration(SPARKS_SPELL) === true && isConcentration(FIREBOLT_SPELL) === false, 'spells: unchanged (SPIT cast type at 16)');
ok(isConcentration(SPARKS_ENCH) === true, "a Sparks staff's enchantment is concentration (ENIT cast type at 8), so the 1/s limit holds it");
ok(isConcentration(FIREBOLT_ENCH) === false, "a Firebolt staff's enchantment is not");
ok(isConcentration(SHORT_ENIT) === false && isConcentration(STAFF) === false && isConcentration(0x1234) === false, 'a short ENIT, a weapon, an unknown id: not concentration');

// ---- combat.js: a fire-and-forget staff is paced like a spell -----------------------------------------------------------
delete globalThis.__dboCombat; delete globalThis.__dboSpellHitAt;
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
const combat = require(path.join(SERVER, 'combat.js'))({
  mp: { get: () => null, set: () => {}, getDescFromId: (a) => `${a.toString(16)}:x`, callPapyrusFunction: () => {} },
  log: () => {}, profileOf: (a) => (a === 1 ? 1 : -1), masteryOf: () => null, wornOf: () => [], recordOf,
  fieldsOf: (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t), weaponSkillOf: () => '', display: String, cfg,
  sendPacket: () => {},
});
const minMs = Number(((cfg.combat || {}).spellHitMinMs) ?? 600);
const t0 = 1e12;
ok(combat.spellHitAllowed(1, 2, FIREBOLT_ENCH, t0) === true, 'a Firebolt staff hit lands');
ok(combat.spellHitAllowed(1, 2, FIREBOLT_ENCH, t0 + 100) === (minMs > 0 ? false : true), `...a second one 100 ms later on the same target does not (spellHitMinMs ${minMs})`);
ok(combat.spellHitAllowed(1, 3, FIREBOLT_ENCH, t0 + 100) === true, '...another target in the same volley does');
ok(combat.spellHitAllowed(1, 2, FIREBOLT_ENCH, t0 + minMs + 1) === true, '...and the same target after the interval');
ok(combat.spellHitAllowed(1, 2, STAFF, t0 + 50) === true, 'a weapon source is not paced here');

// ---- the staff trace ---------------------------------------------------------------------------------------------------
const TRACE = cut('// The staff trace (client staffHit.ts)', '// How hosts repair a split body');
if (!TRACE) { console.log('FAIL the staff trace block is gone from gamemode.js'); process.exit(1); }
const P1 = 0xff000014, P2 = 0xff000015;
const NAMES = { [P1]: 'Ayla', [P2]: 'Borin' };
let logs, packets, said, audits, handlers, commands;
const load = (conf) => {
  logs = []; packets = []; said = []; audits = []; handlers = {}; commands = {};
  return new Function('cfg', 'sendPacket', 'onUi', 'log', 'display', 'registerChatCommand', 'personal', 'findByName', 'audit', 'who', TRACE)(
    conf,
    (a, p) => { packets.push([a, p]); return true; },
    (ev, fn) => { handlers[ev] = fn; },
    (...x) => logs.push(x.join(' ')),
    (a) => NAMES[a] || 'someone',
    (name, fn, opts) => { commands[name] = { fn, opts }; },
    (a, t) => said.push(t),
    (q) => (String(q).toLowerCase() === 'borin' ? P2 : 0),
    (t) => audits.push(t),
    (a) => NAMES[a] || 'someone',
  );
};
delete globalThis.__dboStaffDiag; delete globalThis.__dboStaffDiagLogin;
load({});
const shot = (a, line) => handlers.staffShot(a, [line]);
const LINE = 'staff shot: aggr 14 -> tgt ff000301 | source WEAP 7602648 (type 41, weapon type 8, ench 4dedc) proj - | equipped R 7602648 (weapon type 8) ench 4dedc, L - | events 2 | sent ENCH 4dedc (via weapon)';
shot(P2, LINE);
ok(logs.length === 0, 'no window: a client cannot write staff lines to the log on its own', logs);
ok(commands.staffdiag && commands.staffdiag.opts.admin === true, '/staffdiag is a staff command');
const LEAD = (SRC.match(/const LEAD_ONLY = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
ok(/'staffdiag'/.test(LEAD), '...and Lead GM and above (LEAD_ONLY)');
commands.staffdiag.fn(P1, '');
ok(/Usage: \/staffdiag/.test(said.pop() || ''), 'no player named: usage');
commands.staffdiag.fn(P1, 'nobody 60');
ok(/No player matches "nobody"/.test(said.pop() || ''), 'an unknown player: said so');
commands.staffdiag.fn(P1, 'Borin 60');
ok(packets.length === 1 && packets[0][0] === P2 && packets[0][1].customPacketType === 'dboStaffDiag' && packets[0][1].seconds === 60, 'opens the window on that player\'s client', packets);
ok(audits.some((t) => /\/staffdiag Borin for 60 s/.test(t)) && /grep "staff shot"/.test(said.pop() || ''), '...audited, and the caller is told where to look');
shot(P2, LINE);
ok(logs.length === 1 && logs[0].startsWith('staff shot Borin: aggr 14 -> tgt ff000301') && logs[0].endsWith('sent ENCH 4dedc (via weapon)'), 'inside the window a shot is one log line, named for the player', logs);
shot(P1, LINE);
ok(logs.length === 1, "another player's lines are not written (their window is not open)");
shot(P2, 'staff shot: a\nfake line\r\nstaff shot Ayla: forged');
ok(!/[\r\n]/.test(logs[1] || '') && logs.length === 2, 'line breaks are flattened, so a line cannot forge another', logs[1]);
for (let i = 0; i < 80; i++) shot(P2, LINE);
ok(logs.length === 60, 'at most 60 lines a window', logs.length);
commands.staffdiag.fn(P1, 'Borin 5');
ok(packets[packets.length - 1][1].seconds === 30, 'a window shorter than 30 s is raised to 30', packets[packets.length - 1]);
shot(P2, LINE);
ok(logs.length === 61, 'reopening gives a fresh allowance');
commands.staffdiag.fn(P1, 'Borin 99999');
ok(packets[packets.length - 1][1].seconds === 900, 'longer than 15 minutes is capped at 900 s');
commands.staffdiag.fn(P1, 'Borin');
ok(packets[packets.length - 1][1].seconds === 600, 'no seconds: 10 minutes');
const realNow = Date.now;
Date.now = () => realNow() + 606000;
shot(P2, LINE);
Date.now = realNow;
ok(logs.length === 61, 'after the window (and a 5 s grace) lines are ignored');

// A hot reload keeps an open window
const before = globalThis.__dboStaffDiag;
commands.staffdiag.fn(P1, 'Borin 60');
load({});
ok(globalThis.__dboStaffDiag === before && before.has(P2 >>> 0), 'a hot reload keeps the open windows');
shot(P2, LINE);
ok(logs.length === 1, '...and lines still land after it');

// The login switch
load({});
globalThis.__dboStaffDiagLogin(P1);
ok(packets.length === 0, 'at login, staffHitDiag off (the default): no window');
load({ staffHitDiag: { enabled: true, seconds: 300 } });
globalThis.__dboStaffDiagLogin(P1);
ok(packets.length === 1 && packets[0][1].seconds === 300, 'staffHitDiag on: every login opens one for its seconds', packets);
const JOIN = cut('    try { if (globalThis.__dboJailLogin)', '    needsOnConnect(a);') || '';
ok(/__dboStaffDiagLogin\(a\)/.test(JOIN), 'the join sequence calls the login switch');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
