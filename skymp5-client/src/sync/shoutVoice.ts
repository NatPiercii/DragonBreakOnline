import { Actor, ActorBase, Game, Shout, Topic, Utility, VoiceType } from "skyrimPlatform";
import { silentVoiceTypeId } from "./appearance";

// A watcher's replay of a remote shout casts the word's spell, which plays no voice: the Thu'um is dialogue the engine says
// for the shouter from the VoicePowers topics (Skyrim.esm), each line picked by GetIsVoiceType and GetEquippedShout.
// The first word has its own lines; the last two share one: Start Short "Yol!", Start Long "Yol...", End Short "Toor!",
// End Long "Toor Shul". [spell, its plugin, shout, its plugin, word count] for the 38 shouts with player voice lines,
// read from the server's load order (SHOU SNAM spells, VoicePowers INFO conditions)
const WORDS: [number, string, number, string, number][] = [
  [0xfead2, "Skyrim.esm", 0x30d2, "Dawnguard.esm", 1], // DLC1SummonDragonShout
  [0xfead2, "Skyrim.esm", 0x30d2, "Dawnguard.esm", 2], // DLC1SummonDragonShout
  [0x30d5, "Dawnguard.esm", 0x30d2, "Dawnguard.esm", 3], // DLC1SummonDragonShout
  [0x15716, "Dawnguard.esm", 0x7cb6, "Dawnguard.esm", 1], // DLC1SoulTearShout
  [0x15715, "Dawnguard.esm", 0x7cb6, "Dawnguard.esm", 2], // DLC1SoulTearShout
  [0x38bd, "Dawnguard.esm", 0x7cb6, "Dawnguard.esm", 3], // DLC1SoulTearShout
  [0x8a61, "Dawnguard.esm", 0x8a62, "Dawnguard.esm", 1], // DLC1DrainVitalityShout
  [0x8a5f, "Dawnguard.esm", 0x8a62, "Dawnguard.esm", 2], // DLC1DrainVitalityShout
  [0x8a5e, "Dawnguard.esm", 0x8a62, "Dawnguard.esm", 3], // DLC1DrainVitalityShout
  [0x13e09, "Skyrim.esm", 0x13e07, "Skyrim.esm", 1], // UnrelentingForceShout
  [0x13f39, "Skyrim.esm", 0x13e07, "Skyrim.esm", 2], // UnrelentingForceShout
  [0x13f3a, "Skyrim.esm", 0x13e07, "Skyrim.esm", 3], // UnrelentingForceShout
  [0x16cf2, "Skyrim.esm", 0x16c40, "Skyrim.esm", 1], // DragonDisarmShout
  [0x16cf2, "Skyrim.esm", 0x16c40, "Skyrim.esm", 2], // DragonDisarmShout
  [0x16cf2, "Skyrim.esm", 0x16c40, "Skyrim.esm", 3], // DragonDisarmShout
  [0x2395b, "Skyrim.esm", 0x2395a, "Skyrim.esm", 1], // Dismay
  [0x2395e, "Skyrim.esm", 0x2395a, "Skyrim.esm", 2], // Dismay
  [0x23967, "Skyrim.esm", 0x2395a, "Skyrim.esm", 3], // Dismay
  [0x2f2de, "Skyrim.esm", 0x2f2df, "Skyrim.esm", 1], // MQ105PhantomFormShout
  [0x2f2de, "Skyrim.esm", 0x2f2df, "Skyrim.esm", 2], // MQ105PhantomFormShout
  [0x2f2de, "Skyrim.esm", 0x2f2df, "Skyrim.esm", 3], // MQ105PhantomFormShout
  [0x2f7be, "Skyrim.esm", 0x2f7ba, "Skyrim.esm", 1], // WhirlwindSprintShout
  [0x2f7bf, "Skyrim.esm", 0x2f7ba, "Skyrim.esm", 2], // WhirlwindSprintShout
  [0x2f7c0, "Skyrim.esm", 0x2f7ba, "Skyrim.esm", 3], // WhirlwindSprintShout
  [0x5f6eb, "Skyrim.esm", 0x32920, "Skyrim.esm", 1], // BecomeEtherealShout
  [0x5f6ec, "Skyrim.esm", 0x32920, "Skyrim.esm", 2], // BecomeEtherealShout
  [0x5f6ed, "Skyrim.esm", 0x32920, "Skyrim.esm", 3], // BecomeEtherealShout
  [0x2c595, "Skyrim.esm", 0x32921, "Skyrim.esm", 1], // ElementalFuryShout
  [0x9cd4e, "Skyrim.esm", 0x32921, "Skyrim.esm", 2], // ElementalFuryShout
  [0x9cd4f, "Skyrim.esm", 0x32921, "Skyrim.esm", 3], // ElementalFuryShout
  [0x78ba2, "Skyrim.esm", 0x3cd34, "Skyrim.esm", 1], // ClearSkiesShout
  [0x78ba3, "Skyrim.esm", 0x3cd34, "Skyrim.esm", 2], // ClearSkiesShout
  [0x78ba4, "Skyrim.esm", 0x3cd34, "Skyrim.esm", 3], // ClearSkiesShout
  [0x3f9eb, "Skyrim.esm", 0x3f9ea, "Skyrim.esm", 1], // FireBreathShout
  [0x3f9ec, "Skyrim.esm", 0x3f9ea, "Skyrim.esm", 2], // FireBreathShout
  [0x3f9ed, "Skyrim.esm", 0x3f9ea, "Skyrim.esm", 3], // FireBreathShout
  [0x44254, "Skyrim.esm", 0x44250, "Skyrim.esm", 1], // DragonrendShout
  [0x28315, "Skyrim.esm", 0x44250, "Skyrim.esm", 2], // DragonrendShout
  [0x28345, "Skyrim.esm", 0x44250, "Skyrim.esm", 3], // DragonrendShout
  [0xfead2, "Skyrim.esm", 0x46b8c, "Skyrim.esm", 1], // CallDragonShout
  [0xfead2, "Skyrim.esm", 0x46b8c, "Skyrim.esm", 2], // CallDragonShout
  [0x46b85, "Skyrim.esm", 0x46b8c, "Skyrim.esm", 3], // CallDragonShout
  [0x48ad0, "Skyrim.esm", 0x48ac9, "Skyrim.esm", 1], // SlowTimeShout
  [0x48ad1, "Skyrim.esm", 0x48ac9, "Skyrim.esm", 2], // SlowTimeShout
  [0x48ad2, "Skyrim.esm", 0x48ac9, "Skyrim.esm", 3], // SlowTimeShout
  [0x51967, "Skyrim.esm", 0x5196a, "Skyrim.esm", 1], // CallofValorShout
  [0x51964, "Skyrim.esm", 0x5196a, "Skyrim.esm", 2], // CallofValorShout
  [0x51969, "Skyrim.esm", 0x5196a, "Skyrim.esm", 3], // CallofValorShout
  [0x549b3, "Skyrim.esm", 0x549b2, "Skyrim.esm", 1], // DragonFrostBreathShout02
  [0x549b3, "Skyrim.esm", 0x549b2, "Skyrim.esm", 2], // DragonFrostBreathShout02
  [0x549b3, "Skyrim.esm", 0x549b2, "Skyrim.esm", 3], // DragonFrostBreathShout02
  [0x5d172, "Skyrim.esm", 0x5d16b, "Skyrim.esm", 1], // FrostBreathShout
  [0x5d173, "Skyrim.esm", 0x5d16b, "Skyrim.esm", 2], // FrostBreathShout
  [0x5d174, "Skyrim.esm", 0x5d16b, "Skyrim.esm", 3], // FrostBreathShout
  [0x9e0cc, "Skyrim.esm", 0x5fc77, "Skyrim.esm", 1], // animalAllegianceShout
  [0x9e0cd, "Skyrim.esm", 0x5fc77, "Skyrim.esm", 2], // animalAllegianceShout
  [0x9e0ce, "Skyrim.esm", 0x5fc77, "Skyrim.esm", 3], // animalAllegianceShout
  [0x8afcc, "Skyrim.esm", 0x7097b, "Skyrim.esm", 1], // AuraWhisperShout
  [0x8afcd, "Skyrim.esm", 0x7097b, "Skyrim.esm", 2], // AuraWhisperShout
  [0x8afce, "Skyrim.esm", 0x7097b, "Skyrim.esm", 3], // AuraWhisperShout
  [0x1861f, "Skyrim.esm", 0x7097c, "Skyrim.esm", 1], // MarkedforDeathShout
  [0x18627, "Skyrim.esm", 0x7097c, "Skyrim.esm", 2], // MarkedforDeathShout
  [0x1862b, "Skyrim.esm", 0x7097c, "Skyrim.esm", 3], // MarkedforDeathShout
  [0x18609, "Skyrim.esm", 0x7097d, "Skyrim.esm", 1], // StormCallShout
  [0x1860a, "Skyrim.esm", 0x7097d, "Skyrim.esm", 2], // StormCallShout
  [0x1860d, "Skyrim.esm", 0x7097d, "Skyrim.esm", 3], // StormCallShout
  [0x82a34, "Skyrim.esm", 0x7097e, "Skyrim.esm", 1], // KynesPeaceShout
  [0x82a39, "Skyrim.esm", 0x7097e, "Skyrim.esm", 2], // KynesPeaceShout
  [0x82a3a, "Skyrim.esm", 0x7097e, "Skyrim.esm", 3], // KynesPeaceShout
  [0x7430f, "Skyrim.esm", 0x7097f, "Skyrim.esm", 1], // ThrowVoiceShout
  [0x7430f, "Skyrim.esm", 0x7097f, "Skyrim.esm", 2], // ThrowVoiceShout
  [0x7430f, "Skyrim.esm", 0x7097f, "Skyrim.esm", 3], // ThrowVoiceShout
  [0x9caf0, "Skyrim.esm", 0x70980, "Skyrim.esm", 1], // IceFormShout
  [0x9caf1, "Skyrim.esm", 0x70980, "Skyrim.esm", 2], // IceFormShout
  [0x9caf2, "Skyrim.esm", 0x70980, "Skyrim.esm", 3], // IceFormShout
  [0x8bb27, "Skyrim.esm", 0x70981, "Skyrim.esm", 1], // DisarmShout
  [0x8bb28, "Skyrim.esm", 0x70981, "Skyrim.esm", 2], // DisarmShout
  [0x8bb29, "Skyrim.esm", 0x70981, "Skyrim.esm", 3], // DisarmShout
  [0x2f7be, "Skyrim.esm", 0x7a4c8, "Skyrim.esm", 1], // MQ105WhirlwindSprintShout
  [0x2f7be, "Skyrim.esm", 0x7a4c8, "Skyrim.esm", 2], // MQ105WhirlwindSprintShout
  [0x2f7be, "Skyrim.esm", 0x7a4c8, "Skyrim.esm", 3], // MQ105WhirlwindSprintShout
  [0x13e09, "Skyrim.esm", 0x9de93, "Skyrim.esm", 1], // UnrelentingForceShoutDraugr
  [0x13f39, "Skyrim.esm", 0x9de93, "Skyrim.esm", 2], // UnrelentingForceShoutDraugr
  [0x13f39, "Skyrim.esm", 0x9de93, "Skyrim.esm", 3], // UnrelentingForceShoutDraugr
  [0xdd606, "Skyrim.esm", 0xdd607, "Skyrim.esm", 1], // DragonFrostIceStormShout02
  [0xdd606, "Skyrim.esm", 0xdd607, "Skyrim.esm", 2], // DragonFrostIceStormShout02
  [0xdd606, "Skyrim.esm", 0xdd607, "Skyrim.esm", 3], // DragonFrostIceStormShout02
  [0xe40ca, "Skyrim.esm", 0xe40cb, "Skyrim.esm", 1], // ImperialVoiceOfTheEmperor
  [0xf80f6, "Skyrim.esm", 0xf80f9, "Skyrim.esm", 1], // DragonFrostIceStormShout01
  [0xf80f6, "Skyrim.esm", 0xf80f9, "Skyrim.esm", 2], // DragonFrostIceStormShout01
  [0xf80f6, "Skyrim.esm", 0xf80f9, "Skyrim.esm", 3], // DragonFrostIceStormShout01
  [0xf80f4, "Skyrim.esm", 0xf80fb, "Skyrim.esm", 1], // DragonFrostBreathShout01
  [0xf80f4, "Skyrim.esm", 0xf80fb, "Skyrim.esm", 2], // DragonFrostBreathShout01
  [0xf80f4, "Skyrim.esm", 0xf80fb, "Skyrim.esm", 3], // DragonFrostBreathShout01
  [0xf80fe, "Skyrim.esm", 0xf8100, "Skyrim.esm", 1], // DragonFrostBreathShout03
  [0xf80fe, "Skyrim.esm", 0xf8100, "Skyrim.esm", 2], // DragonFrostBreathShout03
  [0xf80fe, "Skyrim.esm", 0xf8100, "Skyrim.esm", 3], // DragonFrostBreathShout03
  [0xf80ff, "Skyrim.esm", 0xf8101, "Skyrim.esm", 1], // DragonFrostIceStormShout03
  [0xf80ff, "Skyrim.esm", 0xf8101, "Skyrim.esm", 2], // DragonFrostIceStormShout03
  [0xf80ff, "Skyrim.esm", 0xf8101, "Skyrim.esm", 3], // DragonFrostIceStormShout03
  [0xf8106, "Skyrim.esm", 0xf810a, "Skyrim.esm", 1], // DragonFrostBreathShout04
  [0xf8106, "Skyrim.esm", 0xf810a, "Skyrim.esm", 2], // DragonFrostBreathShout04
  [0xf8106, "Skyrim.esm", 0xf810a, "Skyrim.esm", 3], // DragonFrostBreathShout04
  [0xf8107, "Skyrim.esm", 0xf810b, "Skyrim.esm", 1], // DragonFrostIceStormShout04
  [0xf8107, "Skyrim.esm", 0xf810b, "Skyrim.esm", 2], // DragonFrostIceStormShout04
  [0xf8107, "Skyrim.esm", 0xf810b, "Skyrim.esm", 3], // DragonFrostIceStormShout04
  [0x10c4dc, "Skyrim.esm", 0x10c4e1, "Skyrim.esm", 1], // DragonFrostBreathShout05
  [0x10c4dc, "Skyrim.esm", 0x10c4e1, "Skyrim.esm", 2], // DragonFrostBreathShout05
  [0x10c4dc, "Skyrim.esm", 0x10c4e1, "Skyrim.esm", 3], // DragonFrostBreathShout05
  [0x10c4de, "Skyrim.esm", 0x10c4e2, "Skyrim.esm", 1], // DragonFrostIceStormShout05
  [0x10c4de, "Skyrim.esm", 0x10c4e2, "Skyrim.esm", 2], // DragonFrostIceStormShout05
  [0x10c4de, "Skyrim.esm", 0x10c4e2, "Skyrim.esm", 3], // DragonFrostIceStormShout05
];

