// DragonBreak Online: an extra character slot for 150 hours played (Nate, 4 Oct 2026; config "playtimeSlot"). Loaded by
// gamemode.js on every hot reload.
//
// Play time is counted per account (profile), summed over all its characters: every sampleSeconds, each account with a
// character in the world (character creation excluded) gains the time since its last sample, at most two samples' worth,
// so a restart, a stall or a logout adds nothing. Idle time counts as play until the AFK kick (afkKickMinutes, 20).
// The first load seeds each account from the Character Journal's per-character play time (journal/*.json and
// journal/removed, journalstats.js, counted since the alpha opened on 1 October), so the hours already played count.
//
// At `hours` an account earns `slots` extra character slots for good: the record keeps them, and turning the feature
// off stops the counting and new grants but never takes a slot back. The fork's patronTiers.ts adds them to the Patreon
// tier and role bonuses through globalThis.__dboEarnedSlots(profileId); spawn.ts caps the total at 10. The player is
// told once, and only once the running server build counts the slot (globalThis.__alduinakEarnedSlots), so a gameplay
// deploy ahead of the server build promises nothing. Records live in playtime-slots.json (runtime, gitignored).
//   /playtime                          your hours and the slot
//   /playtime <player>                 a player's account, online or not (staff)
//   /playtime profile <id>             an account by profile id (staff)
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, system, registerChatCommand, audit, who, display, profileOf, isAdmin, findAnyByName, onlineActors, every, creationPending, cfg } = api;

  const HOUR_MS = 3600000;
  const raw = (cfg && cfg.playtimeSlot) || {};
  const C = {
    enabled: raw.enabled === true,
    hours: Number(raw.hours) > 0 ? Number(raw.hours) : 150,
    slots: Number.isInteger(raw.slots) && raw.slots >= 1 && raw.slots <= 5 ? raw.slots : 1,
    sampleSeconds: Number(raw.sampleSeconds) >= 5 ? Number(raw.sampleSeconds) : 30,
    flushSeconds: Number(raw.flushSeconds) >= 10 ? Number(raw.flushSeconds) : 120,
    journalDir: String(raw.journalDir || 'journal'),
  };
  const STORE_PATH = path.resolve('playtime-slots.json');
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

  // Kept across reloads: the records, the last sample of each account in the world, the write in flight
  const blank = () => ({ v: 1, store: null, last: new Map(), dirty: false, writing: false });
  const old = globalThis.__dboPlaytime;
  const S = old && old.v === 1 ? old : (globalThis.__dboPlaytime = blank());
  if (!S.store) {
    const s = readJson(STORE_PATH);
    S.store = s && typeof s === 'object' && s.profiles && typeof s.profiles === 'object' ? s : { profiles: {} };
  }
  const store = S.store;

  const flush = () => {
    if (!S.dirty || S.writing) return;
    S.dirty = false; S.writing = true;
    const body = JSON.stringify(store);
    fs.promises.writeFile(STORE_PATH + '.tmp', body)
      .then(() => fs.promises.rename(STORE_PATH + '.tmp', STORE_PATH))
      .catch((e) => { S.dirty = true; log('playtime-slots.json write failed', e.message); })
      .finally(() => { S.writing = false; });
  };
  const validPid = (p) => Number.isInteger(p) && p >= 0;
  const recOf = (pid, make) => {
    const k = String(pid);
    let r = store.profiles[k];
    if (!r && make) r = store.profiles[k] = { ms: 0 };
    if (r && !(Number.isFinite(r.ms) && r.ms >= 0)) r.ms = 0;
    return r || null;
  };
  const earnedOf = (r) => (r && Number.isInteger(r.earned) && r.earned > 0 ? r.earned : 0);
  const supported = () => globalThis.__alduinakEarnedSlots === true;
  const hm = (ms) => { const m = Math.floor(Math.max(0, ms) / 60000); return `${Math.floor(m / 60)} h ${m % 60} m`; };
  const day = (t) => new Date(t).toISOString().slice(0, 10);

  // The journal's play time, once: the accounts' hours since the alpha opened. A file not yet stamped with its account
  // (a character's first session) is placed by its character, when that character still exists.
  const seed = () => {
    if (store.seededAt) return;
    const dir = path.resolve(C.journalDir);
    const add = new Map();
    let files = 0, unplaced = 0;
    for (const where of [dir, path.join(dir, 'removed')]) {
      let names = []; try { names = fs.readdirSync(where); } catch (e) { names = []; }
      for (const n of names) {
        if (!/^[0-9a-f]{16}\.json$/.test(n)) continue;
        const d = readJson(path.join(where, n));
        if (!d || !(Number.isFinite(d.playMs) && d.playMs > 0)) continue;
        files++;
        let pid = Number.isInteger(d.account) ? d.account : -1;
        if (!validPid(pid) && typeof d.actor === 'string') { try { pid = Number(mp.get(parseInt(d.actor, 16) >>> 0, 'profileId')); } catch (e) { pid = -1; } }
        if (!validPid(pid)) { unplaced++; continue; }
        add.set(pid, (add.get(pid) || 0) + d.playMs);
      }
    }
    for (const [pid, ms] of add) recOf(pid, true).ms += ms;
    store.seededAt = Date.now();
    S.dirty = true;
    log(`playtime: seeded ${add.size} account(s) from ${files} journal file(s)${unplaced ? `, ${unplaced} with no account left out` : ''}`);
  };

  // Grants the slot at the threshold, once; says so to the account's character in the world once the build counts it
  const check = (pid, r, a) => {
    if (C.enabled && !earnedOf(r) && r.ms >= C.hours * HOUR_MS) {
      r.earned = C.slots; r.earnedAt = Date.now(); r.told = false;
      S.dirty = true;
      audit(`PLAYTIME ${a ? who(a) : `profile ${pid}`} earned ${C.slots} extra character slot(s) at ${hm(r.ms)} played`);
      flush();
    }
    if (a && earnedOf(r) && r.told === false && supported()) {
      r.told = true; S.dirty = true;
      system(a, `You have played ${C.hours} hours on DragonBreak Online. ${r.earned === 1 ? 'An extra character slot is' : `${r.earned} extra character slots are`} yours to keep: you will see ${r.earned === 1 ? 'it' : 'them'} on the character screen the next time you log in. Thank you for playing!`);
    }
  };

  const tick = () => {
    const now = Date.now(), cap = C.sampleSeconds * 2000;
    const seen = new Set();
    for (const x of onlineActors()) {
      const a = Number(x) >>> 0;
      let pid = -1; try { pid = profileOf(a); } catch (e) { pid = -1; }
      if (!validPid(pid) || seen.has(pid)) continue;
      seen.add(pid);
      if (typeof creationPending === 'function' && creationPending(a)) { S.last.delete(pid); continue; }
      const r = recOf(pid, C.enabled);
      if (!r) continue;
      if (C.enabled) {
        const prev = S.last.get(pid);
        if (prev !== undefined) { r.ms += Math.max(0, Math.min(now - prev, cap)); S.dirty = true; }
        S.last.set(pid, now);
      }
      check(pid, r, a);
    }
    for (const pid of [...S.last.keys()]) if (!seen.has(pid)) S.last.delete(pid);
  };

  // patronTiers.ts asks this for every character list, selection and creation
  globalThis.__dboEarnedSlots = (profileId) => earnedOf(store.profiles[String(profileId)]);

  const describe = (pid, self) => {
    const r = recOf(pid, false);
    const ms = r ? r.ms : 0, whose = self ? 'You have' : `Profile ${pid} has`;
    const head = `${whose} played ${hm(ms)} in all, across every character.`;
    if (earnedOf(r)) return `${head} ${self ? 'Your' : 'Its'} extra character slot was earned on ${day(r.earnedAt || Date.now())}${self ? '' : ` (${r.earned} slot(s), ${r.told ? 'told' : supported() ? 'not yet told' : 'waiting for the server build'})`}.`;
    if (!C.enabled) return `${head} Play time is not being counted for a character slot right now.`;
    return `${head} At ${C.hours} hours ${self ? 'you earn' : 'it earns'} an extra character slot: ${hm(C.hours * HOUR_MS - ms)} to go.`;
  };

  registerChatCommand('playtime', (a, args) => {
    const body = String(args || '').trim();
    if (!body) { const pid = profileOf(a); return personal(a, validPid(pid) ? describe(pid, true) : 'Your play time is not counted on this account.'); }
    if (!isAdmin(a)) return personal(a, 'Type /playtime on its own to see your own play time.');
    const m = /^profile\s+(\d+)$/i.exec(body);
    if (m) return personal(a, describe(Number(m[1]), false));
    const t = findAnyByName(body);
    if (t < 0) return personal(a, `More than one character matches "${body}"; add their #TAG.`);
    if (!t) return personal(a, `No character matches "${body}".`);
    const pid = profileOf(t);
    if (!validPid(pid)) return personal(a, `${display(t)} has no account.`);
    personal(a, `${display(t)}: ${describe(pid, false)}`);
  }, { help: 'your play time, and the extra character slot at 150 hours' });

  seed();
  for (const [pid, r] of Object.entries(store.profiles)) if (r) check(Number(pid), r, null);
  every('playtimeSlot', C.sampleSeconds * 1000, tick);
  every('playtimeSlotFlush', C.flushSeconds * 1000, flush);
  flush();

  const earned = Object.values(store.profiles).filter((r) => earnedOf(r)).length;
  log(`playtime slot ${C.enabled ? 'on' : 'off'} (${C.slots} slot(s) at ${C.hours} h), ${Object.keys(store.profiles).length} account(s) counted, ${earned} earned, ${supported() ? 'server build counts earned slots' : 'server build has no earned slots: nothing is promised'}`);
};
