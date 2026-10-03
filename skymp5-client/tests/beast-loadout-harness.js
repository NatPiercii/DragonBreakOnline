// Scripted test for the Vampire Lord's loadout (beastFormService.ts, beastLoadout.ts): a spell or power the player picks
// through Favourites is kept, and the power on the Shout key reported to the server is the one picked (exsenus, 2 Oct:
// "when you switch spells it doesn't change and stays on the basic vampire lord spells"). The real BeastFormService is
// bundled with esbuild and driven by a fake engine whose native objects expire with their frame. Run from skymp5-client:
//
//   node tests/beast-loadout-harness.js [path to esbuild's package dir]
// BEAST_SERVICE=<a .ts path> bundles another copy of the service instead (the harness's own check against the old code).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP beast-loadout (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// Dawnguard (index 02) ids, as server\beastform.js ABILITIES sends them
const VL_RACE = 0x0200283a;
const DRAIN = 0x02019324, RAISE_DEAD = 0x02013ecb, CORPSE_CURSE = 0x02008a6f, GARGOYLE = 0x02016909, GRIP = 0x020038b7;
const BATS = 0x020038b9, MIST = 0x020038ba, REFLEXES = 0x020038bc, DETECT = 0x020038b8, REVERT = 0x0200cd5c;
const FLAMES = 0x00012fcd; // a human spell the player still knows
const SLOT_LEFT = 0, SLOT_RIGHT = 1, SLOT_VOICE = 2;
const SHOUT_KEY = 44, SNEAK_KEY = 29;

let frame = 0;
const native = (props) => {
  const born = frame;
  const o = {};
  for (const [k, v] of Object.entries(props)) {
    o[k] = (...a) => { if (frame !== born) throw new Error(`native object used after its frame (${k})`); return typeof v === 'function' ? v(...a) : v; };
  }
  return o;
};
const SPELL = (id) => native({ kind: 'SPEL', getFormID: id });