const SKYRIM = "Skyrim.esm";
const START_SHORT = 0x13e01, START_LONG = 0x13e00, END_SHORT = 0x13dff, END_LONG = 0x13dfe;
// The end words follow the first after about the time a shout is held for them
const END_DELAY_S = 0.6;
// A copy keeps its race's voice this long after its last shout began, then goes silent again
const VOICE_HOLD_S = 5;
const voiceTokens = new Map<number, number>();

// A copy is built with the silent voice type (applyAppearance); the lines need a voice in VoicePowerVoicesList, which every
// playable race's default voice type is in. It is lent for the shout and taken back after
const lendRaceVoice = (actor: Actor): void => {
  const base = ActorBase.from(actor.getBaseObject());
  // Only a player's copy, whose own base carries the silent voice: an NPC copy shares its base with every NPC of its kind
  const current = base ? base.getVoiceType() : null;
  if (!current || (current.getFormID() >>> 0) !== silentVoiceTypeId) return;
  const race = actor.getRace();
  const voice = race && base ? race.getDefaultVoiceType(base.getSex() === 1) : null;
  if (!base || !voice) return;
  base.setVoiceType(voice);
  const actorId = actor.getFormID();
  const token = (voiceTokens.get(actorId) || 0) + 1;
  voiceTokens.set(actorId, token);
  Utility.wait(VOICE_HOLD_S).then(() => {
    if (voiceTokens.get(actorId) !== token) return;
    voiceTokens.delete(actorId);
    const a = Actor.from(Game.getFormEx(actorId));
    const b = a ? ActorBase.from(a.getBaseObject()) : null;
    if (b) b.setVoiceType(VoiceType.from(Game.getFormEx(silentVoiceTypeId)));
  });
};

