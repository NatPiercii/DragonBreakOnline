// One line per step of an emote, to the server log through the dboDiag relay (PageInputDiagService.__dboDiagNote):
// #bugs 2 Oct "Emotes not working", every emote doing nothing for everyone, with no line to say where it stops. Logging
// only: guarded at both ends, so a missing relay or a throw never touches the emote.
export const emoteNote = (text: string): void => {
  try {
    const note = (globalThis as { __dboDiagNote?: (kind: string, text: string) => void }).__dboDiagNote;
    if (typeof note === "function") note("emote", text);
  } catch {
    // diagnostics never break the caller
  }
};
