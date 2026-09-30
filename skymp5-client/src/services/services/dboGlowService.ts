import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { EffectShader, ObjectReference } from "skyrimPlatform";
import { DEFAULT_SHADERS, Glow, GlowSet, readGlowPacket } from "./dboGlowPlan";

// Which shader lights what, and why the detect-life ones never showed on a chest: dboGlowPlan.ts
const POLL_MS = 1000;

/**
 * Highlights lootable containers the server points at (dungeon chests while a
 * lease runs). References load and unload with cells, so the wanted set is kept
 * and every second any loaded, not-yet-glowing ref gets the shader.
 *
 *   Server -> Client: { customPacketType: "dboGlow", refs: [<formId>...], on: boolean, kind?: string, shader?: <formId> }
 *   on=true adds the refs to the set; on=false removes them and stops their shader. shader names the EFSH to use;
 *   without it the kind's default (dboGlowPlan DEFAULT_SHADERS).
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
    const packet = readGlowPacket(content);
    for (const id of this.set.apply(packet)) this.stop(id);
    if (packet.clear) this.stopAll();   // anything still lit, wanted or not
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextPoll) return;
    this.nextPoll = now + POLL_MS;
    if (!this.set.wanted.size && !this.glowing.size) return;
    this.set.wanted.forEach((glow, id) => {
      if (this.glowing.has(id)) return;
      const shader = this.shader(glow);
      if (!shader) return;
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (!ref || ref.isDisabled() || ref.isDeleted() || !ref.is3DLoaded()) return;
      try { shader.play(ref, -1); this.glowing.set(id, glow); } catch { /* not loaded yet */ }
    });
    // A ref that unloaded keeps its entry; play again when it comes back.
    for (const id of Array.from(this.glowing.keys())) {
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (!ref || !ref.is3DLoaded()) this.glowing.delete(id);
    }
  }

  private stop(id: number): void {
    const glow = this.glowing.get(id);
    if (glow === undefined) return;
    this.glowing.delete(id);
    const shader = this.shader(glow);   // the one it was started with
    const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
    if (shader && ref) { try { shader.stop(ref); } catch { /* gone */ } }
  }

  private stopAll(): void {
    for (const id of Array.from(this.glowing.keys())) this.stop(id);
  }

  // Looked up every time: a native object is only valid in the frame it came from, and the cached copy made every
  // later play() throw, which the catch above took for "not loaded yet", so dungeon chests never glowed (2026-09-25)
  // A shader the server named that is not an EffectShader in this load order falls back to the kind's default.
  private shader(glow: Glow): EffectShader | null {
    const tryForm = (id: number): EffectShader | null => { try { return id ? EffectShader.from(this.sp.Game.getFormEx(id)) : null; } catch { return null; } };
    return tryForm(glow.shader) || tryForm(DEFAULT_SHADERS[glow.kind] || DEFAULT_SHADERS.loot);
  }

  private set = new GlowSet();
  private glowing = new Map<number, Glow>();
  private nextPoll = 0;
}
