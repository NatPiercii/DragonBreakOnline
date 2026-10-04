// The magicka an NPC copy keeps. Pure, so a harness can run it.
//
// Every copy is placed with 1,000,000 health and magicka (formView localImmortal): the server owns its vitals, and a
// watcher's copy must never fail a relayed cast. A copy this client hosts runs its own AI, though, and that AI cast from
// the 1,000,000 too: hosted casters never ran dry (X-npcstam, 4 Oct). So a hosted NPC copy gets the base magicka it had
// before the write, and the 1,000,000 again when hosting ends. Player copies are left as they are.
export const COPY_MAGICKA = 1000000;

// The base magicka read before the 1,000,000 write, or undefined when it cannot be used (unreadable, 0 or already raised)
export const realBaseMagicka = (read: number): number | undefined =>
  Number.isFinite(read) && read > 0 && read < COPY_MAGICKA ? read : undefined;

// What the copy's base magicka should be now
export const copyMagicka = (realBase: number | undefined, hostedByMe: boolean): number =>
  hostedByMe && realBase !== undefined ? realBase : COPY_MAGICKA;
