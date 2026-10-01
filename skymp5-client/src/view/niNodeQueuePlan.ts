// Which NiNode update may go out this frame, with no engine calls (niNodeQueue.ts drives it)
// SkyrimPlatform's tint hook keeps one queued actor id (FridaHooks.cpp g_queueNiNodeActorId, set when queued), so two
// updates in one frame can draw one actor's tints on another's face, the player's included (#bugs 1555092839627755561).
// Until the native fix: the player's own update always goes out at once; a copy waits, one per frame, never in or just
// after a frame the player's went out, and only while its 3D is loaded. Ids only; actors are looked up when sent.

export class NiNodeQueuePlan {
  // The frame the player's own update last went out
  playerQueued(frame: number): void {
    this.playerFrame = frame;
    this.lastSentFrame = frame;
  }

  // A remote copy wants its 3D rebuilt; asked again while it waits changes nothing
  request(formId: number): void {
    const id = formId >>> 0;
    if (!id || this.pending.includes(id)) return;
    this.pending.push(id);
  }

  // True when a copy's update already went out this frame: the player's own then waits a frame
  copySentIn(frame: number): boolean {
    return this.lastSentFrame === frame && this.playerFrame !== frame;
  }

  forget(formId: number): void {
    this.pending = this.pending.filter((id) => id !== (formId >>> 0));
  }

  get waiting(): number {
    return this.pending.length;
  }

  // The copy to send this frame, or 0. loaded(id) answers for this frame: true loaded, false not yet, null gone
  next(frame: number, loaded: (formId: number) => boolean | null): number {
    if (this.lastSentFrame === frame) return 0;
    if (this.playerFrame >= 0 && frame - this.playerFrame <= 1) return 0;
    for (let i = 0; i < this.pending.length; i++) {
      const id = this.pending[i];
      const state = loaded(id);
      if (state === null) { this.pending.splice(i, 1); i--; continue; }
      if (!state) continue;
      this.pending.splice(i, 1);
      this.lastSentFrame = frame;
      return id;
    }
    return 0;
  }

  private pending: number[] = [];
  private playerFrame = -1;
  private lastSentFrame = -1;
}
