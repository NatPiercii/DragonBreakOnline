// Why an X press on something sent no player-menu request, for Data\Platform\Logs\dbo-diag-logs.txt (the launcher
// collects it with Report a Problem).
//
// #bugs 1554355554967625758 (athny, 29 Sep): the X menu did not open on two players while they traded. The server logs
// every request it gets ("playerMenu A -> B"), and none came from athny's X on either trader, so the press was dropped
// on the client before it was sent. Nothing in the code refuses it for a trade, so this names the step that does.
//
// Kept free of imports so tests/xmenudiag-harness.js can drive it.

export type XSkipReason =
  | 'menu open'          // the player-action menu is already up
  | 'invite waiting'     // a trade request is waiting and takes the key
  | 'hotkey blocked'     // a game menu, the console, a focused panel or a hidden interface
  | 'crosshair null'     // Game.getCurrentCrosshairRef() found nothing
  | 'crosshair on self'  // the crosshair is on the player's own character
  | 'not an actor'       // the thing under the crosshair is not an actor
  | 'not a synced actor' // an actor the server does not know (a world NPC below 0xff000000)
  | 'not a player';      // a server NPC or creature, not another player's character

export interface XSkipInfo {
  crosshairId?: number;
  remoteId?: number;
  name?: string;
}

export const X_DIAG_INTERVAL_MS = 2000;
export const X_DIAG_MAX_LINES = 60;

const hex = (n: number | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? (n >>> 0).toString(16) : '-');

export function describeXSkip(reason: XSkipReason, info: XSkipInfo = {}): string {
  const parts = [`xmenu: no request (${reason})`];
  if (info.crosshairId !== undefined) parts.push(`crosshair ${hex(info.crosshairId)}`);
  if (info.remoteId !== undefined) parts.push(`remote ${hex(info.remoteId)}`);
  if (info.name) parts.push(`"${String(info.name).slice(0, 40)}"`);
  return parts.join(' ');
}

/**
 * One line per reason at most every intervalMs, and maxLines a session: a player hammering X on a wall writes one
 * line, not hundreds. A line after a quiet spell says how many presses it stood for.
 */
export const createXDiagLog = (write: (line: string) => void, now: () => number = () => Date.now(),
  intervalMs = X_DIAG_INTERVAL_MS, maxLines = X_DIAG_MAX_LINES) => {
  const last = new Map<XSkipReason, { at: number; held: number }>();
  let lines = 0;
  return (reason: XSkipReason, info: XSkipInfo = {}): boolean => {
    if (lines >= maxLines) return false;
    const at = now();
    const prev = last.get(reason);
    if (prev && at - prev.at < intervalMs) {
      prev.held++;
      return false;
    }
    last.set(reason, { at, held: 0 });
    lines++;
    const held = prev && prev.held ? ` (${prev.held} more since the last line)` : '';
    write(describeXSkip(reason, info) + held);
    if (lines === maxLines) write(`xmenu: stopped after ${maxLines} lines this session`);
    return true;
  };
};
