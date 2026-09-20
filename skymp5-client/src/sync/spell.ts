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
let serverSpells: Array<number> | null = null;

export const rememberServerSpells = (spellIds: Array<number>): void => {
  serverSpells = spellIds.map((id) => id >>> 0);
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
