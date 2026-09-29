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
// Staff keep /rename for everything else.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, who, display, registerChatCommand, onlineActors, every, profileOf, inCreation } = api;
  const DEFAULTS = new Set(['', 'prisoner', 'stranger', 'player']);
  const INDEX = 'private.indexed.charName';
  const ASK_EVERY_MS = 60000;
  const asked = globalThis.__dboNameAsked instanceof Map ? globalThis.__dboNameAsked : (globalThis.__dboNameAsked = new Map());

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

  const ask = (a, force) => {
    const now = Date.now();
    if (!force && now - (asked.get(a) || 0) < ASK_EVERY_MS) return;
    asked.set(a, now);
    personal(a, 'Your character has no name yet. Type /name and their name in the chat, for example: /name Aela Brightwater. You leave the Realm once named.');
  };

  // gamemode.js sendToArrival asks before moving anyone out of the Realm: true = hold them there
  globalThis.__dboNameHold = (a) => {
    if (!needsName(a)) return false;
    ask(a, false);
    return true;
  };

  registerChatCommand('name', (a, args) => {
    if (!needsName(a)) return personal(a, 'Your character already has a name. Staff can change it with /rename.');
    const name = String(args || '').trim().replace(/\s+/g, ' ');
    if (!name) return ask(a, true);
    const problem = problemWith(name);
    if (problem) return personal(a, `${problem} Try /name again.`);
    const key = fold(name);
    if (takenBy(key, a)) return personal(a, 'Someone already carries that name. Try /name with another.');
    try {
      const app = Object.assign({}, mp.get(a, 'appearance') || {});
      const old = app.name || 'Prisoner';
      app.name = name;
      mp.set(a, 'appearance', app);
      mp.set(a, INDEX, key);
      asked.delete(a);
      personal(a, `Your character is now ${name}.`);
      audit(`NAME ${who(a)} named themselves "${name}" (was "${old}")`);
      log(`naming: ${display(a)} named themselves ${name}`);
      if (typeof globalThis.__dboNamed === 'function') globalThis.__dboNamed(a);
    } catch (e) { personal(a, 'That did not work. Try /name again.'); log('naming: failed', e.message); }
  }, { help: '<name> name your character, if it came out of creation without one' });

  // Anyone already out in the world under a default name (made before this guard) is asked too
  every('naming', 20000, () => { for (const a of onlineActors()) if (needsName(a)) ask(a, false); });

  return { problemWith, fold, needsName, isDefault };
};
