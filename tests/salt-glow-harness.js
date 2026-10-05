// Sea Salt Deposits glow for Miners while they hold salt for them (GroundedPasta, 30 Sep: "Finally found salt, they
// are very small, very hard to see"), and go dark while the seam rests. Runs the real labour.js on the real
// salt-deposits.json and reads the dboGlow packets it sends.
//   node tests/salt-glow-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const LABOUR = path.join(SERVER, 'labour.js');
globalThis.performance = { now: () => 0 };
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const DEPOSITS = JSON.parse(fs.readFileSync(path.join(SERVER, 'salt-deposits.json'), 'utf8')).deposits;
// Plugin indices only have to be distinct here
const INDEX = {};
const idOf = (d) => { const [hex, plugin] = String(d).split(':'); if (!(plugin in INDEX)) INDEX[plugin] = Object.keys(INDEX).length + 1; return ((INDEX[plugin] << 24) | parseInt(hex, 16)) >>> 0; };
const REFS = DEPOSITS.map((d) => idOf(d.ref));

const MINER = 0x14, OTHER = 0x15, MINER2 = 0x16;
const SALT_BASE = 0x7f000802;   // a SeaSalt pickaxe activator, as DragonBreak.esp 000802
const props = new Map(), packets = [];
let timers = [];
let online = [MINER, OTHER];
const realSetInterval = setInterval;
const load = (labourCfg) => {
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  globalThis.clearInterval = () => {};
  timers = [];
  const cwd = process.cwd();
  process.chdir(SERVER);
  try {
    delete require.cache[require.resolve(LABOUR)];
    require(LABOUR)({
      mp: { getIdFromDesc: idOf, get: (id, p) => props.get(id + '|' + p), set: (id, p, v) => props.set(id + '|' + p, v), lookupEspmRecordById: (id) => (id === SALT_BASE ? { record: { type: 'ACTI', editorId: '12SeaSaltMinepickaxeDUPLICATE003' } } : null) },
      log: () => {}, personal: () => {}, audit: () => {}, display: () => 'Tester', who: () => 'Tester', cfg: { labour: labourCfg || {} },
      openWidget: () => true, closeWidget: () => true, onUi: () => {}, giveItem: () => true,
      skills: require(path.join(SERVER, 'skills.json')),
      sendPacket: (a, p) => packets.push([a, p]), onlineActors: () => online.slice(),
    });
  } finally { process.chdir(cwd); globalThis.setInterval = realSetInterval; }
};
const glowFor = (a) => {
  packets.length = 0;
  globalThis.__dboSaltGlow(a);
  const on = new Set(), off = new Set();
  for (const [who, p] of packets) if (who === a && p.customPacketType === 'dboGlow') p.refs.forEach((r) => (p.on ? on : off).add(r));
  return { on, off, kinds: new Set(packets.map(([, p]) => p.kind)) };
};

props.set(MINER + '|private.mastery', { order: ['miner'], skills: { miner: { rank: 0 } } });
props.set(OTHER + '|private.mastery', { order: ['cook'], skills: { cook: { rank: 2 } } });
load();

ok(DEPOSITS.length >= 60 && DEPOSITS.every((d) => /:/.test(d.ref)), `salt-deposits.json lists the deposits (${DEPOSITS.length})`);
const bruma = DEPOSITS.filter((d) => /^a764b:BSHeartland\.esm$/i.test(d.where)).map((d) => d.ref.toLowerCase());
const PLACED = ['154058', '15405a', '15405c', '154060', '154062', '154066', '15406c', '15406e', '15404e', '15404c', '154054'].map((x) => `${x}:dragonbreak online edits.esp`)
  .concat(['89b58', 'd1b46', 'b61b5', 'c84c1', 'b5a58'].map((x) => `${x}:bsheartland.esm`));
