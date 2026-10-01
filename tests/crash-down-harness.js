// A crash before the fall costs nothing (server downed.js, Jake 2026-10-01): a down that began after the player's game
// crashed, by the launcher's note in the backend's data/session-ends.jsonl, wakes where they fell at full health,
// without the temple or Death's Chill. A quit, Alt-F4 or Task Manager kill still costs both, and so does a "crash" note
// from a client that kept talking. Jake's own timeline first, then the edges, then a hot reload over the live module.
// node tests/crash-down-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const MODULE = path.resolve(__dirname, '..', 'downed.js');
const T = (hms) => Date.parse(`2026-10-01T${hms}Z`);
let now = T('14:00:00');
Date.now = () => now;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-crashdown-'));
const NOTES = path.join(tmp, 'session-ends.jsonl');
let mtime = 1;
const writeNotes = (notes) => {
  fs.writeFileSync(NOTES, notes.map((n) => JSON.stringify(n)).join('\n') + '\n');
  mtime++; fs.utimesSync(NOTES, mtime, mtime);
};
const note = (outcome, endedAt, extra) => Object.assign({ at: endedAt + 2074, profileId: 1, discordId: '1', name: 'Jake', outcome, exitCode: outcome === 'closed' ? 0 : 1, crashLog: outcome === 'crash', startedAt: endedAt - 3600000, endedAt, launcherVersion: '2.1.36', filesVersion: '0.3.74' }, extra || {});

