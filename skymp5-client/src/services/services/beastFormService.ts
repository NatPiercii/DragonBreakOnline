import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ActiveEffectApplyRemoveEvent, Actor, Perk, Race, Spell, SpellCastEvent } from "skyrimPlatform";
import { sendCustomPacket } from "./customPacketUtil";
import { logError, logTrace } from "../../logging";

// WerewolfChange 92c48, DLC1VampireChange 0200283b, DLC1RevertForm 0200cd5c (load order: Dawnguard is index 02)
const BEAST_POWERS = new Set([0x00092c48, 0x0200283b, 0x0200cd5c]);

// spellCast never fired for these: they are Powers and Lesser Powers cast from the voice slot, and the whole
// server log held zero beast requests while ordinary spells relayed fine. The magic effect is applied either
// way, so the effect is what we watch. Ids read out of the load order, not recalled.
const BEAST_EFFECT_TO_POWER = new Map<number, number>([
  [0x00092c45, 0x00092c48], // WerewolfChangeEffect -> WerewolfChange
  [0x0200283c, 0x0200283b], // DLC1VampireChangeEffect -> DLC1VampireChange
  [0x0200cd5b, 0x0200cd5c], // DLC1RevertEffect -> DLC1RevertForm
]);

// spellCast and effectStart can both land for one cast; the server only needs to hear once
const REQUEST_DEBOUNCE_MS = 1500;

// What the beast actually gets. The vanilla transform is a Papyrus script on the change spell's magic effect,
// and those script events never reach this client, so a race swap alone leaves the player with fists: no spells,
// no perks. The server cannot do it either, its Papyrus VM has no AddPerk. So it is done here.
// Every id below was read out of the load order (Dawnguard is index 02, Skyrim 00), not from memory.
// Nat's rule: every perk in both trees is granted, so the top-tier spells are the right ones to hand over.
const FIRST_PERSON_CAMERA = 0;
const VAMPIRE_RACE = 0x0200283a;
const WEREWOLF_RACE = 0x000cdd84;

interface BeastLoadout { perks: number[]; spells: number[] }

// Vanilla blocks the Inventory and Magic menus in both beast forms, so nothing the player is merely
// *given* can ever be reached: the game equips for you. That is why the howls and the Vampire Lord's
// spells did nothing. Papyrus slots: 0 left hand, 1 right hand, 2 voice.
interface BeastEquip { left?: number; right?: number; voice?: number }

const BEAST_EQUIP: Record<number, BeastEquip> = {
  // Vampiric Drain in the right, Raise Dead in the left, Revert Form on the voice key
  [VAMPIRE_RACE]: { right: 0x02019ad7, left: 0x02013ecb, voice: 0x0200cd5c },
  // One howl can be held at a time and the menu is shut, so Terror is the one put on the voice key
  [WEREWOLF_RACE]: { voice: 0x000cf793 },
};
const SLOT_LEFT = 0;
const SLOT_RIGHT = 1;
const SLOT_VOICE = 2;


const BEAST_LOADOUT: Record<number, BeastLoadout> = {
  [VAMPIRE_RACE]: {
    // DLC1VampiricBite, UnearthlyWill, PoisonTalons, NightCloak, PowerOfTheGrave, VampiricGrip,
    // DetectLife, MistForm, SupernaturalReflexes, CorpseCurse
    perks: [0x02005994, 0x02005995, 0x02005996, 0x02005997, 0x02005998,
            0x0200599a, 0x0200599b, 0x0200599c, 0x0200599e, 0x02008a70],
    // Drain09Alt (right hand), RaiseDeadLeftHand05, CorpseCurseLeftHand, ConjureGargoyleLeftHand,
    // Bats, Mistform, SupernaturalReflexes, DetectLife, abNightCloak
    spells: [0x02019ad7, 0x02013ecb, 0x02008a6f, 0x02016909,
             0x020038b9, 0x020038ba, 0x020038bc, 0x020038b8, 0x020126b8],
  },
  [WEREWOLF_RACE]: {
    // BestialStrength 25/50/75/100, AnimalVigor, SavageFeeding, Gorging, the four Totems,
    // DLC1PlayerWerewolfSavageFeeding and Skyrim's PlayerWerewolfFeed
    perks: [0x020059a4, 0x02007a3f, 0x02011cfa, 0x02011cfb, 0x020059a5, 0x020059a6, 0x020059a7,
            0x020059a8, 0x020059a9, 0x020059aa, 0x020059ab, 0x02008a6e, 0x0002ba1d],
    // The howls, top tier because every perk is granted: Fear, Detect Life, Summon Wolves
    spells: [0x000cf793, 0x000cf78c, 0x000cf7a1],
  },
};

