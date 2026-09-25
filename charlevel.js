'use strict';
// Character level 1-5 (config "charLevel"). Earned from the work done across every skill, paced so level 5
// lands about when a first skill reaches Master; each level buys +perLevel to Health, Magicka or Stamina.
// State: private.dboLevel { level, pending, spent: { health, magicka, stamina } } on the character.
// private.dboAvBonus holds the spent totals: the server adds them to the maximum it measures hits and
// restores against (MpActor::AddLevelBonus), and the next login's creation message carries them.

module.exports = (api) => {
  const { mp, log, personal, system, audit, display, cfg, openWidget, closeWidget, onUi, registerChatCommand,
    onlineActors, every, sendPacket } = api;

  const CFG = Object.assign({
    enabled: true,
    // Units of work one skill needs for Apprentice, Journeyman, Expert and Master (fork skillPoints.ts)
    thresholds: [0, 250, 750, 1750, 2950],
    perLevel: 10,
    checkSeconds: 30,
  }, cfg.charLevel || {});
  const WIDGET_ID = 43;
  const MAX_LEVEL = CFG.thresholds.length;
  const VITALS = { health: 'Health', magicka: 'Magicka', stamina: 'Stamina' };

  // Mirror of skillPoints.ts xpPerUnitAt: [first level of band, xp per unit]; 100 xp make a level
  const BANDS = [[95, 0.25], [90, 0.5], [75, 1.25], [50, 2.5], [25, 5], [0, 10]];
  const xpPerUnitAt = (level) => BANDS.find((b) => level >= b[0])[1];
  const unitsOfSkill = (level, xp) => {
    let units = 0;
    for (let l = 0; l < Math.max(0, Math.min(level, 100)); l++) units += 100 / xpPerUnitAt(l);
    if (level < 100) units += Math.max(0, Number(xp) || 0) / xpPerUnitAt(level);
    return units;
  };

  const get = (a, prop, dflt) => { try { const v = mp.get(a, prop); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } };
  const unitsOf = (a) => {
    const r = get(a, 'private.mastery', null);
    if (!r || r.v !== 2 || !r.skills) return 0;
    return Object.values(r.skills).reduce((sum, s) => sum + (s && s.level > 0 ? unitsOfSkill(Number(s.level) || 0, s.xp) : 0), 0);
  };
  const levelOfUnits = (units) => {
    let level = 1;
    for (let i = 1; i < CFG.thresholds.length; i++) if (units >= CFG.thresholds[i]) level = i + 1;
    return level;
  };
  const stateOf = (a) => {
    const s = get(a, 'private.dboLevel', null);
    const spent = (s && s.spent) || {};
    return {
      level: Math.max(1, Math.min(MAX_LEVEL, Number(s && s.level) || 1)),
      pending: Math.max(0, Number(s && s.pending) || 0),
      spent: { health: Number(spent.health) || 0, magicka: Number(spent.magicka) || 0, stamina: Number(spent.stamina) || 0 },
    };
  };
  const save = (a, st) => {
    mp.set(a, 'private.dboLevel', st);
    mp.set(a, 'private.dboAvBonus', st.spent);
  };

  const openChoice = (a) => {
    const st = stateOf(a);
    if (!st.pending) return;
    const actions = Object.keys(VITALS).map((av) => ({ id: av, label: `+${CFG.perLevel} ${VITALS[av]} (now +${st.spent[av]})` }));
    // A race swap (beast form) tears the panel down client-side while the id stays taken, and the re-open is then ignored
    closeWidget(a, WIDGET_ID);
    openWidget(a, { type: 'contextMenu', id: WIDGET_ID, mode: 'menu', targetName: `Level ${st.level}: ${st.pending} point${st.pending === 1 ? '' : 's'} to spend`,
      actions, events: { action: 'dbo:levelChoose', close: 'dbo:levelClose' } }, true);
    log(`level ${display(a)} offered ${st.pending} point(s) at level ${st.level}`);
  };
  const spend = (a, av) => {
    const st = stateOf(a);
    if (!VITALS[av]) { personal(a, `Spend a point on health, magicka or stamina: /level health`); return false; }
    if (st.pending < 1) { personal(a, 'You have no points to spend.'); return false; }
    st.pending -= 1;
    st.spent[av] += CFG.perLevel;
    save(a, st);
    sendPacket(a, { customPacketType: 'dboAvGain', [av]: CFG.perLevel });
    personal(a, `+${CFG.perLevel} ${VITALS[av]}.${st.pending ? ` ${st.pending} more to spend.` : ''}`);
    log(`level ${display(a)} spent a point on ${av}: ${JSON.stringify(st.spent)}`);
    return true;
  };

  // Levels are never taken back: a skill giving way to the pool must not unlearn a character level
  const check = (a) => {
    if (!CFG.enabled) return false;
    const st = stateOf(a);
    const earned = levelOfUnits(unitsOf(a));
    if (earned <= st.level) return false;
    const gained = earned - st.level;
    st.pending += gained;
    st.level = earned;
    save(a, st);
    audit(`LEVEL ${display(a)} reached character level ${earned}`);
    system(a, `You have reached level ${earned}. Choose where your strength grows: /level`);
    openChoice(a);
    return true;
  };

  onUi('levelChoose', (a, args) => {
    const av = String(args[0] || '');
    // Closing first lost both the click and the panel whenever the choice did not take
    if (!spend(a, av)) { openChoice(a); return; }
    closeWidget(a, WIDGET_ID);
    if (stateOf(a).pending) openChoice(a);
  });
  onUi('levelClose', (a) => closeWidget(a, WIDGET_ID));

  registerChatCommand('level', (a, args) => {
    const arg = String((args && args[0]) || '').toLowerCase();
    // The panel is not always reachable, so a point can always be spent from chat
    if (arg) { spend(a, arg); return; }
    const st = stateOf(a);
    const units = unitsOf(a);
    const next = st.level < MAX_LEVEL ? CFG.thresholds[st.level] : null;
    personal(a, `Level ${st.level} of ${MAX_LEVEL}. ${next ? `Progress to level ${st.level + 1}: ${Math.floor(Math.min(99, (units / next) * 100))}%.` : 'You have reached the highest level.'} Bonuses: Health +${st.spent.health}, Magicka +${st.spent.magicka}, Stamina +${st.spent.stamina}.`);
    if (st.pending) {
      personal(a, `${st.pending} unspent point${st.pending === 1 ? '' : 's'}. Choose in the panel, or type /level health, /level magicka or /level stamina.`);
      openChoice(a);
    }
  }, { help: 'your character level and progress; /level <health|magicka|stamina> spends a point' });

  globalThis.__dboCharLevel = (a) => stateOf(a).level;
  globalThis.__dboCharLevelLogin = (a) => { if (!check(a)) openChoice(a); };
  every('charLevel', CFG.checkSeconds * 1000, () => onlineActors().forEach((a) => { try { check(a); } catch (e) { log('level check failed', e.message); } }));
  log(`character levels ${CFG.enabled ? 'on' : 'off'}: thresholds ${CFG.thresholds.join('/')} units, +${CFG.perLevel} a level`);
};
