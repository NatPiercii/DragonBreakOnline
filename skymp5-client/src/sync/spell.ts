import { Actor, Game, Spell, printConsole } from 'skyrimPlatform';

export const removeAllSpells = (actor: Actor) => {
  let spellToRemove = new Array<Spell>();

  for (let i = 0; i < actor.getSpellCount(); i++) {
    const spell = actor.getNthSpell(i);

    if (spell) {
      spellToRemove.push(spell);
    }
  }

  for (let spell of spellToRemove) {
    const removeResult = actor.removeSpell(spell);
    printConsole(
      `removeResult: ${removeResult}, spellIdToRemove: ${spell
        .getFormID()
        .toString(16)}, spellName: ${spell.getName()}`,
    );
  }
};

// Makes the actor's spells equal the server's list and returns how many it had to change
export const enforceSpells = (actor: Actor, spellIds: Array<number>): number => {
  const wanted = spellIds.map((id) => id >>> 0);
  const present = new Array<number>();
  const toRemove = new Array<Spell>();
  let changed = 0;

  for (let i = 0; i < actor.getSpellCount(); i++) {
    const spell = actor.getNthSpell(i);
    if (!spell) {
      continue;
    }
    const id = spell.getFormID() >>> 0;
    if (wanted.indexOf(id) !== -1) {
      present.push(id);
    } else {
      toRemove.push(spell);
    }
  }

  // Collected first because removing shifts the indices of the remaining spells
  for (let i = 0; i < toRemove.length; i++) {
    actor.removeSpell(toRemove[i]);
    changed++;
  }

  for (let i = 0; i < wanted.length; i++) {
    if (present.indexOf(wanted[i]) !== -1) {
      continue;
    }
    const spell = Spell.from(Game.getFormEx(wanted[i]));
    if (spell) {
      actor.addSpell(spell, false);
      changed++;
    }
  }

  return changed;
};

// The server's list as of the last CreateActor. The enforcement passes are keyed to login, but the
// race menu grants race and Player-record spells as it closes - which is after the last pass on a
// freshly created character - so the list has to survive for a second round.
// Server spell snippets for the player keep it current, so a pass never undoes a later grant or removal.
let serverSpells: Array<number> | null = null;

export const rememberServerSpells = (spellIds: Array<number>): void => {
  serverSpells = spellIds.map((id) => id >>> 0);
};

export const getServerSpells = (): Array<number> | null => (serverSpells ? serverSpells.slice() : null);

// PapyrusActor.cpp sends these to the player's own client (selfId 0x14) after changing its own list; EquipSpell learns first
const SPELL_SNIPPET_ADDS = new Map<string, boolean>([['addspell', true], ['equipspell', true], ['removespell', false]]);
const PLAYER_SELF_ID = 0x14;

// Mirrors a server spell snippet for the player into the list. Numbers only; returns true when it applied
export const noteServerSpellSnippet = (snippet: { class: unknown; function: unknown; selfId: unknown; arguments: unknown }): boolean => {
  if (!serverSpells || Number(snippet.selfId) !== PLAYER_SELF_ID) {
    return false;
  }
  if (typeof snippet.class !== 'string' || snippet.class.toLowerCase() !== 'actor' || typeof snippet.function !== 'string') {
    return false;
  }
  const adds = SPELL_SNIPPET_ADDS.get(snippet.function.toLowerCase());
  const arg = Array.isArray(snippet.arguments) ? snippet.arguments[0] : undefined;
  const raw = arg && typeof arg === 'object' ? Number((arg as { formId?: unknown }).formId) : NaN;
  if (adds === undefined || !Number.isFinite(raw) || raw <= 0) {
    return false;
  }
  const id = raw >>> 0;
  const rest = serverSpells.filter((x) => x !== id);
  serverSpells = adds ? rest.concat([id]) : rest;
  return true;
};

// Re-applies the remembered list. Returns 0 when no CreateActor has been seen yet.
export const reenforceServerSpells = (actor: Actor): number =>
  serverSpells ? enforceSpells(actor, serverSpells) : 0;

export const learnSpells = (actor: Actor, spellsIds: Array<number>) => {
  for (let spellId of spellsIds) {
    const spell = Spell.from(Game.getFormEx(spellId));

    if (spell) {
      const addResult = actor.addSpell(spell, false);
      printConsole(
        `addResult: ${addResult}, spellIdToLearn: ${spell
          .getFormID()
          .toString(16)}, spellName: ${spell.getName()}`,
      );
    }
  }
};
