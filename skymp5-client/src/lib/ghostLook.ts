// Skyrim.esm GhostEtherealFXShader, the Become Ethereal look
export const GHOST_SHADER_ID = 0x64d67;
export const GHOST_ALPHA = 0.5;

// Nate, 9 Oct: NPCs must neither see nor hear an Invisible admin (alpha 0 hides only the model). Skyrim.esm abilities
// TG05KarliahInvisibilitySpell (constant Invisibility) and DA02MuffledMovement (constant Muffle), on the admin's own
// player (AdminModeService) and on an admin watcher's ghost copy of them (FormView).
export const INVIS_ABILITY_IDS = [0x000d61e3, 0x000f23c6];
