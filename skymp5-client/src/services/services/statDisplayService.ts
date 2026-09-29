import { Armor, Game, Menu, Weapon } from "skyrimPlatform";
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

// The item menus build their cards from the very base forms this service writes to, and the Stats menu reads the combat
// skills it zeroes, so a pass that ran while one was open would be rewriting records Scaleform is reading. Nothing is
// written until the last of them closes.
const GUARDED_MENUS = [
  Menu.Inventory, Menu.Container, Menu.Barter, Menu.Gift,
  Menu.Crafting, Menu.Favorites, Menu.Magic, Menu.Book,
  Menu.Stats,
];

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

  // True while any menu that renders what this service writes is up. Asked of the engine per pass: a menu whose close
  // event never arrived must not hold the writes off for ever.
  private itemMenuOpen(): string {
    for (const menu of GUARDED_MENUS) {
      try {
        if (this.sp.Ui.isMenuOpen(menu)) return menu;
      } catch (e) { /* the menu cannot be asked about: treat it as closed */ }
    }
    return "";
  }

  // Also on a timer: a skill value set later by the server moves the game's factor
  private onUpdate(): void {
    if (!this.items.length) return;

    const openMenu = this.itemMenuOpen();
    if (openMenu) {
      if (!this.deferred) {
        this.deferred = true;
        logTrace(this, `stat display: pass deferred, ${openMenu} is open`);
      }
      return;
    }
    // A deferred pass runs on the first update after the last guarded menu closes, not at the next timer tick
    if (!this.deferred && Date.now() < this.nextApply) return;
    this.deferred = false;
    this.nextApply = Date.now() + REAPPLY_MS;

    const player = Game.getPlayer();
    if (!player) return;
    for (const skill of Array.from(new Set(this.items.map((i) => i.skill)))) {
      // Read before write, like the item numbers below, so a settled game writes nothing. The base value is what is
      // asked for, because setActorValue writes the base: getActorValue carries buffs and fortify effects, and a
      // fortified skill on a base of 0 would make this write every pass for no change.
      try { if (player.getBaseActorValue(skill) !== 0) player.setActorValue(skill, 0); } catch (e) { /* not an actor value */ }
    }
    let changed = 0;
    for (const item of this.items) {
      let skill = 0;
      try { skill = Number(player.getActorValue(item.skill)) || 0; } catch { continue; }
      const target = Math.round(item.value);
      try {
        // Looked up by id every pass: a native object does not survive the frame it was made in
        if (item.kind === "weapon") {
          const weapon = Weapon.from(Game.getFormEx(item.id));
          if (!weapon) continue;
          const base = StatDisplayService.bestBase(target, item.temper, 1 + skill / 200, Math.round);
          if (weapon.getBaseDamage() === base) continue;   // asked of the form, so a settled pass writes nothing at all
          weapon.setBaseDamage(base);
          changed++;
        } else {
          const armor = Armor.from(Game.getFormEx(item.id));
          if (!armor) continue;
          const base = StatDisplayService.bestBase(target, item.temper, 1 + 0.4 * skill / 100, Math.ceil);
          if (armor.getArmorRating() === base) continue;
          armor.setArmorRating(base);
          changed++;
        }
      } catch (e) { /* the form is not loaded here */ }
    }
    if (changed) logTrace(this, `stat display: wrote ${changed} of ${this.items.length}`);
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
  private nextApply = 0;
  private deferred = false;
}
