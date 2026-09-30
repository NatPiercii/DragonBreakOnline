// DragonBreak Online: the playtesters' skill boost at the alpha launch (config "playtesterBoost"). Loaded by gamemode.js
// on every hot reload.
//
// A holder of the playtester role (the pre-alpha whitelist role, roleId) who is in the world at or after startsAt, and
// before claimUntil, gets `hours` of x`mult` skill progress from that moment, once per Discord account (profile), for
// every character on it. masterySystem honours private.xpBoost { mult, until } on a character (fork client-playtester-xpboost);
// this module keeps each account's window in playtester-boost.json (runtime, gitignored) and copies it onto the character
// the player is on at every login. Nothing is started, copied or promised unless the running server build says it honours
// the property (globalThis.__alduinakXpBoost holds its name), so a gameplay deploy ahead of the server build is inert.
// `enabled` gates only the automatic start for role holders; windows already running and staff grants work either way.
//   /boost                             your boost and the time left
//   /boost <player>                    a player's boost (staff)
//   /boost grant <player> [hours]      a window of `hours` from now (Lead GM and above)
//   /boost extend <player> <hours>     more hours on the end of a window (Lead GM and above)
'use strict';

module.exports = (api) => {
  const fs = require('fs');
  const path = require('path');
  const { mp, log, personal, system, registerChatCommand, audit, who, display, profileOf, rolesOf, isAdmin, isLeadStaff, findByName, onlineActors, every, cfg } = api;

  const HOUR_MS = 3600000;
  const MAX_STAFF_HOURS = 168;
  const raw = (cfg && cfg.playtesterBoost) || {};
  const time = (v, dflt) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : dflt; };
  const C = {
    enabled: raw.enabled === true,
    startsAt: time(raw.startsAt, Infinity),
    claimUntil: time(raw.claimUntil, -Infinity),
    hours: Number(raw.hours) > 0 ? Number(raw.hours) : 24,
    mult: Number(raw.mult) > 1 ? Math.min(3, Number(raw.mult)) : 2,
    roleId: String(raw.roleId || ''),
  };

  const STORE_PATH = path.resolve('playtester-boost.json');
  const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
  const store = globalThis.__dboBoostStore || (globalThis.__dboBoostStore = readJson(STORE_PATH, { profiles: {} }));
  if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {};
  const save = () => { try { fs.writeFileSync(STORE_PATH + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(STORE_PATH + '.tmp', STORE_PATH); } catch (e) { log('playtester-boost.json write failed', e.message); } };

  // The property masterySystem reads, or null when this build has no boost
  const prop = () => { const p = globalThis.__alduinakXpBoost; return typeof p === 'string' && p ? p : null; };
  const recOf = (a) => { const p = profileOf(a); return Number.isFinite(p) && p >= 0 ? store.profiles[String(p)] || null : null; };
  const active = (rec, now) => !!rec && Number(rec.until) > now;
  const left = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'under a minute';
    const h = Math.floor(m / 60), r = m % 60;
    return h ? `${h} h ${r} m` : `${r} m`;
  };
  const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const times = (mult) => (mult === 2 ? 'twice as fast' : `${mult} times as fast`);
  const holdsRole = (a) => !!C.roleId && rolesOf(a).includes(C.roleId);
  const claimable = (a, now) => C.enabled && now >= C.startsAt && now < C.claimUntil && holdsRole(a);

  const mirror = (a, rec) => {
    const p = prop(); if (!p) return false;
    const want = { mult: rec.mult, until: rec.until };
    try {
      const cur = mp.get(a, p);
      if (!cur || cur.mult !== want.mult || cur.until !== want.until) mp.set(a, p, want);
      return true;
    } catch (e) { log('boost mirror failed', e.message); return false; }
  };

  // Starts the account's window the first time a role holder is in the world inside the claim period; a staff window
  // still running is lengthened rather than replaced
  const claim = (a, now) => {
    // A character with no profile id has no account to keep the window under (review: it was stored as "-1")
    const pid = profileOf(a); if (!(Number.isFinite(pid) && pid >= 0)) return null;
    const old = recOf(a);
    if (!prop() || (old && old.claimed) || !claimable(a, now)) return null;
    const on = active(old, now);
    const rec = { start: on ? old.start : now, until: (on ? old.until : now) + C.hours * HOUR_MS, mult: on ? old.mult : C.mult, claimed: true, staff: on && !!old.staff };
    store.profiles[String(pid)] = rec;
    save();
    audit(`BOOST ${who(a)} started the playtester boost: x${rec.mult} for ${C.hours} h`);
    return rec;
  };

  const welcome = (a, rec, now) => system(a, `Thank you for playtesting DragonBreak Online. For the next ${left(rec.until - now)} your skills rise ${times(rec.mult)}. Type /boost to see the time left.`);
  const reminder = (a, rec, now) => personal(a, `Your skill boost is on: your skills rise ${times(rec.mult)} for another ${left(rec.until - now)}.`);

  // Characters whose login run has reached this module; only they are started by the tick below
  const seen = globalThis.__dboBoostSeen instanceof Set ? globalThis.__dboBoostSeen : (globalThis.__dboBoostSeen = new Set());
  globalThis.__dboBoostLogin = (actorId) => {
    const a = actorId >>> 0, now = Date.now();
    seen.add(a);
    if (!prop()) return;
    const fresh = claim(a, now);
    const rec = fresh || recOf(a);
    if (!active(rec, now) || !mirror(a, rec)) return;
    if (fresh) welcome(a, rec, now); else reminder(a, rec, now);
  };

  // Once a minute: start the window for role holders already logged in when the launch comes, and say when one ends
  const ended = globalThis.__dboBoostEnded instanceof Set ? globalThis.__dboBoostEnded : (globalThis.__dboBoostEnded = new Set());
  const tick = () => {
    if (!prop()) return;
    const now = Date.now();
    for (const a of onlineActors()) {
      const fresh = seen.has(a >>> 0) ? claim(a, now) : null;
      if (fresh) { if (mirror(a, fresh)) welcome(a, fresh, now); continue; }
      const rec = recOf(a);
      if (!rec) continue;
      const key = `${profileOf(a)}:${rec.until}`;
      if (active(rec, now)) { ended.delete(key); continue; }
      if (now - rec.until < 5 * 60000 && !ended.has(key)) { ended.add(key); personal(a, rec.claimed ? 'Your playtester skill boost has ended. Thank you for testing!' : 'Your skill boost has ended.'); }
    }
  };
  every('playtesterBoost', 60000, tick);

  const describe = (t, self) => {
    const now = Date.now(), rec = recOf(t), whose = self ? 'Your' : `${display(t)}'s`;
    if (active(rec, now)) return `${whose} skill boost: x${rec.mult} for another ${left(rec.until - now)}${rec.staff ? ' (with time from staff)' : ''}.`;
    if (C.enabled && holdsRole(t) && now < C.startsAt && !(rec && rec.claimed)) return `${whose} playtester boost (x${C.mult} for ${C.hours} h) starts at ${self ? 'your' : 'their'} first login after ${stamp(C.startsAt)}.`;
    if (rec) return `${whose} skill boost ended ${stamp(rec.until)}.`;
    return self ? 'You have no skill boost.' : `${display(t)} has no skill boost.`;
  };

  // A staff window: grant starts `hours` from now (keeping a later end already set), extend adds them to the end
  const staffWindow = (a, verb, rest) => {
    if (!isLeadStaff(a)) return personal(a, 'That is for a Lead GM and above.');
    if (!prop()) return personal(a, 'This server build does not support skill boosts yet; nothing was granted.');
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const last = parts.length > 1 ? Number(parts[parts.length - 1]) : NaN;
    const hasHours = Number.isFinite(last);
    const name = (hasHours ? parts.slice(0, -1) : parts).join(' ');
    const hours = hasHours ? last : (verb === 'grant' ? C.hours : NaN);
    if (!name || !Number.isFinite(hours)) return personal(a, verb === 'grant' ? 'Usage: /boost grant <player> [hours]' : 'Usage: /boost extend <player> <hours>');
    if (!(hours > 0 && hours <= MAX_STAFF_HOURS)) return personal(a, `Hours must be more than 0 and at most ${MAX_STAFF_HOURS}.`);
    const t = findByName(name);
    if (!t) return personal(a, `No player online matches "${name}".`);
    const pid = profileOf(t);
    if (!(Number.isFinite(pid) && pid >= 0)) return personal(a, `${display(t)} has no account to hold a boost.`);
    const now = Date.now(), rec = recOf(t), add = hours * HOUR_MS;
    const until = verb === 'extend' ? (active(rec, now) ? rec.until : now) + add : Math.max(now + add, active(rec, now) ? rec.until : 0);
    const next = { start: active(rec, now) ? rec.start : now, until, mult: active(rec, now) ? rec.mult : C.mult, claimed: !!(rec && rec.claimed), staff: true };
    store.profiles[String(pid)] = next;
    save();
    mirror(t, next);
    audit(`BOOST ${who(a)} ${verb === 'extend' ? 'extended' : 'granted'} ${who(t)} a skill boost: x${next.mult} until ${new Date(until).toISOString()} (${hours} h)`);
    personal(a, `${display(t)}'s skill boost: x${next.mult} for ${left(until - now)}.`);
    if (t !== a) personal(t, `A member of staff has ${verb === 'extend' ? 'extended' : 'given you'} a skill boost: your skills rise ${times(next.mult)} for ${left(until - now)}.`);
  };

  registerChatCommand('boost', (a, args) => {
    const body = String(args || '').trim();
    const i = body.indexOf(' ');
    const verb = (i < 0 ? body : body.slice(0, i)).toLowerCase();
    if (verb === 'grant' || verb === 'extend') return staffWindow(a, verb, i < 0 ? '' : body.slice(i + 1));
    if (!prop()) return personal(a, 'No skill boost is running.');
    if (!body) return personal(a, describe(a, true));
    if (!isAdmin(a)) return personal(a, 'Type /boost on its own to see your own boost.');
    const t = findByName(body);
    if (!t) return personal(a, `No player online matches "${body}".`);
    personal(a, describe(t, t === a));
  }, { help: 'your skill boost and the time left' });

  const addStatus = (key, order, fn) => { try { if (typeof globalThis.__dboRegisterStatus === 'function') globalThis.__dboRegisterStatus(key, order, fn); } catch (e) { /* gamemode older than /status */ } };
  addStatus('boost', 61, (a) => { const rec = recOf(a), now = Date.now(); return prop() && active(rec, now) ? `Skill boost x${rec.mult}, ${left(rec.until - now)} left` : null; });

  const running = Object.values(store.profiles).filter((r) => active(r, Date.now())).length;
  log(`playtester boost ${C.enabled ? 'on' : 'off'} (x${C.mult} for ${C.hours} h, ${Number.isFinite(C.startsAt) ? new Date(C.startsAt).toISOString() : 'no start'} to ${Number.isFinite(C.claimUntil) ? new Date(C.claimUntil).toISOString() : 'no deadline'}), ${prop() ? 'server build honours it' : 'server build has no boost: inert'}, ${running} running`);
};
