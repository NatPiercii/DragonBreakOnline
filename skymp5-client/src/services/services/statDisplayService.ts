import { Armor, Game, Weapon } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";

// The inventory's damage and armor numbers, made the server's (Nate, 2026-09-29: "we just want the game number to be
// accurate"). The game draws a weapon as Round[(base + tempering) x (1 + skill/200)] and a piece of armor as
// Ceil[(base + tempering) x (1 + 0.4 x skill/100)] (UESP Skyrim:Weapons, Skyrim:Armor), from its own skills, while the
// server hits with our tiers, the material and Defense. The server sends, for each weapon and armor piece this player
// carries, the number it uses; this sets the item's base on this game only (Weapon.setBaseDamage,
// Armor.setArmorRating) so that formula, with this player's live skill and the item's tempering, lands on it. Nothing
// the server calculates reads these values.
// The setters take whole numbers, and with the skill factor some values cannot be reached at all (a 7 shows as 6 or 8 at
// 1.075), so the game's own combat skills the inventory reads are held at 0 on this game: the factor is then 1 and
// every number shows exactly. The server's masterySystem sets them to 15 per tier for show only, the server reads none
// of them, and the only other client user (disableSkillAdvanceService) just turns their experience off.
//
// Server -> client: { customPacketType: "dboStatDisplay", items: [{ id, kind: "weapon" | "armor", skill, temper, value }] }
interface StatItem { id: number; kind: "weapon" | "armor"; skill: string; temper: number; value: number }

const REAPPLY_MS = 5000;
const MAX_ITEMS = 250;

export class StatDisplayService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboStatDisplay") return;
    const raw = Array.isArray(content["items"]) ? (content["items"] as unknown[]) : [];
    this.items = raw.slice(0, MAX_ITEMS).map((x) => x as Record<string, unknown>).filter((x) =>
      Number.isFinite(Number(x["id"])) && (x["kind"] === "weapon" || x["kind"] === "armor") && typeof x["skill"] === "string" && Number.isFinite(Number(x["value"]))
    ).map((x) => ({ id: Number(x["id"]) >>> 0, kind: x["kind"] as "weapon" | "armor", skill: String(x["skill"]), temper: Number(x["temper"]) || 0, value: Number(x["value"]) }));
    this.nextApply = 0;
  }

  // Also on a timer: a skill value set later by the server moves the game's factor
  private onUpdate(): void {
    if (!this.items.length || Date.now() < this.nextApply) return;
    this.nextApply = Date.now() + REAPPLY_MS;
    const player = Game.getPlayer();
    if (!player) return;
    for (const skill of Array.from(new Set(this.items.map((i) => i.skill)))) {
      try { if (player.getBaseActorValue(skill) !== 0) player.setActorValue(skill, 0); } catch { /* not an actor value */ }
    }
    let changed = 0;
    for (const item of this.items) {
      let skill = 0;
      try { skill = Number(player.getActorValue(item.skill)) || 0; } catch { continue; }
      const target = Math.round(item.value);
      try {
        if (item.kind === "weapon") {
          const weapon = Weapon.from(Game.getFormEx(item.id));
          if (!weapon) continue;
          const base = StatDisplayService.bestBase(target, item.temper, 1 + skill / 200, Math.round);
          if (this.applied.get(item.id) === base) continue;
          weapon.setBaseDamage(base);
          this.applied.set(item.id, base);
          changed++;
        } else {
          const armor = Armor.from(Game.getFormEx(item.id));
          if (!armor) continue;
          const base = StatDisplayService.bestBase(target, item.temper, 1 + 0.4 * skill / 100, Math.ceil);
          if (this.applied.get(item.id) === base) continue;
          armor.setArmorRating(base);
          this.applied.set(item.id, base);
          changed++;
        }
      } catch { /* the form is not loaded here */ }
    }
    if (changed) logTrace(this, `set ${changed} item number(s) to the server's`);
  }

  // The whole base (the setters take whole numbers) whose shown value, round or ceil of (base + tempering) x factor,
  // comes nearest the server's number
  public static bestBase(target: number, temper: number, factor: number, shown: (v: number) => number): number {
    const guess = target / factor - temper;
    let best = Math.max(0, Math.round(guess)), bestErr = Infinity;
    for (let b = Math.max(0, Math.floor(guess) - 2); b <= Math.ceil(guess) + 2; b++) {
      const err = Math.abs(shown((b + temper) * factor) - target);
      if (err < bestErr) { best = b; bestErr = err; }
    }
    return best;
  }

  private items: StatItem[] = [];
  private applied = new Map<number, number>();
  private nextApply = 0;
}
