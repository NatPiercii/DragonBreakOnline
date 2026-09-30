import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { Actor, Idle, ObjectReference } from "skyrimPlatform";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { RemoteServer } from "./remoteServer";
import { logTrace } from "../../logging";

// A vampire's feeding, the client's part (server supernatural.js; Onny's suggestion, Nate 2026-09-30).
//
// Server -> Client: { customPacketType: "dboFeedPair", feeder: <remote id>, victim: <remote id>, idle: <IDLE form id> }
//   Dawnguard's standing bite (IdleVampireStandingFeedFront_Loose, pa_VampireFeedStanding_Front) is a paired
//   animation: one file moves both actors, and SkyMP does not sync that between two players. So every client near the
//   feed plays the pair itself with its own objects: the feeder's client with the player and its copy of the victim,
//   the victim's with its copy of the feeder and the player, a bystander's with its two copies. Only sent while the
//   server's supernatural.feedPairedAnim is on, which stays off until staff have watched it with two clients.
// Server -> Client: { customPacketType: "dboBloody", on: boolean }
//   Blood on this player's face (a tint the server set). While it is there the client watches for the player in water,
//   and says so once: { customPacketType: "dbo", event: "swimming" }. The server washes the blood off.
const SWIM_POLL_MS = 1000;
const SWIM_RESEND_MS = 5000;
const LOG_NAME = "dbo-diag";

export class VampireFeedService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    if (content["customPacketType"] === "dboBloody") {
      this.bloody = content["on"] === true;
      return;
    }
    if (content["customPacketType"] !== "dboFeedPair") return;
    const feeder = Number(content["feeder"]) >>> 0;
    const victim = Number(content["victim"]) >>> 0;
    const idle = Number(content["idle"]) >>> 0;
    if (!feeder || !victim || !idle) return;
    // Papyrus objects are only good inside the frame that looked them up
    this.controller.once("update", () => this.playPair(feeder, victim, idle));
  }

  // The player's own server id is the player here; anyone else is the local copy the view keeps
  private localRef(remote: number): ObjectReference | null {
    let mine = 0;
    try { mine = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0; } catch { mine = 0; }
    if (remote === mine) return this.sp.Game.getPlayer();
    const local = remoteIdToLocalId(remote);
    return local ? ObjectReference.from(this.sp.Game.getFormEx(local)) : null;
  }

  private playPair(feederRemote: number, victimRemote: number, idleId: number): void {
    let outcome = "";
    try {
      const feeder = Actor.from(this.localRef(feederRemote));
      const victim = this.localRef(victimRemote);
      const idle = Idle.from(this.sp.Game.getFormEx(idleId));
      if (!feeder || !victim || !idle) {
        outcome = `skipped: ${!feeder ? "no feeder" : !victim ? "no victim" : "no idle"}`;
      } else if (!feeder.is3DLoaded() || !victim.is3DLoaded()) {
        outcome = "skipped: not loaded";
      } else if (feeder.isDead() || (Actor.from(victim)?.isDead() ?? false)) {
        outcome = "skipped: dead";
      } else if (feeder.getParentCell()?.getFormID() !== victim.getParentCell()?.getFormID()) {
        outcome = "skipped: different cells";
      } else {
        outcome = feeder.playIdleWithTarget(idle, victim) ? "played" : "refused by the engine";
      }
    } catch (e) {
      outcome = `failed: ${e}`;
    }
    const line = `feed pair ${feederRemote.toString(16)} -> ${victimRemote.toString(16)} idle ${idleId.toString(16)}: ${outcome}`;
    logTrace(this, line);
    try {
      (this.sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, line);
    } catch {
      // An older SkyrimPlatform without writeLogs: the console has it
    }
  }

  private onUpdate(): void {
    if (!this.bloody) return;
    const now = Date.now();
    if (now - this.lastSwimPoll < SWIM_POLL_MS) return;
    this.lastSwimPoll = now;
    let swimming = false;
    try { swimming = !!this.sp.Game.getPlayer()?.isSwimming(); } catch { swimming = false; }
    if (!swimming || now - this.lastSwimSent < SWIM_RESEND_MS) return;
    this.lastSwimSent = now;
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "swimming", args: [] });
  }

  private bloody = false;
  private lastSwimPoll = 0;
  private lastSwimSent = 0;
}
