import { System, Log, SystemContext } from "./system";
import { userOf } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Mirrors each player's stamina and magicka onto their clones on neighbouring clients.
// Movement carries health only; the server already holds all three from the owner's ChangeValues.
//   Server -> Client: { customPacketType: "dboVitals", v: [actorId, stamina%, magicka%, ...] }
// A recipient hears a neighbour on first sight, then on a change of STEP points or on reaching empty or full.

const TICK_MS = 500;
const STEP = 5;

interface Sent {
  stamina: number;
  magicka: number;
  seen: number;
}

export class VitalsRelaySystem implements System {
  systemName = "VitalsRelaySystem";
  constructor(private log: Log) { }

  // "recipient:source" -> values last sent, pruned once the pair is out of range
  private sent = new Map<string, Sent>();
  private tick = 0;

  async initAsync(): Promise<void> {
    this.log(`VitalsRelaySystem: stamina/magicka to neighbours every ${TICK_MS} ms on a ${STEP} point change`);
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, TICK_MS));
    const mp = ctx.svr as Mp;
    let online: number[] = [];
    try { online = mp.get(0, "onlinePlayers") ?? []; } catch { return; }
    const tick = ++this.tick;
    const players = new Set(online.map((id) => Number(id) >>> 0));
    const packets = new Map<number, number[]>();

    for (const source of players) {
      let stamina: number, magicka: number, neighbors: number[];
      try {
        const p = mp.get(source, "percentages");
        stamina = toPercent(p?.stamina);
        magicka = toPercent(p?.magicka);
        neighbors = mp.get(source, "actorNeighbors") ?? [];
      } catch { continue; }
      for (const raw of neighbors) {
        const recipient = Number(raw) >>> 0;
        if (recipient === source || !players.has(recipient)) continue;
        const key = `${recipient}:${source}`;
        const prev = this.sent.get(key);
        if (prev) prev.seen = tick;
        if (prev && !changed(prev.stamina, stamina) && !changed(prev.magicka, magicka)) continue;
        this.sent.set(key, { stamina, magicka, seen: tick });
        const v = packets.get(recipient) ?? [];
        v.push(source, stamina, magicka);
        packets.set(recipient, v);
      }
    }

    for (const [key, s] of this.sent) {
      if (s.seen !== tick) this.sent.delete(key);
    }
    for (const [recipient, v] of packets) {
      const user = userOf(mp, recipient);
      if (user < 0) continue;
      try { mp.sendCustomPacket(user, JSON.stringify({ customPacketType: "dboVitals", v })); } catch { }
    }
  }
}

const toPercent = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 100))) : 100;
};

const changed = (last: number, now: number): boolean =>
  last !== now && (Math.abs(now - last) >= STEP || now === 0 || now === 100);
