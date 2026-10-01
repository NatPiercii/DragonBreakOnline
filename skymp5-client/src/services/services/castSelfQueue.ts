// The server's cast and dispel requests (castSelfService.ts), run strictly in the order they came. Kept free of imports
// so a harness can drive it (tests/cast-self-queue-harness.js on the server branch).
//
//   Server -> Client: { customPacketType: "dboCastSelf", spell: <form id>, text?: string }
//                     { customPacketType: "dboDispelSelf", spell: <form id> }
//
// Why a queue: SkyrimPlatform keeps an event's callbacks in an unordered map (EventManager.h, CallbackObjMap), so two
// once("update") handlers waiting for the same frame run in no set order. A blessing given again sends a dispel and then
// a cast of the same spell; run the other way round, the dispel could end the fresh effect.
// Why it waits on a cast: Spell.Cast is latent (it returns a Promise) and DispelSpell is not, so a dispel run straight
// after a cast could come before the cast has landed and leave the effect on. A cast holds the queue until it settles.

export type CastSelfKind = "cast" | "dispel";
export interface CastSelfRequest { kind: CastSelfKind; spell: number; text: string }

/** The request in a custom packet, or null when it is not one (another type, no spell) */
export function readCastSelfRequest(content: Record<string, unknown> | null | undefined): CastSelfRequest | null {
  if (!content) return null;
  const type = content["customPacketType"];
  const kind: CastSelfKind | null = type === "dboCastSelf" ? "cast" : type === "dboDispelSelf" ? "dispel" : null;
  if (!kind) return null;
  const spell = Number(content["spell"]) >>> 0;
  if (!spell) return null;
  const text = kind === "cast" && typeof content["text"] === "string" ? (content["text"] as string) : "";
  return { kind, spell, text };
}

// A cast that never settles (none has been seen to) holds the queue this long at most
export const CAST_HOLD_MS = 5000;

export class CastSelfQueue {
  private items: CastSelfRequest[] = [];
  private scheduled = false;
  private waitingSince = 0; // when the cast holding the queue was made; 0 when none is
  private hold = 0; // which cast holds it, so one let go by the limit cannot free a later one

  /**
   * @param schedule runs the drain on the next update (controller.once("update", ...)); one drain is pending at a time
   * @param run carries out one request; a Promise (a cast) holds the rest until it settles
   * @param onError told when run throws or its Promise rejects, or a cast outlasts CAST_HOLD_MS; the queue goes on
   * @param now the clock (Date.now)
   */
  constructor(
    private schedule: (drain: () => void) => void,
    private run: (request: CastSelfRequest) => Promise<unknown> | void,
    private onError: (request: CastSelfRequest | null, e: unknown) => void = () => undefined,
    private now: () => number = Date.now,
  ) {}

  push(request: CastSelfRequest): void {
    this.items.push(request);
    this.wake();
  }

  get pending(): number {
    return this.items.length;
  }

  private wake(): void {
    if (this.scheduled || !this.items.length) return;
    this.scheduled = true;
    this.schedule(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    if (this.waitingSince) {
      if (this.now() - this.waitingSince < CAST_HOLD_MS) { this.wake(); return; }
      this.waitingSince = 0;
      this.onError(null, new Error(`a cast did not settle within ${CAST_HOLD_MS} ms`));
    }
    while (this.items.length && !this.waitingSince) {
      const request = this.items.shift() as CastSelfRequest;
      let result: Promise<unknown> | void;
      try {
        result = this.run(request);
      } catch (e) {
        this.onError(request, e);
        continue;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        const hold = ++this.hold;
        this.waitingSince = this.now() || 1;
        // The rest runs on the update after the cast lands, not inside the Promise callback
        const release = () => { if (hold !== this.hold || !this.waitingSince) return; this.waitingSince = 0; this.wake(); };
        (result as Promise<unknown>).then(release, (e) => { this.onError(request, e); release(); });
      }
    }
    // Held by a cast with more to come: look again next update, so the limit is seen even if the cast never lands
    if (this.waitingSince) this.wake();
  }
}
