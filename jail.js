// Jails, cell doors and sentences, loaded by gamemode.js like rest.js and prayer.js.
//
// A jail zone is an interior cell: seeded from gamemode-config "jail.cells", added in game by an admin with
// /jail add (kept in jails.json, which is runtime data and never tracked). /unstuck is refused inside one,
// and anywhere while a sentence is unserved.
//
// A cell door is any door in a jail zone that is not a load door (doors.json lists every load door). A guard or
// official (private.dboLawful, or an admin) who uses one with a player in reach can imprison them: the door
// closes, the prisoner is registered to it, and it stays locked until the time is served. Time counts only while
// the prisoner is online and inside the jail; logging out does not count, and neither does time spent outside
// after an escape. Anyone with a lockpick may try the lock (the dungeons.js model: a server roll by Lockpicking
// tier, a broken pick on a failure). When the time is served the prisoner is told and the door unlocks.
//
// State, on changeforms:
//   door      private.dboCell      { prisoner, name, picked }
//   prisoner  private.dboSentence  { door, cell, totalMs, servedMs, by, at }

const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, who, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, every, isAdmin, distanceMeters } = api;

  const CFG = Object.assign({
    enabled: true,
    cells: [],
    minutes: [5, 10, 15, 30, 60, 120],
    extendMinutes: 10,
    reachMeters: 8,
    // Lockpicking: a non-Lockpicker's chance, a Lockpicker's at Novice, what each tier adds, and the ceiling.
    pickChance: { anyone: 0.15, lockpicker: 0.35, perTier: 0.1, max: 0.85 },
    pickCooldownSeconds: 3,
  }, cfg.jail || {});

  const WIDGET_ID = 42;
  const TICK_MS = 5000;
  const MAX_CREDIT_MS = 15000; // one tick's worth, so a gap (reload, lag, relog) never counts as served time
  const MIN = 60000;
  const LOCKPICK = 0x0000000a;
  const JAILS_FILE = path.resolve('jails.json');

  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const get = (id, prop, dflt) => { try { const v = mp.get(id, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const set = (id, prop, v) => { try { mp.set(id, prop, v); return true; } catch (e) { log(`jail: set ${prop} failed`, e.message); return false; } };
  const norm = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const cellOf = (id) => norm(get(id, 'worldOrCellDesc', ''));
  const minutes = (ms) => Math.max(0, Math.ceil(ms / MIN));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- jail zones -------------------------------------------------------------------------------------
  // Descs are kept as the server wrote them: getIdFromDesc matches the plugin name exactly, so only comparisons use norm()
  const readAdded = () => { try { const v = JSON.parse(fs.readFileSync(JAILS_FILE, 'utf8')); return Array.isArray(v.cells) ? v.cells.map(String) : []; } catch (e) { return []; } };
  const saveAdded = (list) => { try { fs.writeFileSync(JAILS_FILE, JSON.stringify({ cells: list }, null, 1)); } catch (e) { log('jail: jails.json write failed', e.message); } };
  let added = readAdded();
  const rawCells = () => (CFG.cells || []).map(String).concat(added);
  const jailCells = () => new Set(rawCells().map(norm));
  const isJail = (cell) => !!cell && jailCells().has(cell);
  const jailName = (cell) => {
    try {
      const raw = rawCells().find((c) => norm(c) === cell) || cell;
      const r = mp.lookupEspmRecordById(idOf(raw));
      const e = String((r && r.record && r.record.editorId) || '');
      const words = e.replace(/^(CYR|BSK|BSH)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim();
      return words || 'the jail';
    } catch (e) { return 'the jail'; }
  };

  // ---- cell doors -------------------------------------------------------------------------------------
  const LOAD_DOORS = new Set();
  try { for (const d of Object.keys(JSON.parse(fs.readFileSync(path.resolve('doors.json'), 'utf8')).doors || {})) { const id = idOf(d); if (id) LOAD_DOORS.add(id); } }
  catch (e) { log('jail: doors.json unreadable, every door in a jail counts as a cell door', e.message); }
  const isDoor = (ref) => { try { const r = mp.lookupEspmRecordById(idOf(get(ref, 'baseDesc', ''))); return !!(r && r.record && String(r.record.type) === 'DOOR'); } catch (e) { return false; } };
  const isCellDoor = (ref) => ref < 0xff000000 && !LOAD_DOORS.has(ref >>> 0) && isJail(cellOf(ref)) && isDoor(ref);

  const sentenceOf = (a) => { const s = get(a, 'private.dboSentence', null); return s && Number(s.totalMs) > 0 ? s : null; };
  const leftOf = (s) => Math.max(0, Number(s.totalMs) - (Number(s.servedMs) || 0));
  // The door's prisoner, while their sentence on it is unserved
  const occupantOf = (door) => {
    const c = get(door, 'private.dboCell', null);
    if (!c || !Number(c.prisoner)) return null;
    const s = sentenceOf(Number(c.prisoner) >>> 0);
    if (!s || (Number(s.door) >>> 0) !== (door >>> 0) || leftOf(s) <= 0) return null;
    return { prisoner: Number(c.prisoner) >>> 0, name: String(c.name || 'a prisoner'), picked: !!c.picked, sentence: s };
  };
  const lawful = (a) => get(a, 'private.dboLawful', false) === true || isAdmin(a);

  // ---- the menu ---------------------------------------------------------------------------------------
  const pending = new Map(); // actorId -> { door, candidate? }
  const openMenu = (a, door, title, actions) => {
    pending.set(a >>> 0, { door: door >>> 0 });
    openWidget(a, { type: 'contextMenu', id: WIDGET_ID, mode: 'menu', targetName: title, actions, events: { action: 'dbo:jailChoose', close: 'dbo:jailClose' } }, true);
  };
  const closeMenu = (a) => { pending.delete(a >>> 0); closeWidget(a, WIDGET_ID); };

  // Players a guard could lock in here: online, near the door, not the guard, not already serving
  const candidates = (guard, door) => onlineActors()
    .filter((p) => p !== (guard >>> 0) && distanceMeters(p, door) <= CFG.reachMeters && !sentenceOf(p))
    .slice(0, 5);

  // ---- lockpicking ------------------------------------------------------------------------------------
  const pickAt = new Map();
  const lockpickingTier = (a) => { const r = get(a, 'private.mastery', null); if (!r || !Array.isArray(r.order) || !r.order.includes('lockpicking')) return -1; return Math.max(0, Number(((r.skills || {}).lockpicking || {}).rank) || 0); };
  const takeLockpick = (a) => {
    try {
      const inv = mp.get(a, 'inventory') || { entries: [] };
      const entries = (Array.isArray(inv.entries) ? inv.entries : []).map((e) => Object.assign({}, e));
      const hit = entries.find((e) => e && (Number(e.baseId) >>> 0) === LOCKPICK && Number(e.count) > 0 && !e.worn);
      if (!hit) return false;
      hit.count -= 1;
      mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) });
      return true;
    } catch (e) { return false; }
  };
  const hasLockpick = (a) => { try { const inv = mp.get(a, 'inventory') || { entries: [] }; return (inv.entries || []).some((e) => e && (Number(e.baseId) >>> 0) === LOCKPICK && Number(e.count) > 0); } catch (e) { return false; } };
  // true: the lock gave way (the activation goes on and opens the door)
  const tryPick = (a, door, occ) => {
    const now = Date.now();
    if (now - (pickAt.get(a) || 0) < CFG.pickCooldownSeconds * 1000) return false;
    pickAt.set(a, now);
    if (!hasLockpick(a)) { personal(a, 'The cell door is locked. You would need a lockpick.'); return false; }
    const tier = lockpickingTier(a);
    const P = CFG.pickChance;
    const chance = Math.min(Number(P.max), tier < 0 ? Number(P.anyone) : Number(P.lockpicker) + Number(P.perTier) * tier);
    if (Math.random() < chance) {
      const c = get(door, 'private.dboCell', {}) || {};
      set(door, 'private.dboCell', Object.assign({}, c, { picked: true }));
      system(a, 'The cell door lock gives way.');
      audit(`JAIL ${who(a)} picked the lock of ${occ.name}'s cell ${mp.getDescFromId(door >>> 0)}`);
      try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('lock', a, { refrId: door, level: 3 }); } catch (e) { /* no skill system */ }
      return true;
    }
    takeLockpick(a);
    personal(a, 'The pick snaps in the cell door lock.');
    return false;
  };

  // Called from the gamemode's activate chain; true means handled (the activation is refused).
  globalThis.__dboJailActivate = (target, caster) => {
    if (!CFG.enabled || !isCellDoor(target)) return false;
    const occ = occupantOf(target);
    const isPrisoner = occ && occ.prisoner === (caster >>> 0);
    if (lawful(caster) && !isPrisoner) {
      if (occ) {
        const left = minutes(leftOf(occ.sentence));
        const actions = [
          { id: 'release', label: `Release ${occ.name} now` },
          { id: 'extend', label: `Add ${CFG.extendMinutes} minutes` },
        ];
        if (occ.picked) actions.push({ id: 'relock', label: 'Lock it again' });
        actions.push({ id: 'open', label: 'Open the door' });
        openMenu(caster, target, `${occ.name}: ${plural(left, 'minute')} left`, actions);
        return true;
      }
      const near = candidates(caster, target);
      if (!near.length) return false; // an empty cell is an ordinary door
      openMenu(caster, target, 'Cell door', near.map((p) => ({ id: `who:${p.toString(16)}`, label: `Imprison ${display(p)}` })).concat([{ id: 'open', label: 'Just open the door' }]));
      return true;
    }
    if (!occ || occ.picked) return false;
    if (isPrisoner) personal(caster, `The cell door is locked. ${plural(minutes(leftOf(occ.sentence)), 'minute')} left to serve.`);
    return !tryPick(caster, target, occ);
  };

  const imprison = (guard, prisoner, door, mins) => {
    if (!lawful(guard)) return;
    if (sentenceOf(prisoner)) return personal(guard, `${display(prisoner)} is already serving a sentence.`);
    if (!onlineActors().includes(prisoner) || distanceMeters(prisoner, door) > CFG.reachMeters) return personal(guard, `${display(prisoner)} is no longer at the cell.`);
    if (occupantOf(door)) return personal(guard, 'Someone is already locked in that cell.');
    const cell = cellOf(door);
    const now = Date.now();
    set(prisoner, 'private.dboSentence', { door: door >>> 0, cell, totalMs: mins * MIN, servedMs: 0, by: display(guard), at: now });
    set(door, 'private.dboCell', { prisoner: prisoner >>> 0, name: display(prisoner), picked: false });
    set(door, 'isOpen', false);
    lastSeen.delete(prisoner >>> 0);
    system(prisoner, `${display(guard)} sentences you to ${plural(mins, 'minute')} in ${jailName(cell)}. Time counts only while you are online and in the jail. /sentence shows what is left.`);
    personal(guard, `${display(prisoner)} is locked in for ${plural(mins, 'minute')}. The door opens when the time is served.${get(prisoner, 'private.restrained', null) ? ' Their hands are still bound: uncuff them through the bars.' : ''}`);
    audit(`JAIL ${who(guard)} imprisoned ${who(prisoner)} for ${mins} min in ${jailName(cell)} (door ${mp.getDescFromId(door >>> 0)})`);
  };

  // Ends a sentence, served or released; the door's record goes with it
  const finish = (prisoner, how) => {
    const s = sentenceOf(prisoner); if (!s) return;
    const door = Number(s.door) >>> 0;
    const c = get(door, 'private.dboCell', null);
    if (c && (Number(c.prisoner) >>> 0) === (prisoner >>> 0)) set(door, 'private.dboCell', null);
    set(prisoner, 'private.dboSentence', null);
    lastSeen.delete(prisoner >>> 0);
    audit(`JAIL ${who(prisoner)} ${how} (${Math.round((Number(s.servedMs) || 0) / MIN)} of ${Math.round(Number(s.totalMs) / MIN)} min served)`);
  };

  onUi('jailChoose', (a, args) => {
    const p = pending.get(a >>> 0); const choice = String(args[0] || '');
    closeMenu(a);
    if (!p || !lawful(a)) return;
    const door = p.door;
    if (distanceMeters(a, door) > CFG.reachMeters) return personal(a, 'You are too far from the cell door.');
    if (choice === 'open') { set(door, 'isOpen', true); return; }
    if (choice.startsWith('who:')) {
      const prisoner = parseInt(choice.slice(4), 16) >>> 0;
      pending.set(a >>> 0, { door, candidate: prisoner });
      openWidget(a, { type: 'contextMenu', id: WIDGET_ID, mode: 'menu', targetName: `Sentence ${display(prisoner)}`,
        actions: (CFG.minutes || []).map((m) => ({ id: `time:${prisoner.toString(16)}:${m}`, label: m >= 60 && m % 60 === 0 ? plural(m / 60, 'hour') : plural(m, 'minute') })),
        events: { action: 'dbo:jailChoose', close: 'dbo:jailClose' } }, true);
      return;
    }
    if (choice.startsWith('time:')) {
      const [, who16, m] = choice.split(':');
      const mins = Number(m);
      if (!(CFG.minutes || []).includes(mins)) return;
      return imprison(a, parseInt(who16, 16) >>> 0, door, mins);
    }
    const occ = occupantOf(door);
    if (!occ) return personal(a, 'Nobody is serving time in that cell now.');
    if (choice === 'release') {
      finish(occ.prisoner, `released early by ${display(a)}`);
      system(occ.prisoner, `${display(a)} releases you. The cell door is unlocked.`);
      personal(a, `${occ.name} is released.`);
    } else if (choice === 'extend') {
      set(occ.prisoner, 'private.dboSentence', Object.assign({}, occ.sentence, { totalMs: Number(occ.sentence.totalMs) + CFG.extendMinutes * MIN }));
      system(occ.prisoner, `${display(a)} adds ${plural(CFG.extendMinutes, 'minute')} to your sentence.`);
      personal(a, `${occ.name}: ${plural(minutes(leftOf(occ.sentence) + CFG.extendMinutes * MIN), 'minute')} left.`);
      audit(`JAIL ${who(a)} added ${CFG.extendMinutes} min to ${who(occ.prisoner)}`);
    } else if (choice === 'relock') {
      const c = get(door, 'private.dboCell', {}) || {};
      set(door, 'private.dboCell', Object.assign({}, c, { picked: false }));
      set(door, 'isOpen', false);
      personal(a, 'The cell door is locked again.');
    }
  });
  onUi('jailClose', (a) => closeMenu(a));
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) pending.delete(a >>> 0); });

  // ---- serving time -----------------------------------------------------------------------------------
  // Last tick each prisoner was seen online and in the jail. Nothing is persisted, so a login starts from zero.
  const lastSeen = globalThis.__dboJailSeen instanceof Map ? globalThis.__dboJailSeen : (globalThis.__dboJailSeen = new Map());
  every('jail', TICK_MS, () => {
    if (!CFG.enabled) return;
    const now = Date.now();
    const online = new Set(onlineActors());
    for (const a of lastSeen.keys()) if (!online.has(a)) lastSeen.delete(a);
    for (const a of online) {
      const s = sentenceOf(a); if (!s) continue;
      if (cellOf(a) !== s.cell) { lastSeen.delete(a); continue; } // out of the jail: nothing counts
      const prev = lastSeen.get(a); lastSeen.set(a, now);
      if (prev === undefined) continue;
      const servedMs = (Number(s.servedMs) || 0) + Math.min(MAX_CREDIT_MS, Math.max(0, now - prev));
      if (servedMs >= Number(s.totalMs)) {
        set(a, 'private.dboSentence', Object.assign({}, s, { servedMs }));
        finish(a, 'served the sentence');
        system(a, 'Your time is served. The cell door is unlocked.');
        continue;
      }
      set(a, 'private.dboSentence', Object.assign({}, s, { servedMs }));
    }
  });

  globalThis.__dboJailLogin = (a) => {
    const s = sentenceOf(a); if (!s) return;
    system(a, `You still have ${plural(minutes(leftOf(s)), 'minute')} to serve in ${jailName(s.cell)}. Time counts only while you are in the jail.`);
  };

  // A reason /unstuck is refused, or null
  globalThis.__dboJailUnstuck = (a) => {
    if (!CFG.enabled) return null;
    if (sentenceOf(a)) return 'You cannot use /unstuck while serving a sentence.';
    if (isJail(cellOf(a))) return 'You cannot use /unstuck in a jail.';
    return null;
  };

  // ---- commands ---------------------------------------------------------------------------------------
  registerChatCommand('sentence', (a) => {
    const s = sentenceOf(a);
    if (!s) return personal(a, 'You are not serving a sentence.');
    const where = cellOf(a) === s.cell ? '' : ' You are outside the jail, so none of it is counting.';
    personal(a, `${plural(minutes(leftOf(s)), 'minute')} left of ${plural(Math.round(Number(s.totalMs) / MIN), 'minute')} in ${jailName(s.cell)}, set by ${s.by}.${where}`);
  }, { help: 'Time left on your sentence' });

  registerChatCommand('jail', (a, args) => {
    const sub = String((Array.isArray(args) ? args[0] : String(args || '').split(/\s+/)[0]) || '').toLowerCase();
    const here = cellOf(a);
    if (sub === 'list') {
      const list = [...jailCells()];
      return personal(a, list.length ? `Jail zones: ${list.map((c) => `${jailName(c)} (${c})`).join(', ')}` : 'No jail zones.');
    }
    const hereRaw = String(get(a, 'worldOrCellDesc', ''));
    if (!here) return personal(a, 'Stand inside the cell you mean.');
    let isInterior = false;
    try { const r = mp.lookupEspmRecordById(idOf(hereRaw)); isInterior = !!(r && r.record && String(r.record.type) === 'CELL'); } catch (e) { /* unknown */ }
    if (sub === 'add') {
      if (!isInterior) return personal(a, 'Only an interior can be a jail. Stand inside it.');
      if (isJail(here)) return personal(a, `${jailName(here)} is already a jail zone.`);
      added = added.concat([hereRaw]); saveAdded(added);
      audit(`JAIL ${who(a)} designated ${jailName(here)} (${here}) a jail zone`);
      return personal(a, `${jailName(here)} is now a jail zone: no /unstuck, and its cell doors take prisoners.`);
    }
    if (sub === 'remove') {
      if (!added.some((c) => norm(c) === here)) return personal(a, (CFG.cells || []).map(norm).includes(here) ? 'That jail is set in gamemode-config and stays.' : 'This cell is not a jail zone.');
      added = added.filter((c) => norm(c) !== here); saveAdded(added);
      audit(`JAIL ${who(a)} removed ${jailName(here)} (${here}) as a jail zone`);
      return personal(a, `${jailName(here)} is no longer a jail zone.`);
    }
    personal(a, '/jail add (this cell becomes a jail), /jail remove, /jail list');
  }, { admin: true, help: 'Designate jail zones: /jail add | remove | list' });

  log(`jail ${CFG.enabled ? 'on' : 'off'}: ${jailCells().size} jail zone(s), ${LOAD_DOORS.size} load doors known, sentences of ${(CFG.minutes || []).join('/')} min`);
};
