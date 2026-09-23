import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ActiveEffectApplyRemoveEvent, Actor, Armor, ButtonEvent, DxScanCode, GlobalVariable, InputDeviceType, Perk, Race, Shout, Spell, SpellCastEvent, WordOfPower } from "skyrimPlatform";
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

interface BeastLoadout { perks: number[] }

// Server -> Client in dboBeast: what the form casts, learned server-side by server\beastform.js (ABILITIES).
// Vanilla blocks the Inventory and Magic menus in both beast forms, so the game equips for the player:
// right hand fixed, keys 1.. pick the left-hand spell, the keys after them the power on the voice key.
// shout/word: a werewolf howl, which vanilla gives as a shout; the voice slot does not cast the bare spell
interface BeastSpell { id: number; name: string; shout?: number; word?: number }
interface BeastAbilities { right: BeastSpell[]; left: BeastSpell[]; voice: BeastSpell[]; passive: BeastSpell[] }

// The Vampire Lord has two stances and vanilla drives them from DLC1PlayerVampireChangeScript:
// an animation event to the behaviour graph, and a global the rest of the game reads.
// The script's own description of that global: "0 = Not a Vampire Lord, 1 = Walking, 2 = Levitating".
// Without it the player hovers with no melee at all, which is what "no melee" was.
const VL_STATE_GLOBAL = 0x02015fc8; // DLC1VampireLevitateStateGlobal
const VL_STATE_NONE = 0;
const VL_STATE_WALKING = 1;
const VL_STATE_LEVITATING = 2;
const ANIM_LAND = "LandStart";
const ANIM_LEVITATE = "LevitateStart";
const SLOT_LEFT = 0;
const SLOT_RIGHT = 1;
const SLOT_VOICE = 2;


