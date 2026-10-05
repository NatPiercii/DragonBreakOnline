// Scripted test for craftPerks.ts and craftPerkService.ts: the player's own game holds exactly the Smithing perks the
// server's dboCraftPerks names for the character's Blacksmith tier, drops the rest, and keeps nothing of one character's
// set for the next. The pure tier->perk diff, then the real service against a stubbed game. Run from skymp5-client:
//
//   node tests/craftperks-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP craftperks (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const STEEL = 0xcb40d, DWARVEN = 0xcb40e, ELVEN = 0xcb40f, ORCISH = 0xcb410, GLASS = 0xcb411, EBONY = 0xcb412,
  DAEDRIC = 0xcb413, ADVANCED = 0xcb414, DRAGON = 0x52190, ARCANE = 0x5218e;
const T2 = [STEEL, DWARVEN, ELVEN];
const TABLE = [STEEL, DWARVEN, ELVEN, ORCISH, GLASS, EBONY, DAEDRIC, ADVANCED, DRAGON];
const sorted = (a) => Array.from(a).sort((x, y) => x - y);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const STUBS = {
  skyrimPlatform: 'module.exports = { Perk: { from: (f) => f } };',
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  customPacketUtil: `module.exports = {
    parseCustomPacket: (e) => { try { return JSON.parse(e.message.contentJsonDump); } catch { return null; } } };`,
  logging: 'module.exports = { logTrace() {}, logError: (...a) => globalThis.__perks.errors.push(a.join(" ")) };',
};
const STUB_OF = { skyrimPlatform: 'skyrimPlatform', './clientListener': 'clientListener', './customPacketUtil': 'customPacketUtil',
  '../../logging': 'logging' };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-craftperks-'));
  try {
    const outPure = path.join(tmp, 'craftPerks.js');
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/services/services/craftPerks.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: outPure, logLevel: 'error' });
    const outSvc = path.join(tmp, 'craftPerkService.js');
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/craftPerkService.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: outSvc, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    pure(require(outPure));
    driven(require(outSvc), require(outPure));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

function pure({ SMITHING_PERKS, parseCraftPerks, planCraftPerks, dropOnSpawn, SPAWN_PACKET_GRACE_MS }) {
  check('the ten Skyrim.esm Smithing perks the forge recipes name', SMITHING_PERKS.length === 10 && same(SMITHING_PERKS, TABLE.concat(ARCANE)));
  const pkt = (o) => Object.assign({ customPacketType: 'dboCraftPerks', perks: T2, managed: TABLE }, o);
  check('a packet parses', same(parseCraftPerks(pkt({})).perks, T2) && same(parseCraftPerks(pkt({})).managed, TABLE));
  check('another packet type is not ours', parseCraftPerks(pkt({ customPacketType: 'dboBeast' })) === null);
  check('a malformed id list is refused whole', parseCraftPerks(pkt({ perks: [STEEL, 'x'] })) === null && parseCraftPerks(pkt({ perks: [-1] })) === null
    && parseCraftPerks(pkt({ managed: 5 })) === null && parseCraftPerks(pkt({ perks: new Array(65).fill(STEEL) })) === null);
  check('ArcaneBlacksmith in a packet is dropped', !parseCraftPerks(pkt({ perks: [STEEL, ARCANE] })).perks.includes(ARCANE));
  check('duplicates collapse', parseCraftPerks(pkt({ perks: [STEEL, STEEL] })).perks.length === 1);

  const plan = (wanted, heldNow, granted = [], managed = TABLE) => planCraftPerks(wanted, managed, granted, (id) => heldNow.includes(id));
  let p = plan(T2, []);
  check('tier 2 from nothing: add steel, dwarven, elven', same(p.add, T2) && p.remove.length === 0, p);
  p = plan(T2, T2);
  check('already held: nothing to do', p.add.length === 0 && p.remove.length === 0, p);
  p = plan([], T2.concat(ORCISH));
  check('tier 1 (an empty set): every held Smithing perk goes', same(p.remove, T2.concat(ORCISH)) && p.add.length === 0, p);
  p = plan(T2, TABLE);
  check('a drop from tier 5 to 2 keeps tier 2 and removes the rest', same(p.remove, [ORCISH, GLASS, EBONY, DAEDRIC, ADVANCED, DRAGON]) && p.add.length === 0, p);
  p = plan(TABLE, T2);
  check('a rise to tier 5 adds the rest', same(p.add, [ORCISH, GLASS, EBONY, DAEDRIC, ADVANCED, DRAGON]) && p.remove.length === 0, p);
  p = plan([STEEL], [ARCANE]);
  check('ArcaneBlacksmith held from anywhere is removed', p.remove.includes(ARCANE), p);
  p = plan([], [0x123], [0x123], []);
  check('a perk this session granted that the table dropped is removed', same(p.remove, [0x123]), p);
  p = plan([], [0x456], [], []);
  check('an unrelated perk is never touched', p.remove.length === 0 && p.add.length === 0, p);
  p = plan([STEEL, ARCANE], []);
  check('ArcaneBlacksmith is never added', same(p.add, [STEEL]), p);
  check('a spawn right after a packet keeps it', dropOnSpawn(1000, 1000 + SPAWN_PACKET_GRACE_MS) === false);
  check('a spawn with no recent packet drops the set', dropOnSpawn(1000, 1001 + SPAWN_PACKET_GRACE_MS) === true && dropOnSpawn(0, 1e6) === true);
}