let bySpell: Map<number, { shout: number; words: number }> | null = null;

// Ids only are kept: a native object expires at the end of the frame
const wordsBySpell = (): Map<number, { shout: number; words: number }> => {
  if (bySpell) return bySpell;
  bySpell = new Map();
  for (const [spell, spellFile, shout, shoutFile, words] of WORDS) {
    const s = Game.getFormFromFile(spell, spellFile);
    const sh = Game.getFormFromFile(shout, shoutFile);
    if (s && sh && !bySpell.has(s.getFormID() >>> 0)) bySpell.set(s.getFormID() >>> 0, { shout: sh.getFormID() >>> 0, words });
  }
  return bySpell;
};

const say = (actorId: number, topicLocalId: number): void => {
  const actor = Actor.from(Game.getFormEx(actorId));
  const topic = Topic.from(Game.getFormFromFile(topicLocalId, SKYRIM));
  if (actor && topic && actor.is3DLoaded()) actor.say(topic, null, false);
};

// The shout's voice on a remote caster's copy; false when the spell is no word of a voiced shout
export const sayShout = (actor: Actor, spellId: number): boolean => {
  const entry = wordsBySpell().get(spellId >>> 0);
  const shout = entry ? Shout.from(Game.getFormEx(entry.shout)) : null;
  if (!entry || !shout) return false;
  const actorId = actor.getFormID();
  // The lines are conditioned on the speaker's voice type and equipped shout
  lendRaceVoice(actor);
  actor.equipShout(shout);
  say(actorId, entry.words === 1 ? START_SHORT : START_LONG);
  if (entry.words > 1) {
    Utility.wait(END_DELAY_S).then(() => say(actorId, entry.words === 2 ? END_SHORT : END_LONG));
  }
  return true;
};
