// The dungeon aggro window (Nate, 1 Oct: "aggro is too far for the enemies in dungeons"), import-free so a harness can drive it.
// The server sends ff_aggroWindow (units) with a dungeon spawn. While no player is that close, the copy this client hosts is
// held at Aggression 0 (Unaggressive) and starts no fight; then it gets back the aggression it had (its record's, or the 2
// formView raised it to). The window stays open once it has opened: the copy started combat, it was hit (the server sets
// ff_aggroWindow 0 for every client), or this client reported it near a player (the server then does the same). Each hosting
// client measures the copy against every player it knows of, its own and the others' copies, so a host change keeps it.
//   Client -> Server: { customPacketType: "dbo", event: "aggroOpen", args: ["<remote id hex>"] }
//   Client -> Server: npcDrift { kind: "combatStart", ... } once per copy, at most COMBAT_START_MAX a session

export const CHECK_EVERY_MS = 250;
export const COMBAT_START_MAX = 60;

export type Vec = [number, number, number];
export interface PlayerSpot { pos: Vec; cell: number }
// Other players' copies as the world model last had them (FormViewArray.updateAll fills it each update)
export const playerCopies: { spots: PlayerSpot[] } = { spots: [] };

export interface WindowState { held: boolean; restoreTo: number; opened: boolean; lastCheck: number }
export const newWindowState = (): WindowState => ({ held: false, restoreTo: 0, opened: false, lastCheck: 0 });

export const distance = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The nearest player to `pos` in the same cell or worldspace (0 = unknown, compared loosely), or Infinity */
export const nearestPlayer = (pos: Vec, cell: number, players: PlayerSpot[]): number => {
  let best = Infinity;
  for (const p of players) {
    if (cell && p.cell && p.cell !== cell) continue;
    const d = distance(pos, p.pos);
    if (d < best) best = d;
  }
  return best;
};

export type WindowAction = "hold" | "open" | "release" | "none";

/**
 * What to do with a copy's aggression this check.
 * window: ff_aggroWindow (0 or missing: no window). hosted: this client runs the copy's AI. nearest: the nearest player.
 * inCombat: the copy is already fighting. aggression: its value now.
 */
export const decide = (st: WindowState, window: number, hosted: boolean, nearest: number, inCombat: boolean): WindowAction => {
  if (!hosted || !(window > 0) || st.opened) return st.held ? "release" : "none";
  if (inCombat || nearest <= window) return "open";
  return "hold";
};

/** Applies `action` through `get`/`set` of the Aggression actor value; returns true when the window just opened */
export const apply = (st: WindowState, action: WindowAction, get: () => number, set: (v: number) => void): boolean => {
  if (action === "hold") {
    const now = get();
    if (!st.held) { st.restoreTo = now; st.held = true; if (now !== 0) set(0); return false; }
    // Raised again while held (formView.applyHostility on a flag change): that is the value to go back to
    if (now !== 0) { st.restoreTo = now; set(0); }
    return false;
  }
  if (action === "open" || action === "release") {
    if (st.held) { set(st.restoreTo); st.held = false; }
    if (action === "open" && !st.opened) { st.opened = true; return true; }
  }
  return false;
};

/** The one-off combatStart line, or null once the session's budget is spent */
export const combatStartBudget = { sent: 0 };
export const combatStartLine = (f: {
  remoteId: number; base: string; fromPlayer: number; toTarget: number; nearestPlayer: number; aggression: number;
  window: number; windowOpen: boolean; held: boolean;
}): Record<string, unknown> | null => {
  if (combatStartBudget.sent >= COMBAT_START_MAX) return null;
  combatStartBudget.sent++;
  const r = (x: number) => (Number.isFinite(x) ? Math.round(x) : -1);
  return {
    kind: "combatStart", remoteId: (f.remoteId >>> 0).toString(16), base: f.base, fromPlayer: r(f.fromPlayer), toTarget: r(f.toTarget),
    nearestPlayer: r(f.nearestPlayer), aggression: f.aggression, window: f.window, windowOpen: f.windowOpen, held: f.held,
  };
};