function driven({ CraftPerkService }, { CRAFT_PERK_RECHECK_MS, SPAWN_PACKET_GRACE_MS }) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const W = globalThis.__perks = { errors: [] };
    const known = new Set(TABLE.concat(ARCANE));
    const held = new Set();
    let calls = 0;
    const formOf = (id) => (known.has(id) ? { getFormID: () => id, frame: W.frame } : null);
    W.frame = 1;
    // a native object is only valid in the frame it was fetched
    const live = (perk) => { if (!perk || perk.frame !== W.frame) throw new Error('Invalid _skyrimPlatform_indexInPool'); return perk.getFormID(); };
    const player = {
      hasPerk: (p) => { calls++; return held.has(live(p)); },
      addPerk: (p) => { held.add(live(p)); },
      removePerk: (p) => { held.delete(live(p)); },
    };
    const handlers = { update: [] };
    const emitter = {};
    const sp = { Game: { getPlayer: () => player, getFormEx: (id) => formOf(id) } };
    const controller = {
      on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
      once: () => {},
      emitter: { on: (name, fn) => { emitter[name] = fn; } },
    };
    new CraftPerkService(sp, controller);
    const tick = (ms = 16) => { now += ms; W.frame++; handlers.update.forEach((fn) => fn()); };
    const packet = (perks, managed = TABLE) => emitter.customPacketMessage({ message: { contentJsonDump: JSON.stringify({ customPacketType: 'dboCraftPerks', perks, managed }) } });
    const spawn = (isMe = true) => emitter.createActorMessage({ message: { isMe } });

    held.add(GLASS);
    tick();
    check('the first update drops a Smithing perk nobody granted', held.size === 0, sorted(held));
    packet(T2);
    check('nothing changes until an update runs', held.size === 0);
    tick();
    check('a tier 2 packet grants steel, dwarven and elven', same(held, T2), sorted(held));
    packet(TABLE.slice(0, 5).concat([ADVANCED]));
    tick();
    check('a rise to tier 3 grants orcish and advanced armor (and the packet decides, not the client)', held.has(ORCISH) && held.has(ADVANCED) && held.size === 6, sorted(held));
    packet(T2);
    tick();
    check('a drop back to tier 2 (reset) removes what is above it', same(held, T2), sorted(held));
    calls = 0;
    tick();
    check('no check between packets before the recheck time', calls === 0);
    held.clear();
    tick(CRAFT_PERK_RECHECK_MS);
    check('the recheck puts back perks a game load dropped', same(held, T2), sorted(held));
    emitter.gameLoad();
    held.clear();
    tick();
    check('a game load checks at the next update', same(held, T2), sorted(held));
    check('no native object was used outside its frame', W.errors.length === 0, W.errors);

    // Character select: the next character must never keep this one's perks
    now += SPAWN_PACKET_GRACE_MS + 1;
    spawn();
    tick();
    check('a new character with no packet yet holds no Smithing perk', held.size === 0, sorted(held));
    packet([STEEL]);
    tick();
    check('its own set arrives and is granted', same(held, [STEEL]), sorted(held));
    packet([]);
    spawn();
    tick();
    check('a packet just before the spawn is kept (the server sends at assignment)', held.size === 0);
    packet(T2);
    spawn();
    tick();
    check('the new character keeps the set the server sent for it', same(held, T2), sorted(held));
    spawn(false);
    tick(CRAFT_PERK_RECHECK_MS + SPAWN_PACKET_GRACE_MS);
    check('another actor spawning changes nothing', same(held, T2), sorted(held));
    emitter.connectionDisconnect();
    tick();
    check('a lost connection drops every craft perk', held.size === 0, sorted(held));
    packet(T2);
    tick();
    emitter.connectionAccepted();
    tick();
    check('a new connection starts with none', held.size === 0, sorted(held));

    // A table perk the server later leaves out is still taken away (it was granted here)
    packet([0x777], [0x777]);
    known.add(0x777);
    tick();
    packet([], []);
    tick();
    check('a perk granted this session and no longer managed is removed', !held.has(0x777), sorted(held));
    packet([ARCANE, STEEL]);
    tick();
    check('ArcaneBlacksmith in a packet is never granted', !held.has(ARCANE) && held.has(STEEL), sorted(held));
    emitter.customPacketMessage({ message: { contentJsonDump: '{"customPacketType":"dboCraftPerks","perks":"x","managed":[]}' } });
    tick();
    check('a malformed packet changes nothing', same(held, [STEEL]), sorted(held));
    known.delete(EBONY);
    packet([STEEL, EBONY]);
    tick();
    check('a perk missing from the load order is logged and skipped', same(held, [STEEL]) && W.errors.some((e) => e.includes('not in the load order')));
  } finally {
    Date.now = realNow;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
