// Per-user limits for the systems' custom packet loop in index.ts; settings "packetGuard" overrides the defaults
export interface PacketGuardOptions {
  perSecond: number;
  burst: number;
  errorsPerMinute: number;
}

export const DEFAULT_PACKET_GUARD: PacketGuardOptions = { perSecond: 40, burst: 200, errorsPerMinute: 5 };

export interface AcceptedPacket {
  type: string;
  content: Record<string, unknown>;
}

export class PacketGuard {
  private buckets = new Map<number, { tokens: number; at: number }>();
  private errors = new Map<string, { since: number; n: number; held: number }>();
  dropped = 0;

  constructor(private opts: PacketGuardOptions = DEFAULT_PACKET_GUARD, private now: () => number = Date.now) { }

  // The packet without its customPacketType, or null when it is over the rate or not a JSON object with a string type
  accept(userId: number, raw: string): AcceptedPacket | null {
    const t = this.now();
    let b = this.buckets.get(userId);
    if (!b) {
      b = { tokens: this.opts.burst, at: t };
      this.buckets.set(userId, b);
    }
    b.tokens = Math.min(this.opts.burst, b.tokens + ((t - b.at) / 1000) * this.opts.perSecond);
    b.at = t;
    if (b.tokens < 1) {
      this.dropped++;
      return null;
    }
    b.tokens -= 1;
    let content: unknown;
    try { content = JSON.parse(raw); } catch { return null; }
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const obj = content as Record<string, unknown>;
    if (typeof obj.customPacketType !== "string") return null;
    const type = obj.customPacketType;
    delete obj.customPacketType;
    return { type, content: obj };
  }

  reset(userId: number): void {
    this.buckets.delete(userId);
  }

  // Whether to log this system's error, and how many were held back in the minute before it
  noteError(systemName: string): { log: boolean; held: number } {
    const t = this.now();
    let e = this.errors.get(systemName);
    let held = 0;
    if (!e || t - e.since >= 60000) {
      held = e ? e.held : 0;
      e = { since: t, n: 0, held: 0 };
      this.errors.set(systemName, e);
    }
    if (++e.n > this.opts.errorsPerMinute) {
      e.held++;
      return { log: false, held };
    }
    return { log: true, held };
  }
}
