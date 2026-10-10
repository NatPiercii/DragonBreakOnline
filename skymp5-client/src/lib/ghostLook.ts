// Skyrim.esm GhostEtherealFXShader, the Become Ethereal look
export const GHOST_SHADER_ID = 0x64d67;
export const GHOST_ALPHA = 0.5;

// Nate, 9 Oct: NPCs must neither see nor hear an Invisible admin (alpha 0 hides only the model). Skyrim.esm abilities
// TG05KarliahInvisibilitySpell (constant Invisibility) and DA02MuffledMovement (constant Muffle), on the admin's own
// player (AdminModeService) and on an admin watcher's ghost copy of them (FormView).
export const INVIS_ABILITY_IDS = [0x000d61e3, 0x000f23c6];

// The two abilities' own hit shaders (Skyrim.esm EFSH InvisFXShader, the Invisibility potion's shimmer, and
// DA02ArmorShadow, Boethiah's smoke): stopped wherever the abilities are on, so an Invisible admin has no shimmer
// (Nate, 11 Oct: "more of a potion effect, so there's a shimmer"); the abilities themselves stay for NPC detection
export const INVIS_ABILITY_SHADER_IDS = [0x0002df92, 0x00081180];
