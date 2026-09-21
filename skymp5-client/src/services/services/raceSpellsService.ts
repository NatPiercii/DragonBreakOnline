import { Actor, Game, Race, Spell } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";


// Attempts before a spell is written off as base-record inherited, counted one per pass not per frame.
const GIVE_UP_AFTER = 12;

const RECHECK_MS = 4000;

// Removes spells the character's race does not grant, so an Orc stops holding Nord powers.
// The server cannot do this: PapyrusActor::RemoveSpell refuses base-inherited spells.
// The strip set is derived from the race records, so a plugin retune needs no edit here.
export class RaceSpellsService extends ClientListener {
    private nextCheckAt = 0;
    private foreignByRace = new Map<number, number[]>();
    private stubborn = new Set<number>();
    private attempts = new Map<number, number>();
    private lingering = new Map<number, number>();
    private lastRaceId = -1;

    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.update());
    }

    private update() {
        const now = Date.now();
        if (now < this.nextCheckAt) {
            return;
        }
        // The server re-sends base spells each login and the engine re-applies race abilities.
        this.nextCheckAt = now + RECHECK_MS;

        const player = Game.getPlayer();
        const race = player ? player.getRace() : null;
        if (!player || !race) {
            return;
        }
        const raceId = race.getFormID();
        if (raceId !== this.lastRaceId) {
            this.lastRaceId = raceId;
            this.attempts.clear();
            this.lingering.clear();
            this.stubborn.clear();
        }
        this.strip(player, race, raceId);
    }

    // Spells granted by another playable race but not by this one
    private foreignSpells(race: Race, raceId: number): number[] {
        const cached = this.foreignByRace.get(raceId);
        if (cached) {
            return cached;
        }
        const mine = new Set<number>();
        const mineCount = race.getSpellCount();
        for (let i = 0; i < mineCount; i++) {
            const s = race.getNthSpell(i);
            if (s) {
                mine.add(s.getFormID());
            }
        }
        const foreign: number[] = [];
        const races = Race.getNumPlayableRaces();
        for (let r = 0; r < races; r++) {
            const other = Race.getNthPlayableRace(r);
            if (!other || other.getFormID() === raceId) {
                continue;
            }
            const n = other.getSpellCount();
            for (let i = 0; i < n; i++) {
                const s = other.getNthSpell(i);
                if (!s) {
                    continue;
                }
                const id = s.getFormID();
                if (!mine.has(id) && foreign.indexOf(id) === -1) {
                    foreign.push(id);
                }
            }
        }
        this.foreignByRace.set(raceId, foreign);
        logTrace(this, `race ${raceId.toString(16)} grants ${mine.size} spell(s), ${foreign.length} foreign strippable`);
        return foreign;
    }

    private strip(player: Actor, race: Race, raceId: number) {
        const unwanted = this.foreignSpells(race, raceId);
        for (const id of unwanted) {
            if (this.stubborn.has(id)) {
                continue;
            }
            const form = Game.getFormEx(id);
            const spell = form ? Spell.from(form) : null;
            if (!form || !spell) {
                continue;
            }
            if (!player.hasSpell(form)) {
                this.dispelLingering(player, spell, id);
                continue;
            }
            player.removeSpell(spell);
            // An ability keeps its active effect until a cell change unless it is dispelled.
            player.dispelSpell(spell);

            // Never judge the result in this frame. The engine updates the spell list later, so an
            // immediate hasSpell still reports true and would condemn a spell that is on its way out.
            const tries = (this.attempts.get(id) || 0) + 1;
            this.attempts.set(id, tries);
            if (tries === 1) {
                logTrace(this, `removing ${id.toString(16)} (not granted by race ${raceId.toString(16)})`);
            }
            if (tries >= GIVE_UP_AFTER) {
                this.stubborn.add(id);
                logTrace(this, `${id.toString(16)} still present after ${tries} passes; inherited from the base record, not retrying`);
            }
        }
    }

    // A race change can leave the old race's ability running with the spell already gone from the list
    private dispelLingering(player: Actor, spell: Spell, id: number) {
        const tries = this.lingering.get(id) || 0;
        if (tries >= GIVE_UP_AFTER) {
            return;
        }
        let active = false;
        for (let i = 0; i < spell.getNumEffects(); i++) {
            if (player.hasMagicEffect(spell.getNthEffectMagicEffect(i))) {
                active = true;
                break;
            }
        }
        if (!active) {
            return;
        }
        player.dispelSpell(spell);
        this.lingering.set(id, tries + 1);
        if (tries === 0) {
            logTrace(this, `dispelling lingering ${id.toString(16)} (effect active, spell not held, race change)`);
        }
    }
}
