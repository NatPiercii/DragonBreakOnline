import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { EffectShader, ObjectReference } from "skyrimPlatform";

// Vanilla detect-life shaders: no fill texture, so they rim the target instead of washing it white
const SHADERS: Record<string, number> = { loot: 0x00000146, locked: 0x000aaeb3, champion: 0x000dc209 };
const POLL_MS = 1000;

/**
 * Highlights lootable containers the server points at (dungeon chests while a
 * lease runs). References load and unload with cells, so the wanted set is kept
 * and every second any loaded, not-yet-glowing ref gets the shader.
 *
 *   Server -> Client: { customPacketType: "dboGlow", refs: [<formId>...], on: boolean }
 *   on=true adds the refs to the set; on=false removes them and stops their shader.
 *   { customPacketType: "dboGlow", clear: true } stops everything.
 */
export class DboGlowService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboGlow") return;
    if (content["clear"]) { this.stopAll(); this.wanted.clear(); return; }
    const refs = Array.isArray(content["refs"]) ? content["refs"].map((v) => Number(v) >>> 0).filter((v) => v) : [];
    const kind = typeof content["kind"] === "string" && SHADERS[content["kind"] as string] ? content["kind"] as string : "loot";
    if (content["on"]) {
      for (const id of refs) { if (this.wanted.get(id) !== kind) { this.stop(id); this.wanted.set(id, kind); } }
    } else {
      for (const id of refs) { if (this.wanted.get(id) === kind) { this.wanted.delete(id); this.stop(id); } }
    }
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextPoll) return;
    this.nextPoll = now + POLL_MS;
    if (!this.wanted.size && !this.glowing.size) return;
    this.wanted.forEach((kind, id) => {
      if (this.glowing.has(id)) return;
      const shader = this.shader(kind);
      if (!shader) return;
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (!ref || ref.isDisabled() || ref.isDeleted() || !ref.is3DLoaded()) return;
      try { shader.play(ref, -1); this.glowing.set(id, kind); } catch { /* not loaded yet */ }
    });
    // A ref that unloaded keeps its entry; play again when it comes back.
    for (const id of Array.from(this.glowing.keys())) {
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (!ref || !ref.is3DLoaded()) this.glowing.delete(id);
    }
  }

  private stop(id: number): void {
    const kind = this.glowing.get(id);
    if (kind === undefined) return;
    this.glowing.delete(id);
    const shader = this.shader(kind);
    const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
    if (shader && ref) { try { shader.stop(ref); } catch { /* gone */ } }
  }

  private stopAll(): void {
    for (const id of Array.from(this.glowing.keys())) this.stop(id);
  }

  // Looked up every time: a native object is only valid in the frame it came from, and the cached copy made every
  // later play() throw, which the catch above took for "not loaded yet", so dungeon chests never glowed (2026-09-25)
  private shader(kind: string): EffectShader | null {
    try { return EffectShader.from(this.sp.Game.getFormEx(SHADERS[kind] || SHADERS.loot)); } catch { return null; }
  }

  private wanted = new Map<number, string>();
  private glowing = new Map<number, string>();
  private nextPoll = 0;
}
