// The server's interaction idles (EmoteService dboIdle, dboIdleStop): how long one is held, and which stop ends it
export const MIN_IDLE_SECONDS = 1;
export const MAX_IDLE_SECONDS = 10;
// A held idle (the Character Journal's page-turn) lasts until its stop; this bounds one whose stop never comes
export const HOLD_MAX_SECONDS = 600;

export interface IdleRequest {
  seconds: number;
  hold: boolean;
}

export function idleRequest(content: Record<string, unknown>): IdleRequest {
  const hold = content["hold"] === true;
  const asked = Number(content["seconds"]) || 3;
  return { hold, seconds: hold ? HOLD_MAX_SECONDS : Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, asked)) };
}

// A stop ends only the idle the server began, never an emote the player chose on the wheel since
export function stopsIdle(activeEmote: string, serverIdle: string, requested: unknown): boolean {
  if (!activeEmote || activeEmote !== serverIdle) return false;
  return typeof requested !== "string" || requested === "" || requested === activeEmote;
}
