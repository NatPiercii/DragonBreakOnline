// Camp chests are for players (Nate's goblin report, 1 Oct 2026): a camp's own goblin or giant whose AI opens the chest
// was handed the hourly camp loot (log 30 Sep 23:45:51: "CAMP Stranger #MY4R (profile -1) looted Dusk Thorn Camp: 26x
// Gold, ... DwarvenBow", the Goblin Warlord). An NPC is still turned away, but takes nothing, starts no cooldown and is
// told nothing. Live-then-new: the release's wildlife.js first, then this one over the same globalThis state.
//   node tests/camp-chest-players-only-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SRC = path.resolve(__dirname, '..', 'wildlife.js');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-campchest-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
const cwd = process.cwd();
fs.writeFileSync(path.join(dir, 'wildlife.json'), JSON.stringify({ placements: [], giantCamps: [
  { id: 'DuskThornCamp', name: 'Dusk Thorn Camp', owners: 'goblins', chests: [{ ref: '1234:Test.esp' }] },
] }));
fs.writeFileSync(path.join(dir, 'loot.json'), JSON.stringify({ pools: {} }));
fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ patterns: [] }));
const CHEST = 0x09001234, PLAYER = 0xff000014, WARLORD = 0xff0002f3;
const props = new Map(), said = [], audits = [], given = [];
const mp = {
  get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => { const [h, p] = String(d).split(':'); if (String(p).toLowerCase() !== 'test.esp') throw new Error('no plugin'); return ((0x09 << 24) | parseInt(h, 16)) >>> 0; },
};
globalThis.__dboWildFactionAudit = ' (skipped in the harness)';
const load = (file) => {
  process.chdir(dir);
  try {
    delete require.cache[file];
    require(file)({ mp, log: () => {}, personal: (a, t) => said.push([a, t]), system: () => {}, registerChatCommand: () => {},
      giveItem: (a, id, n) => { given.push([a, id, n]); return true; }, profileOf: (a) => ((a >>> 0) === PLAYER ? 2 : -1), display: String, who: (a) => `P${(a >>> 0).toString(16)}`,
      audit: (t) => audits.push(t), isAdmin: () => false, cfg: {}, onlineActors: () => [PLAYER], sendPacket: () => {} });
  } finally { process.chdir(cwd); }
};
const reset = () => { said.length = 0; audits.length = 0; given.length = 0; props.delete(`${WARLORD}|private.campLoot`); props.delete(`${PLAYER}|private.campLoot`); };

try {
  // The release's version, when git can show it: the warlord loots
  let old = null;
  try { old = execFileSync('git', ['-C', path.resolve(__dirname, '..'), 'show', 'HEAD:wildlife.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { old = null; }
  if (old && !/Camp loot is for players/.test(old)) {
    const oldFile = path.join(dir, 'wildlife-old.js'); fs.writeFileSync(oldFile, old);
    load(oldFile);
    reset();
    globalThis.__dboCampChest(CHEST, WARLORD);
    ok(audits.some((t) => /CAMP Pff0002f3 looted Dusk Thorn Camp/.test(t)) && props.has(`${WARLORD}|private.campLoot`), 'before: the warlord loots its camp chest and starts its cooldown', audits);
  } else console.log('ok    skipped the before case (HEAD already has the fix, or git cannot show it)');

  load(SRC);   // the new module over the same state
  reset();
  const v = globalThis.__dboCampChest(CHEST, WARLORD);
  ok(v === false, 'an NPC opening the camp chest is still turned away');
  ok(!audits.length && !given.length && !said.length && !props.has(`${WARLORD}|private.campLoot`), '...and takes nothing, starts no cooldown and is told nothing', { audits, given, said });
  reset();
  ok(globalThis.__dboCampChest(CHEST, PLAYER) === false && audits.some((t) => /CAMP Pff000014 looted Dusk Thorn Camp/.test(t)) && props.has(`${PLAYER}|private.campLoot`), 'a player still rummages through it as before', audits);
  ok(globalThis.__dboCampChest(0x09009999, WARLORD) === null, 'anything that is not a camp chest is not its business');
} finally { process.chdir(cwd); }

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
