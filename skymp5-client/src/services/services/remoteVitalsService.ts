import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor } from "skyrimPlatform";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { setActorValuePercentage } from "../../sync/actorvalues";
import { logTrace } from "../../logging";

const POLL_MS = 500;

interface RemoteVitals {
  stamina: number;
  magicka: number;
  // Local ref each value was last applied to; a re-created clone gets them again
  staminaOn: number;
  magickaOn: number;
}

/**
 * Stamina and magicka of other players' clones. Movement carries health only, so the server
 * relays the rest from its own copy (VitalsRelaySystem), quantized, when a value moves 5 points.
 *
 *   Server -> Client: { customPacketType: "dboVitals", v: [remoteActorId, stamina%, magicka%, ...] }
 */
export class RemoteVitalsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionAccepted", () => { this.vitals.clear(); this.logged.clear(); });
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboVitals" || !Array.isArray(content["v"])) return;
    const v = content["v"] as unknown[];
    for (let i = 0; i + 2 < v.length; i += 3) {
      const remoteId = Number(v[i]) >>> 0;
      const stamina = Number(v[i + 1]), magicka = Number(v[i + 2]);
      if (!remoteId || !Number.isFinite(stamina) || !Number.isFinite(magicka)) continue;
      this.vitals.set(remoteId, { stamina: stamina / 100, magicka: magicka / 100, staminaOn: 0, magickaOn: 0 });
    }
    this.nextPoll = 0;
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextPoll || !this.vitals.size) return;
    this.nextPoll = now + POLL_MS;
    this.vitals.forEach((entry, remoteId) => {
      const localId = remoteIdToLocalId(remoteId);
      if (!localId || (entry.staminaOn === localId && entry.magickaOn === localId)) return;
      const ac = Actor.from(this.sp.Game.getFormEx(localId));
      if (!ac || !ac.is3DLoaded() || ac.isDead()) return;
      try {
        if (entry.staminaOn !== localId) {
          setActorValuePercentage(ac, "stamina", entry.stamina);
          entry.staminaOn = localId;
        }
        // Lowering magicka mid-cast could end a replayed concentration spell early, so it waits for the cast to end
        if (entry.magickaOn !== localId && (entry.magicka >= ac.getActorValuePercentage("magicka") || !isCasting(ac))) {
          setActorValuePercentage(ac, "magicka", entry.magicka);
          entry.magickaOn = localId;
        }
      } catch { return; /* not loaded yet, the next poll retries */ }
      if (!this.logged.has(remoteId)) {
        this.logged.add(remoteId);
        logTrace(this, `clone ${remoteId.toString(16)} stamina ${Math.round(entry.stamina * 100)}% magicka ${Math.round(entry.magicka * 100)}%`);
      }
    });
  }

  private vitals = new Map<number, RemoteVitals>();
  private logged = new Set<number>();
  private nextPoll = 0;
}

const isCasting = (ac: Actor): boolean =>
  ac.getAnimationVariableBool("IsCastingLeft") || ac.getAnimationVariableBool("IsCastingRight") || ac.getAnimationVariableBool("IsCastingDual");