ok(PLACED.every((r) => bruma.includes(r)), 'every Bruma deposit the salt-deposits harness knows is in the list', PLACED.filter((r) => !bruma.includes(r)));
ok(timers.length === 1 && timers[0].ms === 30000, 'one glow tick, every 30 seconds', timers.map((t) => t.ms));

let g = glowFor(MINER);
ok(g.on.size === REFS.length && g.off.size === 0, 'a first-rank Miner sees every deposit glow while none rests', { on: g.on.size, off: g.off.size });
ok(g.kinds.size === 1 && g.kinds.has('loot'), "the glow is the camp chests' kind, loot");
g = glowFor(OTHER);
ok(g.on.size === 0 && g.off.size === REFS.length, 'someone who has not taken up Mining sees none (and is told so, for a narrowed audience)', { on: g.on.size, off: g.off.size });

// a worked seam rests for everyone (the shared rest on the reference), and for its worker
props.set(REFS[0] + '|private.dboWorkedUntil', Date.now() + 45 * 60000);
props.set(MINER + '|private.minedVeins', { [REFS[1].toString(16)]: Date.now() + 60000 });
g = glowFor(MINER);
ok(!g.on.has(REFS[0]) && g.off.has(REFS[0]), 'a seam resting for everyone goes dark');
ok(!g.on.has(REFS[1]) && g.off.has(REFS[1]), "a seam resting for this Miner goes dark");
ok(g.on.size === REFS.length - 2, 'the rest still glow', g.on.size);
props.set(REFS[0] + '|private.dboWorkedUntil', Date.now() - 1000);
ok(glowFor(MINER).on.has(REFS[0]), 'a rest that ran out lights it again');

// the tick sends to everyone online
packets.length = 0;
timers[0].fn();
ok(new Set(packets.map(([a]) => a)).size === 2, 'the tick reaches every player online');

// a round on a deposit darkens it for every other Miner at once, not at the next tick (Worker G's review)
online = [MINER, OTHER, MINER2];
props.set(MINER2 + '|private.mastery', { order: ['miner'], skills: { miner: { rank: 0 } } });
const DEP = REFS[5];
props.set(DEP + '|baseDesc', (SALT_BASE & 0xffffff).toString(16) + ':SaltBase.esp');
INDEX['SaltBase.esp'] = SALT_BASE >>> 24;
packets.length = 0;
const opened = globalThis.__dboLabour(DEP, MINER);
const one = (a) => packets.filter(([w, p]) => w === a && p.customPacketType === 'dboGlow' && p.refs.length === 1 && p.refs[0] === DEP).map(([, p]) => p.on);
ok(opened === true, 'the first Miner opens a round on the deposit');
ok(JSON.stringify(one(MINER2)) === '[false]', 'the other Miner is told at once that it went dark', one(MINER2));
ok(JSON.stringify(one(MINER)) === '[true]', 'the worker still sees their own seam lit', one(MINER));
ok(one(OTHER).length === 0, 'someone outside the audience is not sent anything');
ok(!glowFor(MINER2).on.has(DEP), "...and the other Miner's next tick agrees");
online = [MINER, OTHER];

// config: everyone, and off
load({ saltGlow: { enabled: true, audience: 'everyone' } });
ok(glowFor(OTHER).on.size > 0, "audience 'everyone' lights them for a non-Miner too");
load({ saltGlow: { enabled: false } });
g = glowFor(MINER);
ok(g.on.size === 0 && g.off.size === REFS.length, 'enabled false turns every glow off, for Miners too');
load({ saltGlow: { seconds: 10 } });
ok(timers[0].ms === 10000, 'the tick follows seconds');

// gamemode.js passes what the glow needs and lights it at login
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
ok(/require\(LABOUR_JS\)\(\{[^}]*sendPacket, onlineActors(, [^}]*)? \}\)/.test(gm), 'gamemode.js hands labour.js sendPacket and onlineActors');
ok(/__dboSaltGlow\(a\)/.test(gm), 'gamemode.js lights the glow at login');

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