const BEAST_LOADOUT: Record<number, BeastLoadout> = {
  [VAMPIRE_RACE]: {
    // DLC1VampiricBite, UnearthlyWill, PoisonTalons, NightCloak, PowerOfTheGrave, VampiricGrip,
    // DetectLife, MistForm, SupernaturalReflexes, CorpseCurse
    perks: [0x02005994, 0x02005995, 0x02005996, 0x02005997, 0x02005998,
            0x0200599a, 0x0200599b, 0x0200599c, 0x0200599e, 0x02008a70],
  },
  [WEREWOLF_RACE]: {
    // BestialStrength 25/50/75/100, AnimalVigor, SavageFeeding, Gorging, the four Totems,
    // DLC1PlayerWerewolfSavageFeeding and Skyrim's PlayerWerewolfFeed
    perks: [0x020059a4, 0x02007a3f, 0x02011cfa, 0x02011cfb, 0x020059a5, 0x020059a6, 0x020059a7,
            0x020059a8, 0x020059a9, 0x020059aa, 0x020059ab, 0x02008a6e, 0x0002ba1d],
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
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
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
        // Vanilla brackets the change with Game.SetBeastForm(True/False) (PlayerWerewolfChangeScript,
        // DLC1PlayerVampireChangeScript), and that flag is what shuts the menus. Those scripts never run here,
        // so the menus stayed shut after a revert until a relaunch (Argosh, 2026-09-23).
        try { this.sp.Game.setBeastForm(beast); } catch (e) { logError(this, "setBeastForm failed", e); }
        this.abilities = beast ? parseAbilities(content["abilities"]) : null;
        this.leftIndex = 0;
        this.voiceIndex = 0;
        this.applyLoadout(player, raceId, beast);
        // The server puts the form's outfit in the inventory and lists it here (beastform.js WEAR);
        const wear = Array.isArray(content["wear"]) ? (content["wear"] as unknown[]).map((x) => Number(x) >>> 0) : [];
        for (const id of beast ? wear : []) {
          const armor = Armor.from(this.sp.Game.getFormEx(id));
          if (!armor) { logError(this, "beast outfit not in the load order", id.toString(16)); continue; }
          try { player.equipItem(armor, true, true); } catch (e) { logError(this, "beast outfit equip failed", e); }
        }
        // Vanilla keeps a beast in third person; the player could flip back and see a broken camera
        this.beastRace = beast ? raceId : 0;
        if (beast) this.sp.Game.forceThirdPerson();
        // Server calls for the change (AddSpell) can land after this frame; equip again once they have
        this.reapplyAt = beast ? [Date.now() + 1000, Date.now() + 3000] : [];
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
    const granted = beast ? this.abilities : this.lastAbilities;
    for (const sp of granted ? [...granted.right, ...granted.left, ...granted.voice, ...granted.passive] : []) {
      const spell = Spell.from(this.sp.Game.getFormEx(sp.id));
      if (!spell) { logError(this, "beast spell not in the load order", sp.id.toString(16)); continue; }
      try { if (beast) player.addSpell(spell, false); else player.removeSpell(spell); spells++; } catch { /* already held */ }
      const shout = sp.shout ? Shout.from(this.sp.Game.getFormEx(sp.shout)) : null;
      if (shout) { try { if (beast) player.addShout(shout); else player.removeShout(shout); } catch { /* already held */ } }
    }
    this.lastAbilities = beast ? this.abilities : null;
    if (raceId === VAMPIRE_RACE) {
      // Vanilla starts the Vampire Lord hovering; sneak drops it into melee
      this.setVampireStance(beast ? VL_STATE_LEVITATING : VL_STATE_NONE);
    }
    if (beast) this.applyHands();
    logTrace(this, beast ? "Beast loadout granted" : "Beast loadout removed", `${perks} perk(s), ${spells} spell(s)`);
  }

  // Equips the fixed right-hand spell, the chosen left-hand spell and the chosen power. On the ground the Vampire Lord
  // fights with his claws, so vanilla empties his hands there (DLC1PlayerVampireChangeScript GroundStart)
  private applyHands(): void {
    const a = this.abilities;
    const player = this.sp.Game.getPlayer();
    if (!a || !player) return;
    const grounded = this.beastRace === VAMPIRE_RACE && this.vampireStance === VL_STATE_WALKING;
    const slot = (list: BeastSpell[], index: number, source: number) => {
      const entry = list.length && !(grounded && source !== SLOT_VOICE) ? list[index % list.length] : null;
      if (entry && entry.shout) { this.equipShout(player, entry); return; }
      const current = player.getEquippedSpell(source);
      const want = entry ? Spell.from(this.sp.Game.getFormEx(entry.id)) : null;
      // Only on a difference: this also runs once a second, and re-equipping would cut off a cast
      if (want && current && current.getFormID() === want.getFormID()) return;
      try {
        if (want) player.equipSpell(want, source);
        else if (current) player.unequipSpell(current, source);
      } catch { /* the form may already be gone */ }
    };
    slot(a.right, 0, SLOT_RIGHT);
    slot(a.left, this.leftIndex, SLOT_LEFT);
    slot(a.voice, this.voiceIndex, SLOT_VOICE);
  }

  private equipShout(player: Actor, entry: BeastSpell): void {
    const shout = Shout.from(this.sp.Game.getFormEx(entry.shout || 0));
    if (!shout) { logError(this, "howl not in the load order", (entry.shout || 0).toString(16)); return; }
    const current = player.getEquippedShout();
    if (current && current.getFormID() === shout.getFormID()) return;
    try {
      const word = WordOfPower.from(this.sp.Game.getFormEx(entry.word || 0));
      if (word) { this.sp.Game.teachWord(word); this.sp.Game.unlockWord(word); }
      player.addShout(shout);
      player.equipShout(shout);
    } catch (e) { logError(this, "howl equip failed", e); }
  }

  // Keys 1-9: first the left-hand spells, then the powers, in the order the server's legend lists them
  private onAbilityKey(code: number): boolean {
    const a = this.abilities;
    if (!a || code < DxScanCode.N1 || code > DxScanCode.N9) return false;
    const n = code - DxScanCode.N1;
    let chosen: BeastSpell | undefined;
    if (n < a.left.length) { this.leftIndex = n; chosen = a.left[n]; }
    else if (n - a.left.length < a.voice.length) { this.voiceIndex = n - a.left.length; chosen = a.voice[this.voiceIndex]; }
    if (!chosen) return false;
    this.applyHands();
    const where = n < a.left.length ? "Left hand" : "Power (Shout key)";
    try { this.sp.Debug.notification(`${where}: ${chosen.name}`); } catch { /* no hud */ }
    return true;
  }

  private abilities: BeastAbilities | null = null;
  private lastAbilities: BeastAbilities | null = null;
  private leftIndex = 0;
  private voiceIndex = 0;

  // The camera is forced once on the change; this keeps it there for as long as the form lasts
  private onCameraCheck(): void {
    if (!this.beastRace) return;
    if (this.reapplyAt.length && Date.now() >= this.reapplyAt[0]) { this.reapplyAt.shift(); this.applyHands(); }
    // Something in the engine empties the Vampire Lord's hands a few seconds into the form (Argosh, 20:38); put back
    // what was chosen once a second. applyHands only equips on a difference.
    if (Date.now() >= this.nextHandsCheck) { this.nextHandsCheck = Date.now() + 1000; this.applyHands(); }
    try {
      if (this.sp.Game.getCameraState() === FIRST_PERSON_CAMERA) this.sp.Game.forceThirdPerson();
    } catch { /* no camera yet */ }
  }

  private beastRace = 0;
  private reapplyAt: number[] = [];
  private nextHandsCheck = 0;

  // Sneak toggles the stance, the same key vanilla uses, read from the player's own bindings
  private onButtonEvent(e: ButtonEvent): void {
    if (!this.beastRace || !e.isDown || e.device !== InputDeviceType.Keyboard) return;
    if (this.onAbilityKey(e.code)) return;
    if (e.code === this.shoutKey()) { this.reportPower(); return; }
    if (this.beastRace !== VAMPIRE_RACE || e.code !== this.sneakKey()) return;
    this.setVampireStance(this.vampireStance === VL_STATE_LEVITATING ? VL_STATE_WALKING : VL_STATE_LEVITATING);
  }

  // The server gives a power its effect on other players (Howl of Terror, Mist Form, Bats); it keeps the cooldowns
  private reportPower(): void {
    const a = this.abilities;
    if (!a || !a.voice.length || Date.now() - this.lastPowerAt < 1000) return;
    this.lastPowerAt = Date.now();
    const entry = a.voice[this.voiceIndex % a.voice.length];
    sendCustomPacket(this.controller, { customPacketType: "dboBeastPower", spell: entry.id });
  }

  private shoutKey(): number {
    if (this.cachedShoutKey !== 0) return this.cachedShoutKey;
    try { this.cachedShoutKey = this.sp.Input.getMappedKey("Shout", 0) || DxScanCode.Z; }
    catch { this.cachedShoutKey = DxScanCode.Z; }
    return this.cachedShoutKey;
  }

  private lastPowerAt = 0;
  private cachedShoutKey = 0;

  private sneakKey(): number {
    if (this.cachedSneakKey !== 0) return this.cachedSneakKey;
    try { this.cachedSneakKey = this.sp.Input.getMappedKey("Sneak", 0) || DxScanCode.LeftControl; }
    catch { this.cachedSneakKey = DxScanCode.LeftControl; }
    return this.cachedSneakKey;
  }

  private setVampireStance(state: number): void {
    this.vampireStance = state;
    try {
      const g = GlobalVariable.from(this.sp.Game.getFormEx(VL_STATE_GLOBAL));
      if (g) g.setValue(state);
    } catch { /* not in this load order */ }
    if (state === VL_STATE_NONE) return;
    try {
      const player = this.sp.Game.getPlayer();
      if (player) this.sp.Debug.sendAnimationEvent(player, state === VL_STATE_LEVITATING ? ANIM_LEVITATE : ANIM_LAND);
    } catch { /* no player */ }
    this.applyHands();
    logTrace(this, "Vampire Lord stance", state === VL_STATE_LEVITATING ? "levitating" : "walking");
  }

  private vampireStance = VL_STATE_NONE;
  private cachedSneakKey = 0;
}

const parseAbilities = (raw: unknown): BeastAbilities | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = (x: unknown): BeastSpell[] => Array.isArray(x)
    ? x.map((e) => {
      const r = e as Record<string, unknown>;
      const out: BeastSpell = { id: Number(r["id"]) >>> 0, name: String(r["name"] || "") };
      if (r["shout"]) { out.shout = Number(r["shout"]) >>> 0; out.word = Number(r["word"]) >>> 0; }
      return out;
    }).filter((e) => e.id)
    : [];
  return { right: list(r["right"]), left: list(r["left"]), voice: list(r["voice"]), passive: list(r["passive"]) };
};
