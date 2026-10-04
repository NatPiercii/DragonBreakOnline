// Scripted test for beastHowl.ts and beastFormService.ts: a werewolf howl is held only while this client took the
// form, the race is the form's, and the player is neither dead nor bleeding out; every way out strips it (G8, 0.3.77).
// Drives the real service against a stubbed game. Run from skymp5-client:
//
//   node tests/beasthowl-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP beasthowl (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const WEREWOLF = 0x000cdd84, NORD = 0x00013746;
const TERROR = 0x000cf790, TOTEM = 0x000ce218;

const STUBS = {
  skyrimPlatform: `
    const W = () => globalThis.__howl;
    const form = (id) => (id ? { getFormID: () => id } : null);
    const known = (id) => W().forms.has(id) ? form(id) : null;
    module.exports = {
      Shout: { from: (f) => (f ? f : null) }, Race: { from: (f) => f }, Spell: { from: (f) => f }, Perk: { from: (f) => f },
      Armor: { from: () => null }, GlobalVariable: { from: () => null }, WordOfPower: { from: () => null },
      DxScanCode: { N1: 2, N9: 10, Z: 44, LeftControl: 29 }, InputDeviceType: { Keyboard: 0 },
      __known: known,
    };`,
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  customPacketUtil: `module.exports = {
    parseCustomPacket: (e) => { try { return JSON.parse(e.message.contentJsonDump); } catch { return null; } },
    sendCustomPacket: () => {} };`,
  logging: 'module.exports = { logTrace() {}, logError: (...a) => globalThis.__howl.errors.push(a.join(" ")) };',
};
const STUB_OF = { skyrimPlatform: 'skyrimPlatform', './clientListener': 'clientListener', './customPacketUtil': 'customPacketUtil',
  '../../logging': 'logging' };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-beasthowl-'));
  try {
    const outPure = path.join(tmp, 'beastHowl.js');
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/services/services/beastHowl.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: outPure, logLevel: 'error' });
    const outSvc = path.join(tmp, 'beastFormService.js');
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/beastFormService.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: outSvc, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    pure(require(outPure));
    driven(require(outSvc));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

function pure({ HOWL_SHOUTS, mayHoldHowl, howlShoutIds, stripDue, HOWL_RECHECK_MS }) {
  const f = (o) => Object.assign({ serviceBeastRace: WEREWOLF, raceId: WEREWOLF, dead: false, bleedingOut: false }, o);
  check('the two vanilla howl shouts (read out of Skyrim.esm)', HOWL_SHOUTS.length === 2 && HOWL_SHOUTS.includes(TERROR) && HOWL_SHOUTS.includes(TOTEM));
  check('a living werewolf this client transformed may hold a howl', mayHoldHowl(f({})) === true);
  check('back in the own race: no', mayHoldHowl(f({ serviceBeastRace: 0, raceId: NORD })) === false);
  check('dead in the form: no', mayHoldHowl(f({ dead: true })) === false);
  check('down (bleeding out) in the form: no', mayHoldHowl(f({ bleedingOut: true })) === false);
  check('werewolf race but this client never saw the form start: no (fails closed)', mayHoldHowl(f({ serviceBeastRace: 0 })) === false);
  check('the service thinks werewolf but the race is human (lost revert, relog): no', mayHoldHowl(f({ raceId: NORD })) === false);
  check('learned ids are added once', JSON.stringify(howlShoutIds([TERROR, 0x123, 0x123, 0, NaN]).sort()) === JSON.stringify([TERROR, TOTEM, 0x123].sort()));
  check('strip on the change to may-not', stripDue(false, true, 0, 1000, false) === true);
  check('strip on the first check', stripDue(false, undefined, 0, 1000, false) === true);
  check('no strip again right after', stripDue(false, false, 1000, 1500, false) === false);
  check('strip again after the recheck time', stripDue(false, false, 1000, 1000 + HOWL_RECHECK_MS, false) === true);
  check('a forced check (new connection) strips at once', stripDue(false, false, 1000, 1500, true) === true);
  check('never while the howl is allowed', stripDue(true, false, 0, 1e9, true) === false);
}

