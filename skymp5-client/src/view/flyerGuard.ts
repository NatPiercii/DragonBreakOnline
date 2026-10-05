// Copies of dragons (the races on Actors\Dragon\DragonProject.hkx): a trail of every engine call on one, and switches the
// server can turn on per actor to try candidate fixes without a client rebuild. Pure: no skyrimPlatform import.
//
// 4 Oct 2026: four dragons near Bruma closed about 20 players' games 43 times with 0xC0000409, which CrashLogger never sees.
// The trail in dbo-diag-logs.txt (writeLogs flushes every line) ended on "spawn <id> base=fea9b" in 15 of 21 reports, and
// the clients that hosted a dragon for minutes kept running while those that only watched one went down within a minute.
// Which call takes the game down is not measured yet; the flyer lines below are written before each call, so the last
// line in a report names it.
//
// ff_flyerGuard (a neighbour-visible number the gameplay sets on a dragon for a staff test, crashycreatures.js testGuard):
//   1 FLYER_NO_ANIMS      a copy we do not host plays no relayed animation event
//   2 FLYER_NO_AI         a copy we do not host has its AI off (on again once we host it)
//   4 FLYER_NO_OFFSET     a copy we do not host is moved by translation only (no KeepOffsetFromActor, no head tracking)
//   8 FLYER_NO_RESURRECT  the spawn enables the copy without the Resurrect step
// Without the property a dragon is handled as before, so this build changes nothing until a test turns a switch on.

export const FLYER_NO_ANIMS = 1;
export const FLYER_NO_AI = 2;
export const FLYER_NO_OFFSET = 4;
export const FLYER_NO_RESURRECT = 8;
const ALL = FLYER_NO_ANIMS | FLYER_NO_AI | FLYER_NO_OFFSET | FLYER_NO_RESURRECT;

// The races on DragonProject.hkx: [plugin, local id, editor id] (server repo tools/races scan, 4 Oct; crashycreatures.js)
export const DRAGON_RACES: ReadonlyArray<readonly [string, number, string]> = [
  ["Skyrim.esm", 0x012e82, "DragonRace"],
  ["Skyrim.esm", 0x0e7713, "AlduinRace"],
  ["Skyrim.esm", 0x1052a3, "UndeadDragonRace"],
  ["Dawnguard.esm", 0x0117de, "DLC1UndeadDragonRace"],
  ["Dragonborn.esm", 0x02c88b, "DragonBlackRace"],
  ["Dragonborn.esm", 0x02c88c, "DLC2DragonBlackRace"],
];

// The switches a model asks for; anything unusable is none
export const flyerGuardOf = (model: unknown): number => {
  const v = Number((model as Record<string, unknown> | null | undefined)?.["ff_flyerGuard"]);
  return Number.isFinite(v) && v > 0 ? (v & ALL) : 0;
};

export const guardOn = (bits: number, bit: number): boolean => (bits & bit) !== 0;

// What a copy we do not host may get this frame. hosted: we drive it (our AI owns it, nothing is played back anyway)
export const flyerPlan = (bits: number, hosted: boolean): { anims: boolean; ai: boolean; offset: boolean } => ({
  anims: hosted || !guardOn(bits, FLYER_NO_ANIMS),
  ai: hosted || !guardOn(bits, FLYER_NO_AI),
  offset: hosted || !guardOn(bits, FLYER_NO_OFFSET),
});

// Which flyer lines are written. Lifecycle lines (place, spawn steps, ready, kill, host, ai, anim) always, within the
// budget; movement only in the copy's first windowMs and at most once per moveEveryMs, so a long flight does not fill the
// session's lines. Its own budget, so the shared NPC trail keeps its lines.
export class FlyerTrail {
  private second = 0;
  private inSecond = 0;
  private total = 0;
  private lastMove = new Map<number, number>();
  dropped = 0;

  constructor(private windowMs = 20000, private moveEveryMs = 250, private perSecond = 40, private perSession = 4000) {}

  take(kind: string, refrId: number, now: number, bornAt: number): boolean {
    if (kind === "move") {
      if (bornAt > 0 && now - bornAt > this.windowMs) return false;
      const last = this.lastMove.get(refrId) || 0;
      if (now - last < this.moveEveryMs) return false;
      this.lastMove.set(refrId, now);
    }
    const s = Math.floor(now / 1000);
    if (s !== this.second) { this.second = s; this.inSecond = 0; }
    if (this.inSecond >= this.perSecond || this.total >= this.perSession) { this.dropped++; return false; }
    this.inSecond++;
    this.total++;
    return true;
  }

  forget(refrId: number): void {
    this.lastMove.delete(refrId);
  }
}

const hex = (n: number): string => (n >>> 0).toString(16);

export const flyerLine = (now: number, kind: string, refrId: number, remoteId: number, extra?: string): string =>
  `flyer ${new Date(now).toISOString().slice(11, 23)} ${kind} ${hex(refrId)} remote=${hex(remoteId)}${extra ? " " + extra : ""}`;
