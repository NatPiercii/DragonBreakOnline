// Scripted test for server\gifts.js and tools\gift.js with a mock gamemode api, in a scratch folder: a queued gift waits
// while its character is offline, is handed over once they are in the world (tag or profile), the player is told the
// reason, the ledger records it and the inbox file goes; a gift already in the ledger never pays twice; bad files are
// refused and left alone. Run it from this folder's parent with
//
//   node tests\gifts-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-gifts-'));
const cwd = process.cwd(); process.chdir(dir);
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };

const A = 0xff000014, B = 0xff000015;
const props = { [A]: { 'private.charTag': 'KKVT', profileId: 71 }, [B]: { 'private.charTag': '44YG', profileId: 88 } };
let online = [];
const out = { personal: [], audits: [], given: [] };
let tick = null;
const api = {
  mp: { get: (id, k) => (props[id] || {})[k] },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), audit: (t) => out.audits.push(t), who: (a) => `P${a.toString(16)}`,
  onlineActors: () => online, profileOf: (a) => (props[a] || {}).profileId,
  giveItem: (a, baseId, count) => { out.given.push({ a, baseId, count }); return true; },
  every: (name, ms, fn) => { tick = fn; },
};
require(path.join(root, 'gifts.js'))(api);
const gift = (...a) => execFileSync(process.execPath, [path.join(root, 'tools', 'gift.js'), ...a], { env: { ...process.env, GIFTS_DIR: dir }, encoding: 'utf8' });
const inbox = () => { try { return fs.readdirSync(path.join(dir, 'gifts-inbox')).filter((f) => f.endsWith('.json')); } catch (e) { return []; } };
const ledger = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'gift-ledger.json'), 'utf8')).delivered; } catch (e) { return {}; } };

gift('--tag', '#kkvt', '--gold', '50', '--reason', 'Sorry, the update ended your dungeon run', '--by', 'Nate');
gift('--profile', '88', '--gold', '50', '--item', '0x1397e:1', '--reason', 'Sorry, the update ended your dungeon run');
check('the tool queues two gifts', inbox().length === 2, inbox());
tick();
check('nobody online: nothing is given and both wait', out.given.length === 0 && inbox().length === 2);

online = [A];
tick();
check('#KKVT in the world gets 50 gold', out.given.length === 1 && out.given[0].a === A && out.given[0].baseId === 0xf && out.given[0].count === 50, out.given);
check('they are told the reason', out.personal.some((x) => x.a === A && /50 gold\. Sorry, the update ended your dungeon run/.test(x.t)), out.personal);
check('the ledger records it and its file goes', Object.keys(ledger()).length === 1 && inbox().length === 1);
check('the audit names the gift and the giver', out.audits.some((t) => /^GIFT .*by Nate to Pff000014: 50 gold;/.test(t)), out.audits);
tick();
check('a second look gives nothing more', out.given.length === 1);

online = [A, B];
tick();
check('profile 88 gets the gold and the item', out.given.filter((g) => g.a === B).length === 2 && out.given.some((g) => g.a === B && g.baseId === 0x1397e && g.count === 1));
check('the inbox is empty and the ledger holds two', inbox().length === 0 && Object.keys(ledger()).length === 2);

// A gift already in the ledger (the file came back, say from a restored backup) is cleared, not paid again
const [firstId] = Object.keys(ledger());
fs.writeFileSync(path.join(dir, 'gifts-inbox', `${firstId}.json`), JSON.stringify({ tag: 'KKVT', gold: 50, reason: 'again' }));
const before = out.given.length; tick();
check('a delivered gift never pays twice', out.given.length === before && inbox().length === 0);

// Bad files are refused and left for staff
fs.writeFileSync(path.join(dir, 'gifts-inbox', 'bad1.json'), JSON.stringify({ tag: 'KKVT', gold: 5000000, reason: 'x' }));
fs.writeFileSync(path.join(dir, 'gifts-inbox', 'bad2.json'), '{ not json');
fs.writeFileSync(path.join(dir, 'gifts-inbox', '.half.tmp'), '{"tag":"KKVT","gold":50}');
tick();
check('too much gold, broken JSON and a half-written file are refused and kept', out.given.length === before && inbox().length === 2);

let refused = 0;
for (const bad of [['--gold', '50', '--reason', 'x'], ['--tag', 'KKVT', '--reason', 'x'], ['--tag', 'KKVT', '--gold', '50'], ['--tag', 'TOOLONG', '--gold', '5', '--reason', 'x']]) {
  try { gift(...bad); } catch (e) { refused++; }
}
check('the tool refuses a gift with no one, nothing, no reason or a bad tag', refused === 4);

process.chdir(cwd);
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