function driven({ BeastFormService }) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const make = () => {
      const W = globalThis.__howl = { forms: new Set([TERROR, TOTEM, WEREWOLF, NORD, 0xcf791, 0xce217]), errors: [] };
      const st = { race: NORD, dead: false, bleeding: false, shouts: new Set(), equipped: 0, adds: 0 };
      const formOf = (id) => (W.forms.has(id) ? { getFormID: () => id } : null);
      const player = {
        getFormID: () => 0x14, getRace: () => formOf(st.race), isDead: () => st.dead, isBleedingOut: () => st.bleeding,
        setRace: (r) => { st.race = r.getFormID(); }, unequipAll() {}, addPerk() {}, removePerk() {}, addSpell() {}, removeSpell() {},
        addShout: (s) => { st.shouts.add(s.getFormID()); st.adds++; }, removeShout: (s) => st.shouts.delete(s.getFormID()),
        equipShout: (s) => { st.equipped = s.getFormID(); }, unequipShout: (s) => { if (st.equipped === s.getFormID()) st.equipped = 0; },
        getEquippedShout: () => (st.equipped ? formOf(st.equipped) : null), getEquippedSpell: () => null, equipSpell() {}, unequipSpell() {},
        equipItem() {}, getAnimationVariableFloat: () => 0, isRunning: () => false, isSprinting: () => false,
      };
      const once = [];
      const handlers = { update: [] };
      const emitterHandlers = {};
      const sp = {
        Game: { getPlayer: () => player, getFormEx: (id) => formOf(id), setBeastForm() {}, forceThirdPerson() {}, enablePlayerControls() {},
          getCameraState: () => 9, teachWord() {}, unlockWord() {} },
        Input: { getMappedKey: () => 44 }, Debug: { notification() {}, sendAnimationEvent() {} },
      };
      const controller = {
        on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
        once: (name, fn) => { if (name === 'update') once.push(fn); },
        emitter: { on: (name, fn) => { emitterHandlers[name] = fn; } },
      };
      new BeastFormService(sp, controller);
      const tick = (ms = 600) => { now += ms; const o = once.splice(0); o.forEach((fn) => fn()); handlers.update.forEach((fn) => fn()); };
      const beast = (on) => {
        const content = { customPacketType: 'dboBeast', race: on ? WEREWOLF : NORD, beast: on,
          abilities: on ? { right: [], left: [], voice: [{ id: 0xcf791, name: 'Howl of Terror', shout: TERROR, word: 0 }, { id: 0xce217, name: 'Totem', shout: TOTEM, word: 0 }], passive: [] } : undefined };
        emitterHandlers.customPacketMessage({ message: { contentJsonDump: JSON.stringify(content) } });
        tick(10);
      };
      return { st, tick, beast, emitterHandlers };
    };

    {
      const t = make();
      t.beast(true); t.tick(); t.tick(1500);
      check('taking the form grants both howls', t.st.shouts.has(TERROR) && t.st.shouts.has(TOTEM), [...t.st.shouts]);
      check('...and keeps them while in form', (t.tick(), t.st.shouts.size === 2));
      t.beast(false); t.tick();
      check('transforming back removes them', t.st.shouts.size === 0, [...t.st.shouts]);
    }
    {
      const t = make();
      t.beast(true); t.tick(); t.st.equipped = TERROR;
      t.st.dead = true; t.tick(); t.tick(1200);
      check('death in the form removes them and unequips the howl', t.st.shouts.size === 0 && t.st.equipped === 0, [...t.st.shouts, t.st.equipped]);
      check('...and the once-a-second re-equip does not hand one back', (t.tick(1200), t.tick(1200), t.st.shouts.size === 0));
    }
    {
      const t = make();
      t.beast(true); t.tick();
      t.st.bleeding = true; t.tick(); t.tick(1200);
      check('a down in the form removes them', t.st.shouts.size === 0, [...t.st.shouts]);
      t.st.bleeding = false; t.tick(1200); t.tick(1200);
      check('...and revived still in the form, the voice slot equips the howl again', t.st.shouts.has(TERROR), [...t.st.shouts]);
    }
    {
      const t = make();
      t.beast(true); t.tick();
      // The end packet never came (a beast-form timeout whose dboBeast was lost) but the race was put back
      t.st.race = NORD; t.tick();
      check('race back to own without a revert this client saw: removed', t.st.shouts.size === 0, [...t.st.shouts]);
    }
    {
      // A new session (relog or reload): the howl is still in the game process, the client never saw the form start
      const t = make();
      t.st.shouts.add(TERROR); t.st.equipped = TERROR; t.st.race = WEREWOLF;
      t.tick();
      check('fails closed: a howl held when the client never saw the form start is removed, even on a werewolf race', t.st.shouts.size === 0 && t.st.equipped === 0, [...t.st.shouts]);
    }
    {
      const t = make();
      t.tick(); t.tick(1000);
      t.st.shouts.add(TERROR); // added behind the service's back
      t.emitterHandlers.connectionAccepted(); t.tick(10);
      check('a new connection strips at once', t.st.shouts.size === 0, [...t.st.shouts]);
      t.st.shouts.add(TOTEM); t.tick(600);
      check('...otherwise not every frame', t.st.shouts.has(TOTEM));
      t.tick(10000);
      check('...but within the recheck time', t.st.shouts.size === 0, [...t.st.shouts]);
    }
  } finally {
    Date.now = realNow;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
