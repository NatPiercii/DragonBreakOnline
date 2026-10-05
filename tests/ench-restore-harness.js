// One-off restore of enchantments learned before the server recorded them (alchemy.js restoreOnce, ench-restore-1005.json;
// Nate, 5 Oct). At a listed character's next login the missing effects join private.dboEnchLearned once (marker), the
// profile must match, it is audited, and the login packet then carries them. Part 1 runs alchemy.js in a scratch folder
// with a made-up list; part 2 checks the shipped list against the dry run in claude-nate-release/specs.
//   node tests/ench-restore-harness.js   (from server/)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const SERVER = path.resolve(__dirname, '..');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(SERVER, 'ench-restore-1005.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-ench-restore-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(dir);

const A = 0xff001ed0, B = 0xff001602, C = 0xff000304;
fs.writeFileSync('ench-restore-1005.json', JSON.stringify({ marker: '1005', actors: {
  [A.toString(16)]: { name: 'Old Grimbo #SB5X', profileId: 37, effects: [0x5b452, 0x5b451] },
  [B.toString(16)]: { name: 'Lorian #US6N', profileId: 53, effects: [0x7a0fa] },
} }));
const props = new Map();
const put = (id, p, v) => props.set((id >>> 0) + '|' + p, v);
const packets = [], logs = [], audits = [];
const mp = { get: (id, p) => props.get((id >>> 0) + '|' + p), set: (id, p, v) => put(id, p, v), getIdFromDesc: () => 0, getDescFromId: (id) => `${id.toString(16)}:x`, lookupEspmRecordById: () => null };
const load = (cfg) => {
  delete require.cache[path.join(SERVER, 'alchemy.js')];
  require(path.join(SERVER, 'alchemy.js'))({ mp, log: (...x) => logs.push(x.join(' ')), personal: () => {}, audit: (t) => audits.push(t), display: () => 'the player', who: () => 'the player',
    openWidget: () => {}, closeWidget: () => {}, every: () => {}, itemName: () => '', cfg, sendPacket: (a, pk) => packets.push([a, pk]) });
};
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const learned = (a) => mp.get(a, 'private.dboEnchLearned') || [];

load({ learnedEnchantments: { enabled: true, max: 256 } });
put(A, 'profileId', 37); put(A, 'private.dboEnchLearned', [0x5b452]);
globalThis.__dboEnchLearnedLogin(A);
ok(JSON.stringify(learned(A)) === JSON.stringify([0x5b452, 0x5b451]), 'a listed character gets the missing effects, none twice', learned(A));
ok(mp.get(A, 'private.dboEnchRestore') === '1005', '...and the marker');
ok(audits.length === 1 && /ENCH-RESTORE the player given back 1 learned enchantment effect\(s\) \[5b451\]/.test(audits[0]), '...audited with what was added', audits);
const sent = packets.find(([a, p]) => a === A && p.customPacketType === 'dboEnchLearned');
ok(sent && JSON.stringify(sent[1].effects) === JSON.stringify([0x5b452, 0x5b451]), 'the same login\'s packet carries them', packets);
put(A, 'private.dboEnchLearned', []);
globalThis.__dboEnchLearnedLogin(A);
ok(learned(A).length === 0 && audits.length === 1, 'once only: the next login adds nothing again (even after the list was emptied)');
put(B, 'profileId', 99);
globalThis.__dboEnchLearnedLogin(B);
ok(learned(B).length === 0 && !mp.get(B, 'private.dboEnchRestore') && logs.some((l) => /restore for the player skipped: profile 99/.test(l)), 'a profile that does not match is skipped, logged, and left to try again');
put(B, 'profileId', 53);
globalThis.__dboEnchLearnedLogin(B);
ok(JSON.stringify(learned(B)) === JSON.stringify([0x7a0fa]), '...and given at a login with the right profile');
put(C, 'profileId', 40);
globalThis.__dboEnchLearnedLogin(C);
ok(learned(C).length === 0 && !mp.get(C, 'private.dboEnchRestore'), 'a character not on the list is untouched');
packets.length = 0;
put(0xff000999, 'profileId', 1);
load({ learnedEnchantments: { enabled: false } });
put(A, 'private.dboEnchRestore', null); put(A, 'private.dboEnchLearned', []);
globalThis.__dboEnchLearnedLogin(A);
ok(learned(A).length === 2 && !packets.length, 'with the packet switched off the list is still recorded (sent when it is on)');
fs.unlinkSync('ench-restore-1005.json');
load({ learnedEnchantments: { enabled: true } });
put(A, 'private.dboEnchRestore', null); put(A, 'private.dboEnchLearned', []);
globalThis.__dboEnchLearnedLogin(A);
ok(learned(A).length === 0, 'without the file nothing happens');

// ---- the shipped list is the dry run, effects proven by the server's own log ----
const DRY = path.join(os.homedir(), 'claude-nate-release', 'specs', 'bugs-1005-ench-restore.json');
const actors = SHIPPED.actors || {};
ok(SHIPPED.marker === '1005' && Object.keys(actors).length === 3, 'the shipped list: marker 1005, three characters', Object.keys(actors));
ok(JSON.stringify(actors.ff001ed0.effects) === '[373842,373841]' && actors.ff001ed0.profileId === 37, 'Old Grimbo #SB5X: Soul Trap and Fear', actors.ff001ed0);
ok(JSON.stringify(actors.ff001602.effects) === '[499962,286812]' && actors.ff001602.profileId === 53, 'Lorian Karthold #US6N: Fortify Illusion and Shock Damage', actors.ff001602);
ok(JSON.stringify(actors.ff000304.effects) === '[123741460,499969,499954,570972,499962]' && actors.ff000304.profileId === 40, 'Kagrethas Mzulft #TY94: Water Walking, Fortify Restoration, Alteration, Alchemy, Illusion', actors.ff000304);
ok(!actors.ff00215e, 'Kamroon #44YG is not on it (he learned his again)');
if (fs.existsSync(DRY)) {
  const dry = JSON.parse(fs.readFileSync(DRY, 'utf8'));
  const same = dry.characters.filter((c) => c.add.length).every((c) => JSON.stringify((actors[c.actorId] || {}).effects) === JSON.stringify(c.add.map((x) => x.effectId)) && actors[c.actorId].profileId === c.profileId);
  ok(same, 'it matches the dry run (specs/bugs-1005-ench-restore.json) character for character');
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
