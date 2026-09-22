import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, EffectShader } from "skyrimPlatform";
import { remoteIdToLocalId } from "../../view/worldViewMisc";

const POLL_MS = 1000;

// Server -> Client: { customPacketType: "dboPale", actor: <remote id>, shader: <EFSH form id>, on: boolean }
// A pack leader in beast form wears the pale spirit coat (supernatural.js). Actors load and unload with
// cells, so the wanted set is kept and re-applied whenever the actor is back in 3D, as DboGlowService does.
export class PaleCoatService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboPale") return;
    const remote = Number(content["actor"]) >>> 0;
    const shader = Number(content["shader"]) >>> 0;
    if (!remote || !shader) return;
    if (content["on"]) this.wanted.set(remote, shader);
    else { this.wanted.delete(remote); this.stop(remote); }
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.wanted.forEach((shaderId, remote) => {
      try {
        const actor = Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(remote)));
        const loaded = !!actor && actor.is3DLoaded();
        if (loaded && !this.lit.has(remote)) {
          const shader = EffectShader.from(this.sp.Game.getFormEx(shaderId));
          if (shader) { shader.play(actor!, -1); this.lit.add(remote); }
        } else if (!loaded) this.lit.delete(remote);
      } catch { this.lit.delete(remote); }
    });
  }

  private stop(remote: number): void {
    if (!this.lit.has(remote)) return;
    this.lit.delete(remote);
    try {
      const actor = Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(remote)));
      const shaderId = this.wanted.get(remote);
      const shader = shaderId ? EffectShader.from(this.sp.Game.getFormEx(shaderId)) : null;
      if (actor && shader) shader.stop(actor);
    } catch { /* gone */ }
  }

  private wanted = new Map<number, number>();
  private lit = new Set<number>();
  private lastPoll = 0;
}
