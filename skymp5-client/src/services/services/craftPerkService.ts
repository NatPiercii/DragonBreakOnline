import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { Perk } from "skyrimPlatform";
import { logError, logTrace } from "../../logging";
import { CRAFT_PERK_RECHECK_MS, dropOnSpawn, parseCraftPerks, planCraftPerks } from "./craftPerks";

// Holds the vanilla Smithing perks the server says this character's Blacksmith tier stands for (craftPerks.ts), so the
// crafting menu shows the recipes the server accepts. The server cannot add a perk itself: its Papyrus VM has no AddPerk.
// Runs in update, looks every perk up again each pass, and checks again every few seconds, since a game load drops them.
export class CraftPerkService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onPacket(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActor(e));
    this.controller.emitter.on("connectionAccepted", () => this.reset());
    this.controller.emitter.on("connectionDisconnect", () => this.reset());
    this.controller.emitter.on("gameLoad", () => { this.forced = true; });
    this.controller.on("update", () => this.onUpdate());
  }

  private onPacket(event: ConnectionMessage<CustomPacketMessage>): void {
    const set = parseCraftPerks(parseCustomPacket(event));
    if (!set) return;
    this.wanted = set.perks;
    this.managed = set.managed;
    this.lastPacketAt = Date.now();
    this.forced = true;
  }

  // A new character keeps nothing of the last one's set unless the server has just sent its own
  private onCreateActor(event: ConnectionMessage<CreateActorMessage>): void {
    if (!event.message.isMe) return;
    if (dropOnSpawn(this.lastPacketAt, Date.now())) this.wanted = [];
    this.forced = true;
  }

  private reset(): void {
    this.wanted = [];
    this.lastPacketAt = 0;
    this.forced = true;
  }

  private onUpdate(): void {
    const now = Date.now();
    if (!this.forced && now < this.nextCheckAt) return;
    this.forced = false;
    this.nextCheckAt = now + CRAFT_PERK_RECHECK_MS;
    try { this.apply(); } catch (e) { logError(this, "craft perk sync failed", e); }
  }

  private apply(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    const perkOf = (id: number) => Perk.from(this.sp.Game.getFormEx(id));
    const held = (id: number) => { const perk = perkOf(id); try { return !!perk && player.hasPerk(perk); } catch { return false; } };
    const plan = planCraftPerks(this.wanted, this.managed, Array.from(this.granted), held);
    for (const id of plan.add) {
      const perk = perkOf(id);
      if (!perk) { logError(this, "craft perk not in the load order", id.toString(16)); continue; }
      player.addPerk(perk);
      this.granted.add(id);
    }
    for (const id of plan.remove) {
      const perk = perkOf(id);
      if (perk) player.removePerk(perk);
      this.granted.delete(id);
    }
    if (plan.add.length || plan.remove.length) logTrace(this, "Craft perks", `+${plan.add.length} -${plan.remove.length}`);
  }

  private wanted: number[] = [];
  private managed: number[] = [];
  private granted = new Set<number>();
  private lastPacketAt = 0;
  private nextCheckAt = 0;
  private forced = true;
}
