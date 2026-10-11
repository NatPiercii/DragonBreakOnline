// Scripted test for a beast form's Shout and Sneak keys bound to a mouse button (Nate, 10 Oct: "make sure we can use
// mouse buttons for whatever"). The launcher's game hotkeys and the game's own Controls menu can put Shout or Sneak in
// the controlmap's mouse column; the game then reports a Mouse ButtonEvent named after the event ("Shout", "Sneak").
// Drives the real beastFormService against a stubbed game: the power is reported and the Vampire Lord stance toggles
// from the keyboard key and from a mouse bind alike, and never from the gamepad or an unrelated mouse button.
// Run from skymp5-client:
//
//   node tests/beastkeys-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP beastkeys (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const WEREWOLF = 0x000cdd84, VAMPIRE_LORD = 0x0200283a, NORD = 0x00013746, VL_STATE = 0x02015fc8;
const KEYBOARD = 0, MOUSE = 1, GAMEPAD = 2;
const Z = 44, LCTRL = 29, N1 = 2;

const STUBS = {
  skyrimPlatform: `
    const W = () => globalThis.__bk;
    module.exports = {
      Shout: { from: (f) => f }, Race: { from: (f) => f }, Spell: { from: (f) => f }, Perk: { from: (f) => f },
      Armor: { from: () => null }, WordOfPower: { from: () => null },
      GlobalVariable: { from: (f) => (f && f.getFormID() === ${VL_STATE} ? { setValue: (v) => W().stance.push(v) } : null) },
      DxScanCode: { N1: 2, N9: 10, Z: 44, LeftControl: 29 }, InputDeviceType: { Keyboard: 0, Mouse: 1, Gamepad: 2, VirtualKeyboard: 3 },
    };`,
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  customPacketUtil: `module.exports = {
    parseCustomPacket: (e) => { try { return JSON.parse(e.message.contentJsonDump); } catch { return null; } },
    sendCustomPacket: (_c, p) => globalThis.__bk.sent.push(p) };`,
  logging: 'module.exports = { logTrace() {}, logError() {} };',
};
const STUB_OF = { skyrimPlatform: 'skyrimPlatform', './clientListener': 'clientListener', './customPacketUtil': 'customPacketUtil',
  '../../logging': 'logging' };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-beastkeys-'));
  try {
    const out = path.join(tmp, 'beastFormService.js');
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/beastFormService.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: out, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    driven(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

function driven({ BeastFormService }) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const make = (race) => {
      const W = globalThis.__bk = { sent: [], stance: [] };
      const formOf = (id) => (id ? { getFormID: () => id } : null);
      const st = { race: NORD };
      const player = {
        getFormID: () => 0x14, getRace: () => formOf(st.race), isDead: () => false, isBleedingOut: () => false,
        setRace: (r) => { st.race = r.getFormID(); }, unequipAll() {}, addPerk() {}, removePerk() {}, addSpell() {}, removeSpell() {},
        addShout() {}, removeShout() {}, equipShout() {}, unequipShout() {}, getEquippedShout: () => null, getEquippedSpell: () => null,
        equipSpell() {}, unequipSpell() {}, equipItem() {}, getAnimationVariableFloat: () => 0, isRunning: () => false, isSprinting: () => false,
      };
      const once = [];
      const handlers = { update: [] };
      const emitterHandlers = {};
      const sp = {
        Game: { getPlayer: () => player, getFormEx: (id) => formOf(id), setBeastForm() {}, forceThirdPerson() {}, enablePlayerControls() {},
          getCameraState: () => 9, teachWord() {}, unlockWord() {} },
        // The keyboard column: Z and Left Ctrl (a mouse bind leaves 0xff there; the stub keeps the vanilla keys)
        Input: { getMappedKey: (control) => (control === 'Shout' ? Z : control === 'Sneak' ? LCTRL : 0) },
        Debug: { notification() {}, sendAnimationEvent() {} },
      };
      const controller = {
        on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
        once: (name, fn) => { if (name === 'update') once.push(fn); },
        emitter: { on: (name, fn) => { emitterHandlers[name] = fn; } },
      };
      new BeastFormService(sp, controller);
      const tick = (ms = 600) => { now += ms; const o = once.splice(0); o.forEach((fn) => fn()); handlers.update.forEach((fn) => fn()); };
      const content = { customPacketType: 'dboBeast', race, beast: true,
        abilities: { right: [], left: [], voice: [{ id: 0xcf791, name: 'Power', shout: 0, word: 0 }], passive: [] } };
      emitterHandlers.customPacketMessage({ message: { contentJsonDump: JSON.stringify(content) } });
      tick(10);
      const press = (device, code, userEventName) => {
        now += 2000; // past the power's one-second guard
        handlers.buttonEvent.forEach((fn) => fn({ device, code, userEventName, isDown: true, isUp: false, isPressed: true, value: 1, heldDuration: 0 }));
      };
      const powers = () => W.sent.filter((p) => p.customPacketType === 'dboBeastPower').length;
      return { W, press, powers };
    };

    {
      const t = make(WEREWOLF);
      t.press(KEYBOARD, Z, 'Shout');
      check('werewolf: the keyboard Shout key reports the power', t.powers() === 1, t.W.sent);
      t.press(MOUSE, 3, 'Shout');
      check('werewolf: Shout bound to Mouse 4 (a Mouse event named Shout) reports it too', t.powers() === 2, t.W.sent);
      t.press(MOUSE, 2, 'Shout');
      check('werewolf: Shout bound to the middle button reports it too', t.powers() === 3, t.W.sent);
      t.press(KEYBOARD, Z, '');
      check('werewolf: the mapped key with no event name (a menu context) still reports it', t.powers() === 4, t.W.sent);
      t.press(MOUSE, 4, '');
      check('werewolf: an unbound mouse button reports nothing', t.powers() === 4, t.W.sent);
      t.press(MOUSE, 0, 'Right Attack/Block');
      check('werewolf: an attack click reports nothing', t.powers() === 4, t.W.sent);
      t.press(GAMEPAD, Z, 'Shout');
      check('werewolf: the gamepad (idCodes alias scan codes) reports nothing here', t.powers() === 4, t.W.sent);
      t.press(MOUSE, 3, 'Sneak');
      check('werewolf: Sneak on a mouse button touches no stance', t.W.stance.length === 0, t.W.stance);
      t.press(MOUSE, N1, '');
      check('werewolf: mouse button 2 is not the ability key 1', t.powers() === 4, t.W.sent);
    }
    {
      const t = make(VAMPIRE_LORD);
      // The form starts levitating (2); each Sneak press toggles from there
      const since = () => JSON.stringify(t.W.stance.slice(1));
      check('vampire lord: the form starts levitating', JSON.stringify(t.W.stance) === '[2]', t.W.stance);
      t.press(KEYBOARD, LCTRL, 'Sneak');
      check('vampire lord: the keyboard Sneak key toggles the stance', since() === '[1]', t.W.stance);
      t.press(MOUSE, 4, 'Sneak');
      check('vampire lord: Sneak bound to Mouse 5 toggles it back', since() === '[1,2]', t.W.stance);
      t.press(MOUSE, 4, '');
      check('vampire lord: an unbound mouse button does not', since() === '[1,2]', t.W.stance);
      t.press(GAMEPAD, LCTRL, 'Sneak');
      check('vampire lord: the gamepad does not', since() === '[1,2]', t.W.stance);
      t.press(MOUSE, 3, 'Shout');
      check('vampire lord: Shout on Mouse 4 reports the power', t.powers() === 1, t.W.sent);
    }
  } finally {
    Date.now = realNow;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