// Server -> Client: { customPacketType: "dboBeast", race: <race form id>, beast: boolean }
// The server owns the transform (server\beastform.js): it swaps appearance.raceId, which other clients rebuild from,
// and asks this client to swap the player's own race, which appearance sync alone never does (setNpcRace keeps the skeleton).
export class BeastFormService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onBeastMessage(e));
    this.controller.on("spellCast", (e) => this.onSpellCast(e));
    this.controller.on("effectStart", (e) => this.onEffectStart(e));
    this.controller.on("update", () => this.onCameraCheck());
  }

  // Beast Form, Vampire Lord and Revert Form are powers whose effects are engine-native transformation archetypes
  // (36 and 46): cast locally they start the engine's own change, which locks the controls and never finishes here.
  // The effect is dispelled at once, the controls come back, and the server runs the change (server\beastform.js).
  private onSpellCast(e: SpellCastEvent): void {
    if (!e.caster || e.caster.getFormID() !== 0x14 || !e.spell) return;
    const id = e.spell.getFormID();
    if (!BEAST_POWERS.has(id)) return;
    this.requestBeast(id);
  }

  // The reliable path: a Power fires no spellCast, but its effect always starts
  private onEffectStart(e: ActiveEffectApplyRemoveEvent): void {
    if (!e.target || e.target.getFormID() !== 0x14 || !e.effect) return;
    const power = BEAST_EFFECT_TO_POWER.get(e.effect.getFormID());
    if (power === undefined) return;
    this.requestBeast(power);
  }

  private requestBeast(id: number): void {
    const now = Date.now();
    if (now - (this.lastRequestAt.get(id) ?? 0) < REQUEST_DEBOUNCE_MS) return;
    this.lastRequestAt.set(id, now);
    this.controller.once("update", () => {
      const player = this.sp.Game.getPlayer();
      const spell = Spell.from(this.sp.Game.getFormEx(id));
      if (player && spell) { try { player.dispelSpell(spell); } catch { /* not active */ } }
      this.restoreControls();
    });
    logTrace(this, "Beast power used, asking the server", id.toString(16));
    sendCustomPacket(this.controller, { customPacketType: "dboBeastRequest", spell: id });
  }

  private lastRequestAt = new Map<number, number>();

  private restoreControls(): void {
    try { this.sp.Game.enablePlayerControls(true, true, true, true, true, true, true, true, 0); } catch { /* menu */ }
  }

  private onBeastMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboBeast") return;
    const raceId = Number(content["race"]) >>> 0;
    const beast = content["beast"] === true;
    // remoteServer skips the own-appearance echo for a beast race, so the base record keeps the real race and head
    const races = ((globalThis as any).__dboBeastRaces = (globalThis as any).__dboBeastRaces || new Set<number>());
    if (beast) races.add(raceId);
    this.controller.once("update", () => {
      try {
        const player = this.sp.Game.getPlayer();
        const race = Race.from(this.sp.Game.getFormEx(raceId));
        if (!player || !race) { logError(this, "race not found", raceId.toString(16)); return; }
        if (beast) player.unequipAll();
        player.setRace(race);
        this.applyLoadout(player, raceId, beast);
        // Vanilla keeps a beast in third person; the player could flip back and see a broken camera
        this.beastRace = beast ? raceId : 0;
        if (beast) this.sp.Game.forceThirdPerson();
        this.restoreControls();
        logTrace(this, beast ? "Took beast form" : "Returned to own race", raceId.toString(16));
      } catch (e) {
        logError(this, "setRace failed", e);
      }
    });
  }

  // Grants on the way in, takes back on the way out, so a beast power never lingers on the real race.
  private applyLoadout(player: Actor, raceId: number, beast: boolean): void {
    const loadout = BEAST_LOADOUT[raceId];
    if (!loadout) return;
    let perks = 0;
    let spells = 0;
    for (const id of loadout.perks) {
      const perk = Perk.from(this.sp.Game.getFormEx(id));
      if (!perk) { logError(this, "beast perk not in the load order", id.toString(16)); continue; }
      try { if (beast) player.addPerk(perk); else player.removePerk(perk); perks++; } catch { /* already held */ }
    }
    for (const id of loadout.spells) {
      const spell = Spell.from(this.sp.Game.getFormEx(id));
      if (!spell) { logError(this, "beast spell not in the load order", id.toString(16)); continue; }
      try { if (beast) player.addSpell(spell, false); else player.removeSpell(spell); spells++; } catch { /* already held */ }
    }
    this.applyEquip(player, raceId, beast);
    logTrace(this, beast ? "Beast loadout granted" : "Beast loadout removed", `${perks} perk(s), ${spells} spell(s)`);
  }

  // Without this the player is holding nothing and cannot open a menu to fix it
  private applyEquip(player: Actor, raceId: number, beast: boolean): void {
    const equip = BEAST_EQUIP[raceId];
    if (!equip) return;
    const slots: Array<[number | undefined, number]> = [
      [equip.left, SLOT_LEFT], [equip.right, SLOT_RIGHT], [equip.voice, SLOT_VOICE],
    ];
    for (const [id, slot] of slots) {
      if (id === undefined) continue;
      const spell = Spell.from(this.sp.Game.getFormEx(id));
      if (!spell) { logError(this, "beast equip spell not in the load order", id.toString(16)); continue; }
      try {
        if (beast) player.equipSpell(spell, slot);
        else player.unequipSpell(spell, slot);
      } catch { /* the form may already be gone */ }
    }
  }

  // The camera is forced once on the change; this keeps it there for as long as the form lasts
  private onCameraCheck(): void {
    if (!this.beastRace) return;
    try {
      if (this.sp.Game.getCameraState() === FIRST_PERSON_CAMERA) this.sp.Game.forceThirdPerson();
    } catch { /* no camera yet */ }
  }

  private beastRace = 0;
}
