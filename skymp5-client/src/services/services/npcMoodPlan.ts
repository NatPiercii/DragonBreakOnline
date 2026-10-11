// Harmony and Mayhem on a hosted NPC (server npcmood.js): what to do each tick, apart from the engine (npcMoodService.ts)

export type MoodMode = "calm" | "frenzy";

export const AGGRESSION: Record<MoodMode, number> = { calm: 0, frenzy: 3 };
export const ASSERT_MS = 1000;
// The packet can reach us a moment before the host grant does
export const HOST_GRACE_MS = 5000;
export const MAX_SECONDS = 120;

/** The Actor methods used, so the plan runs against a fake in tests */
export interface MoodActor {
  getActorValue(name: string): number;
  setActorValue(name: string, value: number): void;
  stopCombat(): void;
  stopCombatAlarm(): void;
  startCombat(target: never): void;
  evaluatePackage(): void;
  isInCombat(): boolean;
  isDead(): boolean;
}

/** One tick's view of the world. Native objects it hands out are valid for this tick only and are never kept */
export interface MoodWorld<A extends MoodActor> {
  now: number;
  /** The local copy of a server id, or null when it has none */
  actorOf(remoteId: number): A | null;
  loaded(actor: A): boolean;
  hostedByMe(remoteId: number): boolean;
  /** The nearest living actor other than itself, the player only when nothing else is near */
  nearestTarget(actor: A): A | null;
  note?(line: Record<string, unknown>): void;
}

interface Entry {
  mode: MoodMode;
  until: number;
  receivedAt: number;
  wasHosted: boolean;
  /** The copy's Aggression before the first change, while a change is on it */
  saved?: number;
  applied?: MoodMode;
  nextAssert: number;
}

export interface MoodPacket { refId: number; mode: MoodMode; seconds: number }

export const readMoodPacket = (content: Record<string, unknown>): MoodPacket | null => {
  if (content["customPacketType"] !== "dboNpcMood") return null;
  const raw = content["refId"];
  const refId = (typeof raw === "string" ? parseInt(raw, 16) : Number(raw)) >>> 0;
  const mode = content["mode"];
  const seconds = Number(content["seconds"]);
  if (!refId || (mode !== "calm" && mode !== "frenzy") || !(seconds > 0)) return null;
  return { refId, mode, seconds: Math.min(MAX_SECONDS, seconds) };
};

export class MoodSet {
  readonly entries = new Map<number, Entry>();

  receive(p: MoodPacket, now: number): void {
    const e = this.entries.get(p.refId);
    if (e) { e.mode = p.mode; e.until = now + p.seconds * 1000; return; }
    this.entries.set(p.refId, { mode: p.mode, until: now + p.seconds * 1000, receivedAt: now, wasHosted: false, nextAssert: 0 });
  }

  tick<A extends MoodActor>(w: MoodWorld<A>): void {
    this.entries.forEach((e, id) => {
      const actor = w.actorOf(id);
      const hosted = w.hostedByMe(id);
      if (hosted) e.wasHosted = true;
      const drop = (why: string) => {
        if (actor && e.applied) this.restore(actor, e, id, why, w);
        this.entries.delete(id);
      };
      if (w.now >= e.until) return drop("expired");
      if (actor && actor.isDead()) return drop("dead");
      if (!hosted) {
        if (e.wasHosted || w.now - e.receivedAt > HOST_GRACE_MS) drop("not hosted");
        return;
      }
      // Gone: its next copy starts from the record, so nothing is left to restore
      if (!actor) { e.applied = undefined; e.saved = undefined; return; }
      if (!w.loaded(actor)) {
        if (e.applied) this.restore(actor, e, id, "unloaded", w);
        return;
      }
      if (e.applied !== e.mode) this.apply(actor, e, id, w);
      else if (w.now >= e.nextAssert) this.assert(actor, e, w);
    });
  }

  private apply<A extends MoodActor>(actor: A, e: Entry, id: number, w: MoodWorld<A>): void {
    if (e.applied === undefined) e.saved = actor.getActorValue("Aggression");
    const from = e.applied;
    actor.setActorValue("Aggression", AGGRESSION[e.mode]);
    let target = false;
    if (e.mode === "calm") {
      actor.stopCombat();
      actor.stopCombatAlarm();
    } else {
      actor.evaluatePackage();
      target = this.fight(actor, w);
    }
    e.applied = e.mode;
    e.nextAssert = w.now + ASSERT_MS;
    w.note?.({ kind: "npcMood", remoteId: id.toString(16), step: from ? "switch" : "apply", mode: e.mode, saved: e.saved, target, left: Math.round((e.until - w.now) / 1000) });
  }

  // Held for the whole time: a calm copy hit again re-enters combat, and other code may write Aggression
  private assert<A extends MoodActor>(actor: A, e: Entry, w: MoodWorld<A>): void {
    e.nextAssert = w.now + ASSERT_MS;
    if (actor.getActorValue("Aggression") !== AGGRESSION[e.mode]) actor.setActorValue("Aggression", AGGRESSION[e.mode]);
    if (e.mode === "calm") {
      actor.stopCombat();
      actor.stopCombatAlarm();
    } else {
      this.fight(actor, w);
    }
  }

  private fight<A extends MoodActor>(actor: A, w: MoodWorld<A>): boolean {
    if (actor.isInCombat()) return true;
    const target = w.nearestTarget(actor);
    if (!target) return false;
    actor.startCombat(target as never);
    return true;
  }

  private restore<A extends MoodActor>(actor: A, e: Entry, id: number, why: string, w: MoodWorld<A>): void {
    if (e.saved !== undefined) actor.setActorValue("Aggression", e.saved);
    if (e.applied === "frenzy") actor.stopCombat();
    actor.evaluatePackage();
    w.note?.({ kind: "npcMood", remoteId: id.toString(16), step: "restore", why, mode: e.applied, saved: e.saved });
    e.applied = undefined;
    e.saved = undefined;
  }
}