const P = 0xff000001, BANDIT = 0xff0000aa;
const FELL = [61000, 203000, 7480], TEMPLE = [1, 2, 3];
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
let online = [P];
const audits = [];
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => { set(id, k, v); if (k === 'locationalData') { set(id, 'pos', v.pos.slice()); set(id, 'worldOrCellDesc', v.cellOrWorldDesc); } },
  getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: () => true,
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined, onSpellHit: () => undefined, onSpellCast: () => undefined,
};
const timers = {}, ui = {}, sent = [];
// Timers run when the clock passes them (runDue), so the down's 10 s answer check happens in order
let queue = [];
global.setTimeout = (fn, ms) => { queue.push({ due: now + (Number(ms) || 0), fn }); return 0; };
const runDue = () => { const due = queue.filter((q) => q.due <= now).sort((x, y) => x.due - y.due); queue = queue.filter((q) => q.due > now); due.forEach((q) => q.fn()); };
const api = {
  mp, log: () => {}, personal: () => {}, sendPacket: (a, p) => { sent.push([a, p]); return true; }, audit: (t) => audits.push(t), who: String, display: String,
  profileOf: (a) => Number(get(a, 'profileId')), nameOf: String, onlineActors: () => online,
  every: (n, ms, fn) => { timers[n] = fn; }, registerChatCommand: () => {},
  cfg: { downed: { giveUpAfterSeconds: 0, crashNotesFile: NOTES } },
  openWidget: () => true, closeWidget: () => {}, onUi: (n, fn) => { ui[n] = fn; },
};
const base = mp.onDeath;
const load = (file) => { mp.onDeath = base; delete require.cache[file]; require(file)(api); };

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const fresh = (at) => {
  now = T(at);
  set(P, 'profileId', 1); set(P, 'isDead', false); set(P, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(P, 'pos', FELL.slice()); set(P, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(P, 'angle', [0, 0, 135]);
  set(P, 'spawnPoint', { cellOrWorldDesc: 'temple:BSHeartland.esm', pos: TEMPLE, rot: [0, 0, 0] });
  set(P, 'private.dboDeathChill', undefined); set(P, 'private.dboCrashForgiven', undefined);
  online = [P]; audits.length = 0; sent.length = 0; queue = [];
  const S = globalThis.__dboDownedState; if (S) { S.downed.clear(); for (const k of ['recentWakes', 'shielded', 'unshielded', 'probes', 'struckAt']) if (S[k]) S[k].clear(); }
};
const packet = (at) => { (globalThis.__dboLastPacketAt = globalThis.__dboLastPacketAt || new Map()).set(P, T(at)); };
const down = (at) => { now = T(at); set(P, 'percentages', { health: 0, stamina: 0.2, magicka: 0.3 }); set(P, 'isDead', true); mp.onDeath(P, BANDIT); };
const clock = (at) => { now = T(at); runDue(); };
const respawn = (at) => { clock(at); mp.set(P, 'locationalData', get(P, 'spawnPoint')); set(P, 'isDead', false); timers.downedPanel(); };
const read = async () => (globalThis.__dboCrashNotesRead ? globalThis.__dboCrashNotesRead() : 0);
const chilled = () => { const c = get(P, 'private.dboDeathChill'); return !!(c && c.leftMs > 0); };
const at = () => (get(P, 'pos') || []).join(',');

(async () => {
  // ---- hot reload first: the live module (77c05e8b) holds Jake's down, then this one is loaded over it ----
  let live = null;
  try { live = execFileSync('git', ['show', '77c05e8b:downed.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { live = null; }
  globalThis.__dboDownedState = undefined;
  if (live) {
    const liveFile = path.join(tmp, 'downed-live.js');
    fs.writeFileSync(liveFile, live);
    load(liveFile);
    fresh('14:22:00'); packet('14:22:17.900');
    writeNotes([note('crash', T('14:22:18.166'))]);
    down('14:22:27');
    load(MODULE);
    await read();
    online = []; respawn('14:23:27');
    check('hot reload: a down the live module began is forgiven by the new one (no Chill)', !chilled() && audits.some((t) => /^CRASH-DOWN forgiven/.test(t)), audits);
    check('hot reload: ...it wakes at the temple, the live down never noted where it fell', at() === TEMPLE.join(','));
  } else {
    console.log('skip hot reload: 77c05e8b is not in this repository');
    load(MODULE);
  }

  // ---- Jake, 2026-10-01: the game crashed at 14:22:18, bandits downed the body at 14:22:27, LEAVE 14:23:17 ----
  fresh('14:22:00'); packet('14:22:17.900');
  writeNotes([note('crash', T('14:22:18.166'))]);
  await read();
  down('14:22:27');
  clock('14:22:37');
  check('Jake: 10 s after the down, his client had not answered it', globalThis.__dboDownedState.downed.get(P).answered === false);
  now = T('14:23:17'); online = [];
  respawn('14:23:27');
  check('Jake: no Death\'s Chill', !chilled());
  check('Jake: wakes where he fell, not at the temple', at() === FELL.join(','), at());
  check('Jake: at full health', get(P, 'percentages').health === 1);
  check('Jake: a CRASH-DOWN line with both times', audits.some((t) => /^CRASH-DOWN forgiven .*crashed at 14:22:18Z \(launcher: exit 0x1, crash log\), the down began at 14:22:27Z; woke where they fell, no Chill$/.test(t)), audits);
  check('Jake: no CHILL audit', !audits.some((t) => /^CHILL /.test(t)));
  check('Jake: counted once for the day', (get(P, 'private.dboCrashForgiven') || []).length === 1);

  // ---- what still costs the temple and the Chill ----
  const costs = async (label, notes, steps) => {
    fresh('15:00:00'); packet('15:00:00');
    writeNotes(notes); await read();
    await steps();
    check(label, chilled() && at() === TEMPLE.join(',') && !audits.some((t) => /^CRASH-DOWN forgiven/.test(t)), { chilled: chilled(), at: at(), audits });
  };
  await costs('Alt-F4 in a fight (closed, exit 0): the temple and the Chill', [note('closed', T('15:00:05'))], async () => { down('15:00:10'); respawn('15:01:10'); });
  await costs('killed from Task Manager (ended, exit 1, no crash log): the temple and the Chill', [note('ended', T('15:00:05'))], async () => { down('15:00:10'); respawn('15:01:10'); });
  await costs('a "crash" note while the client kept talking: the temple and the Chill', [note('crash', T('15:00:05'))], async () => { packet('15:00:30'); down('15:00:40'); respawn('15:01:40'); });
  await costs('a crash after the down began: the temple and the Chill', [note('crash', T('15:00:20'))], async () => { down('15:00:10'); respawn('15:01:10'); });
  await costs('a crash more than 10 minutes before the down: the temple and the Chill', [note('crash', T('14:49:00'))], async () => { down('15:00:10'); respawn('15:01:10'); });
  await costs('another profile\'s crash: the temple and the Chill', [note('crash', T('15:00:05'), { profileId: 2 })], async () => { down('15:00:10'); respawn('15:01:10'); });
  await costs('a crash note a day old: the temple and the Chill', [note('crash', T('15:00:05') - 25 * 3600000)], async () => { now = T('15:00:05') - 25 * 3600000 + 5000; down2(); });
  function down2() { /* the down sits right after the old crash, yet the note is past the day it is kept */ now = T('15:00:05') - 25 * 3600000 + 5000; set(P, 'isDead', true); mp.onDeath(P, BANDIT); now = T('15:00:05') - 25 * 3600000 + 65000; mp.set(P, 'locationalData', get(P, 'spawnPoint')); set(P, 'isDead', false); timers.downedPanel(); }

  // ---- a client that answered the down was not crashed ----
  await costs('A: downed while playing, a note posted 13 s later claims a crash 1 s before: the temple and the Chill', [], async () => {
    down('15:00:10'); packet('15:00:10.300');
    now = T('15:00:23'); writeNotes([note('crash', T('15:00:09'), { at: T('15:00:23') })]); await read();
    respawn('15:01:10');
  });
  await costs('B: a note posted mid-fight, the down 3 minutes later: the temple and the Chill', [note('crash', T('15:00:05'), { at: T('15:00:06') })], async () => {
    packet('15:02:50'); down('15:03:05'); packet('15:03:05.400'); respawn('15:04:05');
  });
  await costs('B, with a client that holds back its answers: blows struck after the claimed crash still cost the temple and the Chill', [note('crash', T('15:00:05'), { at: T('15:00:06') })], async () => {
    now = T('15:01:30'); mp.onHitDamageAttempt(P, BANDIT, 0x12eb7, 20); down('15:03:05'); respawn('15:04:05');
  });
  await costs('a note that arrived more than 120 s after the crash it reports: the temple and the Chill', [note('crash', T('15:00:05'), { at: T('15:02:30') })], async () => { down('15:00:10'); respawn('15:01:10'); });
  fresh('15:10:00'); packet('15:10:00');
  writeNotes([note('crash', T('15:10:05'))]); await read();
  down('15:10:10'); clock('15:10:20'); packet('15:10:50');
  respawn('15:11:10');
  check('a crashed player who rejoins inside the bleed-out keeps the forgiveness (judged 10 s after the down)', !chilled() && at() === FELL.join(','));

  // ---- the note lands after the wake ----
  fresh('16:00:00'); packet('16:00:00');
  writeNotes([]); await read();
  down('16:00:10'); online = []; respawn('16:01:10');
  check('late: woken with the Chill before any note', chilled() && at() === TEMPLE.join(','));
  now = T('16:02:00');
  writeNotes([note('crash', T('16:00:05'))]); await read();
  check('late: the note lifts the Chill', !chilled());
  check('late: still away, so they are put back where they fell at full health', at() === FELL.join(',') && get(P, 'percentages').health === 1, at());
  check('late: the CRASH-DOWN line says the Chill was lifted after the wake', audits.some((t) => /^CRASH-DOWN forgiven .*; the Chill lifted after the wake$/.test(t)), audits);

  fresh('17:00:00'); packet('17:00:00');
  writeNotes([]); await read();
  down('17:00:10'); respawn('17:01:10');
  now = T('17:02:00'); set(P, 'pos', [500, 500, 500]);
  writeNotes([note('crash', T('17:00:05'))]); await read();
  check('late, back in game: the Chill lifts, nobody is moved', !chilled() && at() === '500,500,500');

  fresh('18:00:00'); packet('18:00:00');
  writeNotes([]); await read();
  down('18:00:10'); respawn('18:01:10');
  now = T('18:40:00');
  writeNotes([note('crash', T('18:00:05'))]); await read();
  check('a note more than 30 minutes after the wake changes nothing', chilled());

  // ---- Give up after a crash (a relaunch inside the bleed-out) is forgiven the same way ----
  fresh('19:00:00'); packet('19:00:00');
  writeNotes([note('crash', T('19:00:05'))]); await read();
  down('19:00:10');
  const d = globalThis.__dboDownedState.downed.get(P);
  now = T('19:00:40'); ui.downedGiveUp(P, [d.nonce]);
  check('Give up after a crash: where they fell, no Chill', !chilled() && at() === FELL.join(','));

  // ---- at most two a day ----
  fresh('20:00:00'); packet('20:00:00');
  set(P, 'private.dboCrashForgiven', [T('10:00:00'), T('12:00:00')]);
  writeNotes([note('crash', T('20:00:05'))]); await read();
  down('20:00:10'); respawn('20:01:10');
  check('a third crash-down in a day: the temple and the Chill', chilled() && at() === TEMPLE.join(','));
  check('...with a line saying why', audits.some((t) => /^CRASH-DOWN not forgiven .*already 2 today$/.test(t)), audits);

  // ---- the shield: once the note lands the body cannot be harmed, so no down begins (gamemode.js offlineBodyProtected) ----
  const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
  const from = gm.indexOf('const combatAt = globalThis.__dboCombatAt'), to = gm.indexOf('const offlineSaid', from);
  check('the offline-body block is where the harness expects it in gamemode.js', from >= 0 && to > from);
  let users = new Map([[P, 7]]);
  new Function('cfg', 'profileOf', 'userOf', 'log', 'display', gm.slice(from, to))({}, (a) => Number(get(a, 'profileId') === undefined ? -1 : get(a, 'profileId')), (a) => (users.has(a) ? users.get(a) : -1), () => {}, String);
  globalThis.__dboCombatAt.clear(); globalThis.__dboLogoutAt.clear();
  const hit = () => mp.onHitDamageAttempt(BANDIT, P, 0x12eb7, 30);
  const S = globalThis.__dboDownedState;
  const shieldReset = () => { S.shielded.clear(); S.unshielded.clear(); users = new Map([[P, 7]]); };

  fresh('14:22:00'); shieldReset(); packet('14:22:17.900');
  writeNotes([]); await read();
  now = T('14:22:19');
  check('shield: before the note lands the body can be hit as ever', hit() === true);
  now = T('14:22:21'); writeNotes([note('crash', T('14:22:18.166'))]); await read();
  check('shield: when the note lands the client is asked to answer (crash-check)', sent.some(([a, p]) => a === P && p.customPacketType === 'dboInputDiag' && p.reason === 'crash-check' && p.seconds === 5));
  now = T('14:22:23');
  check('shield: not before the client has had 3 s to answer', hit() === true);
  now = T('14:22:27');
  check('shield, Jake: the bandits\' blow at 14:22:27 is refused', hit() === false);
  check('shield, Jake: no down begins', !S.downed.has(P) && get(P, 'isDead') === false);
  check('shield, Jake: one CRASH-DOWN shielded line', audits.filter((t) => /^CRASH-DOWN shielded .*crashed at 14:22:18Z \(launcher: exit 0x1, crash log\); the body cannot be harmed until they are back$/.test(t)).length === 1, audits);
  now = T('14:22:40'); hit(); hit();
  check('shield: every later blow is refused, and the crash counts once', hit() === false && audits.filter((t) => /shielded/.test(t)).length === 1 && (get(P, 'private.dboCrashForgiven') || []).length === 1);
  now = T('14:23:17'); globalThis.__dboCombatAt.set(P, T('14:23:00')); globalThis.__dboNoteLogout(P); users.delete(P);
  check('shield: after LEAVE the body stays out of reach, even when the logout looks like mid-fight', hit() === false);
  check('shield: NPCs are never shielded', globalThis.__dboOfflineBodyProtected(BANDIT) === false);
  // The same crash forgiving a down later does not count it twice
  set(P, 'isDead', true); now = T('14:23:20'); S.downed.set(P, { at: T('14:23:20'), by: 0, nonce: 'x', fell: null, lastPacket: T('14:22:17.900') });
  respawn('14:24:20');
  check('shield then a down from the same crash: forgiven, still counted once', !chilled() && (get(P, 'private.dboCrashForgiven') || []).length === 1);

  fresh('15:30:00'); shieldReset(); packet('15:30:00');
  now = T('15:30:07'); writeNotes([note('crash', T('15:30:05'))]); await read();
  packet('15:30:07.300');
  now = T('15:30:12');
  check('shield: a client that answers the question is not shielded', hit() === true && !audits.some((t) => /shielded/.test(t)));

  fresh('15:35:00'); shieldReset(); packet('15:35:00');
  now = T('15:35:07'); writeNotes([note('crash', T('15:35:05'))]); await read();
  now = T('15:35:12');
  check('shield: a silent client is shielded', hit() === false);
  set(P, 'pos', [FELL[0] + 300, FELL[1], FELL[2]]);
  now = T('15:35:20');
  check('shield: a body that walks away loses it', hit() === true && audits.some((t) => /^CRASH-DOWN shield dropped .*: the body moved$/.test(t)), audits);

  fresh('15:37:00'); shieldReset(); packet('15:37:00');
  now = T('15:37:07'); writeNotes([note('crash', T('15:37:05'))]); await read();
  now = T('15:37:12');
  check('shield: shielded again on a new crash', hit() === false);
  mp.onHitDamageAttempt(P, BANDIT, 0x12eb7, 20);
  check('shield: a body that strikes a blow loses it', hit() === true && audits.some((t) => /^CRASH-DOWN shield dropped .*: they struck a blow$/.test(t)), audits);

  fresh('15:40:00'); shieldReset(); packet('15:40:00');
  writeNotes([note('closed', T('15:40:05'))]); await read();
  now = T('15:40:10');
  check('shield: Alt-F4 in a fight shields nothing', hit() === true);

  fresh('15:50:00'); shieldReset(); packet('15:50:00');
  set(P, 'private.dboCrashForgiven', [T('10:00:00'), T('12:00:00')]);
  now = T('15:50:06'); writeNotes([note('crash', T('15:50:05'))]); await read();
  now = T('15:50:10'); const r1 = hit(); hit(); hit();
  check('shield: past the day\'s limit the body is left open', r1 === true);
  check('...with one line saying why, not one per blow', audits.filter((t) => /^CRASH-DOWN not forgiven .*; the body was left open; already 2 today$/.test(t)).length === 1, audits);

  fresh('16:30:00'); shieldReset(); packet('16:30:00');
  now = T('16:30:07'); writeNotes([note('crash', T('16:30:05'))]); await read();
  now = T('16:30:12');
  check('shield: shielded within the 10 minutes', hit() === false);
  now = T('16:41:00');
  check('shield: it ends 10 minutes after the crash', hit() === true);

  // ---- with the down's diagnostic off the client is still asked once, briefly, for the crash check ----
  api.cfg.downed.inputDiagSeconds = 0; load(MODULE);
  fresh('22:00:00'); packet('22:00:00');
  writeNotes([note('crash', T('22:00:05'))]); await read();
  down('22:00:10');
  check('diagnostic off: the down sends one crash-check probe and no "down" request', sent.filter(([a, p]) => a === P && p.customPacketType === 'dboInputDiag').length === 1 && sent.some(([, p]) => p.reason === 'crash-check' && p.seconds === 5) && !sent.some(([, p]) => p.reason === 'down'));
  packet('22:00:10.300'); clock('22:00:20');
  respawn('22:01:10');
  check('diagnostic off: a client that answers the probe is refused', chilled() && at() === TEMPLE.join(','));
  fresh('22:10:00'); packet('22:10:00');
  writeNotes([note('crash', T('22:10:05'))]); await read();
  down('22:10:10'); clock('22:10:20'); online = []; respawn('22:11:10');
  check('diagnostic off: a silent client is still forgiven', !chilled() && at() === FELL.join(','));

  // ---- a broken file changes nothing ----
  fs.writeFileSync(NOTES, '{"outcome":"crash", broken\nnot json at all\n'); mtime++; fs.utimesSync(NOTES, mtime, mtime);
  check('a broken notes file is read without throwing', (await read()) === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
