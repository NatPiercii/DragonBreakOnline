// DragonBreak Online: no character goes into the world without a name of its own. Loaded by gamemode.js.
//
// New characters are made in the game's own race menu, whose name box gives the character its name. Since
// 2026-09-29 03:57 every character made came out named "Prisoner", the game's default (GroundedPasta twice, Exsenus,
// profile 21): the race menu closed without a typed name, and nothing on the server checked it (the RP name filter,
// fork nameFilter.ts, only guards the old CEF creator). So:
// - a character whose name is a default (Prisoner, Stranger, Player, or empty) is held: it does not leave the Realm
//   for the arrival (gamemode.js sendToArrival asks __dboNameHold), and anywhere it is asked every minute to name itself;
// - /name <name> names it, once, while its name is still a default: the same shape rules and word lists as the
//   creator's filter (name-filter.json), and unique across every character (private.indexed.charName, as spawn.ts
//   keeps it). The chat is the browser's own text box, so it takes typing even when the game's name box does not.
// - A client that draws it (dbo:uiCaps 'namePrompt') is asked in a panel instead (front namePrompt, widget 68): a text
//   box and one button, answered as dbo:nameChoose with the panel's nonce; a refusal reopens it with the reason, so
//   the cursor stays. An older client keeps the chat line and /name. In the Realm the panel waits for the hold in
//   sendToArrival, after the god is chosen, so it never opens over the deity picker.
// - A name typed in the race menu is held to the same rules (__dboCreatorName, called by gamemode.js's appearance
//   hook before creation finishes): at creation a name that fails them, or that another character carries, is taken
//   off again and the character is asked for another, with the reason; in an identity reroll it goes back to the name
//   before. Nobody is refused the race menu over it, so a player whose name box takes no typing is never stuck.
// Staff keep /rename for everything else.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, registerChatCommand, onlineActors, every, profileOf, inCreation, onUi, openWidget, closeWidget, inHub } = api;
  const PANEL_ID = 68;
  const DEFAULTS = new Set(['', 'prisoner', 'stranger', 'player']);
  const INDEX = 'private.indexed.charName';
  const REFUSED = 'private.dboNameRefused';
  const ASK_EVERY_MS = 60000;
  const asked = globalThis.__dboNameAsked instanceof Map ? globalThis.__dboNameAsked : (globalThis.__dboNameAsked = new Map());
  // Both outlive a reload: which clients draw the panel, and the nonce of the panel open for each character
  const caps = globalThis.__dboNamingCaps instanceof Map ? globalThis.__dboNamingCaps : (globalThis.__dboNamingCaps = new Map());
  const nonces = globalThis.__dboNamingNonces instanceof Map ? globalThis.__dboNamingNonces : (globalThis.__dboNamingNonces = new Map());
  const hasPanel = (a) => typeof openWidget === 'function' && (caps.get(a >>> 0) || new Set()).has('namePrompt');

  const nameOf = (a) => { try { return String((mp.get(a, 'appearance') || {}).name || '').trim(); } catch (e) { return ''; } };
  const isDefault = (name) => DEFAULTS.has(String(name || '').trim().toLowerCase());
  // Still in the race menu, everyone is "Stranger": only a character past creation needs a name
  const needsName = (a) => profileOf(a) >= 0 && !(typeof inCreation === 'function' && inCreation(a)) && isDefault(nameOf(a));

  // name-filter.json, as fork nameFilter.ts reads it
  let rules = null, rulesMtime = -1;
  const readRules = () => {
    const file = path.resolve('name-filter.json');
    try {
      const m = fs.statSync(file).mtimeMs;
      if (!rules || m !== rulesMtime) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
        const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.toLowerCase()) : []);
        rules = { maxWords: n(raw.maxWords, 3), minLength: n(raw.minLength, 2), maxLength: n(raw.maxLength, 30), maxRepeatedLetters: n(raw.maxRepeatedLetters, 2), blocked: list(raw.blocked), reserved: list(raw.reserved) };
        rulesMtime = m;
      }
    } catch (e) { if (!rules) rules = { maxWords: 3, minLength: 2, maxLength: 30, maxRepeatedLetters: 2, blocked: [], reserved: [] }; }
    return rules;
  };
  // fork nameFilter.ts fold/nameKey: case, leetspeak and every separator folded away
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };
  const fold = (s) => String(s).toLowerCase().replace(/./gu, (c) => LEET[c] || c).replace(/[^\p{L}]/gu, '');

  // The creator's rules (fork nameFilter.ts checkName), or null when the name will do
  const problemWith = (name) => {
    const r = readRules();
    if (isDefault(name)) return 'Choose a name of your own.';
    if (name.length < r.minLength || name.length > r.maxLength) return `Names are ${r.minLength}-${r.maxLength} characters.`;
    if (!/^[\p{L}' -]+$/u.test(name)) return 'Names use letters, spaces, apostrophes and hyphens only.';
    if (/^[' -]|[' -]$/.test(name) || /[' -]{2}/.test(name)) return 'Names cannot start, end or run two separators together.';
    const words = name.split(' ');
    if (words.length > r.maxWords) return `Names are at most ${r.maxWords} words.`;
    const letters = name.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toUpperCase()) return 'Names are not written in capitals.';
    if (new RegExp(`(\\p{L})\\1{${r.maxRepeatedLetters},}`, 'u').test(name.toLowerCase())) return `No letter repeats more than ${r.maxRepeatedLetters} times in a row.`;
    for (const word of words) {
      if (!/^\p{L}/u.test(word)) return 'Each word starts with a letter.';
      for (let i = 1; i < word.length; i++) {
        const c = word.charAt(i);
        if (c !== c.toUpperCase() || c === c.toLowerCase()) continue;
        const before = word.charAt(i - 1);
        if (before !== "'" && before !== '-') return 'Capitals only at the start of a word.';
      }
    }
    const folded = fold(name);
    if (r.blocked.some((bad) => bad && folded.includes(bad))) return 'That name will not do here. Choose one in keeping with the world.';
    if (r.reserved.some((taken) => taken && folded === taken)) return 'That name is reserved.';
    return null;
  };
  const takenBy = (key, self) => {
    try {
      const found = mp.findFormsByPropertyValue(INDEX, key);
      return Array.isArray(found) && found.some((id) => (Number(id) >>> 0) !== (self >>> 0));
    } catch (e) { log('naming: uniqueness check failed, letting the name through', e.message); return false; }
  };

  let nonceSeq = 0;
  // Why a name typed at creation was taken off, shown once with the first ask
  const refusedReason = (a) => { try { const r = mp.get(a, REFUSED); return typeof r === 'string' ? r : ''; } catch (e) { return ''; } };
  const openPanel = (a, error) => {
    // A counter as well as the time: two panels opened in one millisecond (a refusal answered at once) differ
    const nonce = `${(a >>> 0).toString(16)}-${Date.now().toString(36)}-${(nonceSeq = (nonceSeq + 1) % 1e6).toString(36)}`;
    nonces.set(a >>> 0, nonce);
    const r = readRules();
    openWidget(a, { type: 'namePrompt', id: PANEL_ID, nonce, error: error || '', maxLength: r.maxLength, maxWords: r.maxWords,
      events: { choose: 'dbo:nameChoose' } }, true);
  };
  const ask = (a, force) => {
    const now = Date.now();
    if (!force && now - (asked.get(a) || 0) < ASK_EVERY_MS) return;
    asked.set(a, now);
    const why = refusedReason(a);
    if (hasPanel(a)) { if (force || !nonces.has(a >>> 0)) openPanel(a, why); return; }
    personal(a, `${why ? `${why} ` : ''}Your character has no name yet. Type /name and their name in the chat, for example: /name Aela Brightwater. You leave the Realm once named.`);
  };

  // gamemode.js sendToArrival asks before moving anyone out of the Realm: true = hold them there
  // Prose the player writes (the Character Journal's story, journal.js): true when a word holds a blocked one. Checked
  // word by word, so a blocked word cannot be matched across the spaces of ordinary text
  globalThis.__dboTextBlocked = (text) => {
    const r = readRules();
    if (!r.blocked.length) return false;
    return String(text || '').split(/\s+/).some((w) => { const f = fold(w); return f && r.blocked.some((bad) => bad && f.includes(bad)); });
  };
  globalThis.__dboNameHold = (a) => {
    if (!needsName(a)) return false;
    ask(a, false);
    return true;
  };

  // Names the character, or says why not: { ok } | { error }
  const takeName = (a, raw, via) => {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    const problem = problemWith(name);
    if (problem) return { error: problem };
    const key = fold(name);
    if (takenBy(key, a)) return { error: 'Someone already carries that name. Choose another.' };
    try {
      const app = Object.assign({}, mp.get(a, 'appearance') || {});
      const old = app.name || 'Prisoner';
      app.name = name;
      mp.set(a, 'appearance', app);
      mp.set(a, INDEX, key);
      try { mp.set(a, REFUSED, null); } catch (e) { /* nothing to clear */ }
      asked.delete(a);
      personal(a, `Your character is now ${name}.`);
      audit(`NAME ${who(a)} named themselves "${name}" (was "${old}", ${via})`);
      log(`naming: ${display(a)} named themselves ${name} (${via})`);
      if (typeof globalThis.__dboNamed === 'function') globalThis.__dboNamed(a);
      return { ok: true };
    } catch (e) { log('naming: failed', e.message); return { error: 'That did not work. Try again.' }; }
  };

  registerChatCommand('name', (a, args) => {
    if (!needsName(a)) return personal(a, 'Your character already has a name. Staff can change it with /rename.');
    if (!String(args || '').trim()) return ask(a, true);
    const r = takeName(a, args, 'chat');
    if (r.error) personal(a, `${r.error} Try /name again.`);
    else if (nonces.delete(a >>> 0)) closeWidget(a, PANEL_ID);
  }, { help: '<name> name your character, if it came out of creation without one' });

  if (typeof onUi === 'function') {
    onUi('uiCaps', (a, args) => { caps.set(a >>> 0, new Set((args || []).map(String))); });
    onUi('nameChoose', (a, args) => {
      if (nonces.get(a >>> 0) !== String(args[0] || '')) return;
      if (!needsName(a)) { nonces.delete(a >>> 0); closeWidget(a, PANEL_ID); return; }
      const r = takeName(a, args[1], 'panel');
      if (r.error) { openPanel(a, r.error); return; }
      nonces.delete(a >>> 0);
      closeWidget(a, PANEL_ID);
    });
    // Escape closes it; the reminder opens it again a minute later
    onUi('close', (a, args, widgetId) => { if (Number(widgetId) === PANEL_ID) nonces.delete(a >>> 0); });
  }

  // A name from the race menu, before the engine takes the new look: kind 'creation' (a new character) or 'reroll'.
  // The look is always accepted; the name is fixed right after the engine has applied it.
  globalThis.__dboCreatorName = (a, appearance, kind) => {
    const name = String((appearance && appearance.name) || '').trim().replace(/\s+/g, ' ');
    let before = '';
    try { before = String((mp.get(a, 'appearance') || {}).name || ''); } catch (e) { before = ''; }
    const problem = isDefault(name) ? (kind === 'reroll' ? 'No name was given.' : null)
      : problemWith(name) || (takenBy(fold(name), a) ? 'Someone already carries that name.' : null);
    setTimeout(() => {
      try {
        const app = Object.assign({}, mp.get(a, 'appearance') || {});
        if (!problem) {
          if (!isDefault(name)) { mp.set(a, INDEX, fold(name)); mp.set(a, REFUSED, null); }
          return;
        }
        if (kind === 'reroll' && before && !isDefault(before)) {
          app.name = before; mp.set(a, 'appearance', app);
          personal(a, `The name "${name}" will not do (${problem}) Your character keeps the name ${before}.`);
          audit(`NAME ${who(a)} reroll name "${name}" refused (${problem}); kept "${before}"`);
          return;
        }
        app.name = 'Prisoner'; mp.set(a, 'appearance', app);
        mp.set(a, REFUSED, `The name "${name}" will not do: ${problem}`);
        audit(`NAME ${who(a)} creation name "${name}" refused (${problem}); asked for another`);
        log(`naming: ${display(a)} typed "${name}" at creation, refused: ${problem}`);
      } catch (e) { log('naming: creator name check failed', e.message); }
    }, 0);
    return problem;
  };

  // Anyone already out in the world under a default name (made before this guard) is asked too
  // Not in the Realm: there the hold in sendToArrival asks, after the deity picker has closed
  every('naming', 20000, () => { for (const a of onlineActors()) if (needsName(a) && !(typeof inHub === 'function' && inHub(a))) ask(a, false); });

  return { problemWith, fold, needsName, isDefault };
};