const STUBS = {
  skyrimPlatform: `module.exports = {
    Spell: { from: (f) => (f && f.kind && f.kind() === 'SPEL' ? f : null) },
    Shout: { from: () => null }, WordOfPower: { from: () => null }, Armor: { from: () => null },
    Perk: { from: () => null }, GlobalVariable: { from: () => null },
    Race: { from: (f) => f || null },
    DxScanCode: { Z: 44, LeftControl: 29, N1: 2, N9: 10 },
    InputDeviceType: { Keyboard: 0 },
  };`,
  './clientListener': 'module.exports = { ClientListener: class {} };',
  './customPacketUtil': `module.exports = {
    sendCustomPacket: (c, payload) => globalThis.__sent.push(payload),
    parseCustomPacket: (e) => e.content,
  };`,
  '../../logging': 'module.exports = { logError: () => {}, logTrace: () => {} };',
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-beastloadout-'));
  const out = path.join(tmp, 'beastFormService.js');
  const entry = process.env.BEAST_SERVICE || path.resolve(__dirname, '../src/services/services/beastFormService.ts');
  try {
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
      nodePaths: [path.resolve(__dirname, '../src/services/services')],
      plugins: [{
        name: 'stubs',
        setup(b) {
          const filter = new RegExp(`^(${Object.keys(STUBS).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
          b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
          // A copy of the service elsewhere (BEAST_SERVICE) still finds its helper beside the real one
          b.onResolve({ filter: /^\.\/beastLoadout$/ }, () => ({ path: path.resolve(__dirname, '../src/services/services/beastLoadout.ts') }));
        },
      }],
    });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ BeastFormService }) {
  let now = 5000000;
  Date.now = () => now;
  globalThis.__sent = [];
  const hands = { [SLOT_LEFT]: 0, [SLOT_RIGHT]: 0, [SLOT_VOICE]: 0 };
  const player = () => native({
    getFormID: 0x14,
    getEquippedSpell: (slot) => (hands[slot] ? SPELL(hands[slot]) : null),
    equipSpell: (s, slot) => { if (globalThis.__failEquip) { globalThis.__failEquip = false; throw new Error('equip failed'); } hands[slot] = s.getFormID(); },
    unequipSpell: (s, slot) => { if (hands[slot] === s.getFormID()) hands[slot] = 0; },
    addSpell: () => {}, removeSpell: () => {}, addPerk: () => {}, removePerk: () => {}, addShout: () => {}, removeShout: () => {},
    unequipAll: () => { hands[SLOT_LEFT] = hands[SLOT_RIGHT] = hands[SLOT_VOICE] = 0; },
    setRace: () => {}, equipItem: () => {},
  });
  const sp = {
    Game: {
      getPlayer: () => player(),
      getFormEx: (id) => (id === VL_RACE ? native({ kind: 'RACE', getFormID: id }) : SPELL(id)),
      setBeastForm: () => {}, forceThirdPerson: () => {}, enablePlayerControls: () => {}, getCameraState: () => 1,
    },
    Debug: { sendAnimationEvent: () => {}, notification: () => {} },
    Input: { getMappedKey: (name) => (name === 'Shout' ? SHOUT_KEY : name === 'Sneak' ? SNEAK_KEY : 0) },
  };
  const handlers = { on: {}, once: {} };
  const controller = {
    on: (n, fn) => { (handlers.on[n] = handlers.on[n] || []).push(fn); },
    once: (n, fn) => { (handlers.once[n] = handlers.once[n] || []).push(fn); },
    emitter: { on: (n, fn) => { (handlers.on[n] = handlers.on[n] || []).push(fn); } },
  };
  const fire = (n, e) => {
    frame++;
    const once = handlers.once[n] || []; handlers.once[n] = [];
    for (const fn of once) fn(e);
    for (const fn of handlers.on[n] || []) fn(e);
  };
  const tick = (ms = 1100) => { now += ms; fire('update'); };
  const key = (code) => fire('buttonEvent', { isDown: true, device: 0, code });

  new BeastFormService(sp, controller);
  const s = (id, name) => ({ id, name });
  fire('customPacketMessage', { content: { customPacketType: 'dboBeast', race: VL_RACE, beast: true, abilities: {
    right: [s(DRAIN, 'Vampiric Drain')],
    left: [s(RAISE_DEAD, 'Raise Dead'), s(CORPSE_CURSE, 'Corpse Curse'), s(GARGOYLE, 'Summon Gargoyle'), s(GRIP, "Vampire's Grip")],
    voice: [s(BATS, 'Bats'), s(MIST, 'Mist Form'), s(REFLEXES, 'Supernatural Reflexes'), s(DETECT, 'Detect Life'), s(REVERT, 'Revert Form')],
    passive: [],
  } } });
  fire('update');                                      // the dboBeast once-handler: the form and its loadout
  check('the form starts with Drain, Raise Dead and Bats', hands[SLOT_RIGHT] === DRAIN && hands[SLOT_LEFT] === RAISE_DEAD && hands[SLOT_VOICE] === BATS, hands);

  // Favourites: Corpse Curse into the left hand, then the once-a-second re-equip
  frame++; hands[SLOT_LEFT] = CORPSE_CURSE;
  tick(); tick();
  check('a form spell picked through Favourites stays in the left hand', hands[SLOT_LEFT] === CORPSE_CURSE, hands);

  // A human spell picked through Favourites is not the form's: the chosen one goes back
  frame++; hands[SLOT_LEFT] = FLAMES;
  tick();
  check("a spell that is not the form's is put back to the last form choice", hands[SLOT_LEFT] === CORPSE_CURSE, hands);

  // The engine empties the hands a few seconds in: refilled with the choice
  frame++; hands[SLOT_LEFT] = 0; hands[SLOT_RIGHT] = 0;
  tick();
  check('an emptied hand is refilled with the choice, Drain on the right', hands[SLOT_LEFT] === CORPSE_CURSE && hands[SLOT_RIGHT] === DRAIN, hands);

  // A power picked through Favourites, then the Shout key at once (before the re-equip has seen it)
  frame++; hands[SLOT_VOICE] = MIST;
  globalThis.__sent.length = 0;
  key(SHOUT_KEY);
  const power = globalThis.__sent.find((p) => p.customPacketType === 'dboBeastPower');
  check('the Shout key reports the power picked through Favourites (Mist Form)', !!power && power.spell === MIST, globalThis.__sent);
  tick();
  check('...and the re-equip keeps it', hands[SLOT_VOICE] === MIST, hands);

  // Land (the sneak key) and lift off again: the hands empty on the ground and the choice comes back in the air
  key(SNEAK_KEY);
  check('on the ground the hands are empty, the power stays', hands[SLOT_LEFT] === 0 && hands[SLOT_RIGHT] === 0 && hands[SLOT_VOICE] === MIST, hands);
  tick();
  key(SNEAK_KEY);
  check('back in the air: Drain and the chosen Corpse Curse', hands[SLOT_RIGHT] === DRAIN && hands[SLOT_LEFT] === CORPSE_CURSE, hands);

  // The number keys still choose
  key(2 + 2);                                          // N3: the third left-hand spell
  check('key 3 still picks the third left-hand spell (Summon Gargoyle)', hands[SLOT_LEFT] === GARGOYLE, hands);
  tick();
  check('...and it stays', hands[SLOT_LEFT] === GARGOYLE, hands);

  // An equip that fails leaves the old spell in hand: the next pass retries the choice, it does not adopt the old one
  globalThis.__failEquip = true;
  key(2 + 3);                                          // N4: Vampire's Grip, whose equip throws once
  check('a failed equip leaves the previous spell in hand', hands[SLOT_LEFT] === GARGOYLE, hands);
  tick();
  check("...and the next pass retries the choice (Vampire's Grip), not the spell left behind", hands[SLOT_LEFT] === GRIP, hands);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
