// A server request to reopen the input diagnostic (inputDiagService.ts) for a while, kept free of imports so a harness
// can drive it. Auto-run after dying (Purr, /bug 30 Sep 16:24) is thought to be a movement key whose key-up was lost
// while the down panel held keyboard focus; the diagnostic's held/wasd/bf fields show exactly that, but it only ran for
// the first minutes after login. downed.js now asks for it when a player falls.
//
//   Server -> Client: { customPacketType: "dboInputDiag", seconds: <5..180>, reason: "<why>" }

export const MAX_WINDOW_MS = 180000;
export const MIN_WINDOW_MS = 5000;

export interface InputDiagRequest { ms: number; reason: string }

/** The window the server asked for, clamped, or null when the packet is not a request */
export function readInputDiagRequest(content: Record<string, unknown> | null | undefined): InputDiagRequest | null {
  if (!content || content["customPacketType"] !== "dboInputDiag") return null;
  const s = Number(content["seconds"]);
  const ms = Number.isFinite(s) && s > 0 ? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(s * 1000))) : 60000;
  const reason = typeof content["reason"] === "string" ? (content["reason"] as string).replace(/[^\w-]/g, "").slice(0, 24) : "";
  return { ms, reason: reason || "server" };
}
