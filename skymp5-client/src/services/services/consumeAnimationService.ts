import { ButtonEvent, ContainerChangedEvent, DxScanCode, Form, FormType, InputDeviceType, Potion } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { EmoteService } from "./emoteService";
import { logTrace } from "../../logging";

const DRINK_IDLE = "IdleDrink";
const EAT_IDLE = "IdleEatingStandingStart";
// In a chair (EmoteService.playSeatedIdle): the chair's own eating and drinking idles
const SEATED_DRINK_IDLE = "ChairDrinkingStart";
const SEATED_EAT_IDLE = "ChairEatingStart";
const SEATED_SOUP_IDLE = "ChairEatingSoupStart";
const SOUP_WORDS = ["soup", "stew", "broth", "porridge"];
// Actor.GetSitState: 3 = sitting
const SITTING = 3;
// animationdatasinglefile.txt: the drink clip ends itself with IdleStop at 6.55 s; the eating start clip bites at 4.83 s, then loops
const DRINK_SECONDS = 7;
const EAT_SECONDS = 5.5;
// Food whose display name contains one of these is drunk, not eaten (editor ids are not readable client-side)
const DRINK_WORDS = ["ale", "mead", "wine", "milk", "water", "sujamma", "flin", "shein", "mazte", "matze", "skooma", "brandy", "tea", "juice", "sap", "brew", "tonic", "cider"];
// A hotkey use happens outside any menu; accept a removal this soon after a number key
const HOTKEY_WINDOW_MS = 700;
const HOTKEYS = [DxScanCode.N1, DxScanCode.N2, DxScanCode.N3, DxScanCode.N4, DxScanCode.N5, DxScanCode.N6, DxScanCode.N7, DxScanCode.N8];

/**
 * Plays a drink or eat idle on the local player when food or an ingredient is
 * consumed from the inventory, favourites or a hotkey; in a chair, the chair's
 * own eating or drinking idle. Other players see it through the regular
 * animation sync. Potions and poisons play nothing: they stay instant (swag's
 * spec, 2026-09-30); the server caps potions at one per ten seconds.
 *
 * Server-driven removals (trade, a refused potion being handed back) also fire
 * containerChanged, so a removal only counts when an inventory-type menu is
 * open or a hotkey was just pressed.
 */
export class ConsumeAnimationService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("containerChanged", (e) => this.onContainerChanged(e));
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.device !== InputDeviceType.Keyboard || !e.isDown) return;
    if (HOTKEYS.indexOf(e.code) !== -1) this.lastHotkeyAt = Date.now();
  }

  private onContainerChanged(e: ContainerChangedEvent): void {
    const player = this.sp.Game.getPlayer();
    if (!player || !e.oldContainer || e.oldContainer.getFormID() !== player.getFormID()) return;
    if (e.newContainer || e.reference || !e.baseObj) return; // moved to a container, or dropped
    const type = e.baseObj.getType();
    const isIngredient = type === FormType.Ingredient;
    if (!isIngredient && type !== FormType.Potion) return;

    const inMenu = this.sp.Ui.isMenuOpen("InventoryMenu") || this.sp.Ui.isMenuOpen("FavoritesMenu");
    const byHotkey = Date.now() - this.lastHotkeyAt < HOTKEY_WINDOW_MS;
    if (!inMenu && !byHotkey) return;

    const baseId = e.baseObj.getFormID();
    const now = Date.now();
    if (this.lastBaseId === baseId && now - this.lastAt < 300) return; // the server's inventory echo
    this.lastBaseId = baseId;
    this.lastAt = now;

    const anim = this.pickIdle(e.baseObj, isIngredient);
    logTrace(this, "Consumed", e.baseObj.getName(), "->", anim || "(instant)");
    if (!anim) return;
    const drink = anim === DRINK_IDLE;
    const emotes = this.controller.lookupListener(EmoteService);
    if (player.getFurnitureReference() && player.getSitState() === SITTING) {
      const name = (e.baseObj.getName() || "").toLowerCase();
      const seated = drink ? SEATED_DRINK_IDLE : SOUP_WORDS.some((w) => name.indexOf(w) !== -1) ? SEATED_SOUP_IDLE : SEATED_EAT_IDLE;
      emotes.playSeatedIdle(seated, drink ? DRINK_SECONDS : EAT_SECONDS);
      return;
    }
    emotes.playIdle(anim, drink ? DRINK_SECONDS : EAT_SECONDS, drink);
  }

  private pickIdle(form: Form, isIngredient: boolean): string {
    if (isIngredient) return EAT_IDLE;
    const potion = Potion.from(form);
    if (!potion || !potion.isFood()) return ""; // potions and poisons stay instant
    const name = (form.getName() || "").toLowerCase();
    return DRINK_WORDS.some((w) => name.indexOf(w) !== -1) ? DRINK_IDLE : EAT_IDLE;
  }

  private lastHotkeyAt = 0;
  private lastBaseId = 0;
  private lastAt = 0;
}
