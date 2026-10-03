import { ClientListener, CombinedController, Sp } from "./clientListener";
import { notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked, isGameInputBlocked } from "./widgetMenuUtil";
import { RestraintService } from "./restraintService";
import { emoteNote } from "./emoteDiag";
import { BrowserService } from "./browserService";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";
import { MIN_IDLE_SECONDS, MAX_IDLE_SECONDS, idleRequest, stopsIdle } from "./idleControl";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 24;

interface EmoteDef {
  anim: string;
  label: string;
  // Idle loads an anim object (hoe, book, instrument) into the hand
  prop?: boolean;
  // Graph event that plays the idle's own exit clip
  exit?: string;
}

interface EmoteGroup {
  id: string;
  label: string;
  emotes: EmoteDef[];
}

// Vanilla idle catalog ported from Vengeful Realms' emote wheel, used with permission.
const GROUPS: EmoteGroup[] = [
  {
    id: 'greetings',
    label: 'Greetings',
    emotes: [
      { anim: 'IdleWave', label: 'Wave' },
      { anim: 'IdleCivilWarCheer', label: 'War Cheer' },
      { anim: 'IdleSalute', label: 'Salute' },
      { anim: 'IdleSilentBow', label: 'Silent Bow' },
      { anim: 'IdleGetAttention', label: 'Get Attention' },
      { anim: 'IdleLookFar', label: 'Look Far' },
      { anim: 'IdleMT_DoorBang', label: 'Knock Door' },
    ],
  },
  {
    id: 'reactions',
    label: 'Reactions',
    emotes: [
      { anim: 'IdleApplaud2', label: 'Clapping' },
      { anim: 'IdleApplaud4', label: 'Applaud' },
      { anim: 'IdleApplaud5', label: 'Clapping Overhead' },
      { anim: 'IdleLaugh', label: 'Laugh' },
      { anim: 'IdleSurrender', label: 'Surrender' },
      { anim: 'IdleCowerEnter', label: 'Scared', exit: 'IdleChairExitStart' },
      { anim: 'IdleWipeBrow', label: 'Wipe Brow' },
      { anim: 'IdleWounded_02', label: 'Wounded', exit: 'IdleChairExitStart' },
    ],
  },
  {
    id: 'stances',
    label: 'Stances',
    emotes: [
      { anim: 'IdleLayDownEnter', label: 'Lay Down', exit: 'IdleChairExitStart' },
      { anim: 'IdleWarmHandsStanding', label: 'Warm Hands' },
      { anim: 'IdleWarmHandsCrouched', label: 'Warm Hands (Sit)' },
      { anim: 'IdleGrave_01', label: 'Pray' },
      { anim: 'IdlePray', label: 'Worship' },
      { anim: 'IdleSitCrossLeggedEnter', label: 'Sit Crossed', exit: 'IdleChairExitStart' },
      { anim: 'IdleKneelingEnter', label: 'Kneel', exit: 'IdleChairExitStart' },
      { anim: 'IdleWounded_03', label: 'Sit Lazy', exit: 'IdleChairExitStart' },
    ],
  },
  {
    id: 'dialog',
    label: 'Dialog',
    emotes: [
      { anim: 'OffsetArmsCrossedStart', label: 'Crossed Arms' },
      { anim: 'IdleGrave_02', label: 'Formal Stand' },
      { anim: 'IdleHandsBehindBack', label: 'Hands Behind' },
      { anim: 'IdleExamine', label: 'Examine' },
      { anim: 'IdleStudy', label: 'Study' },
      { anim: 'IdleDialogueHandOnChinGesture', label: 'Hand On Chin' },
      { anim: 'IdlePointFar_01', label: 'Point Far' },
    ],
  },
  {
    id: 'activities',
    label: 'Activities',
    emotes: [
      { anim: 'IdleDrink', label: 'Drink', prop: true },
      { anim: 'IdleEatingStandingStart', label: 'Eating', prop: true, exit: 'AnimObjectIdleStop' },
      { anim: 'IdleLooseSweepingStart', label: 'Sweeping', prop: true },
      { anim: 'IdleHoe', label: 'Use Hoe', prop: true },
      { anim: 'IdleRitualStart', label: 'Ritual' },
      { anim: 'IdleNoteRead', label: 'Read Note', prop: true },
      { anim: 'IdleBook_PageTurn', label: 'Read Book', prop: true },
    ],
  },
  {
    id: 'entertainment',
    label: 'Entertain',
    emotes: [
      { anim: 'IdleCiceroDance1', label: 'Cicero Dance 1' },
      { anim: 'IdleCiceroDance2', label: 'Cicero Dance 2' },
      { anim: 'IdleCiceroDance3', label: 'Cicero Dance 3' },
      { anim: 'IdleDrumStart', label: 'Play Drum', prop: true },
      { anim: 'IdleFluteStart', label: 'Play Flute', prop: true },
      { anim: 'IdleLuteStart', label: 'Play Lute', prop: true },
      { anim: 'IdleBlowHornImperial', label: 'Horn (Imper.)', prop: true },
      { anim: 'IdleBlowHornStormcloak', label: 'Horn (Stormcl.)', prop: true },
    ],
  },
];

// Interaction idles the server may play through a dboIdle packet (reading a notice board, an introduction, a trade, a
// rope), beside the wheel's own, which it may play too. Not on the wheel. Each is an IDLE record in Skyrim.esm
// (docs/alpha/anim-console-check.md); an event the player's graph refuses simply does not play.
const ACTION_IDLES: EmoteDef[] = [
  { anim: 'IdleGive', label: 'Give' },
  { anim: 'IdleTake', label: 'Take' },
  { anim: 'IdleActivatePickUp', label: 'Reach' },
  { anim: 'IdleLockPick', label: 'Work At' },
  // IdleSearchBody's event: kneeling over someone; IdleKneelingExit's event ends it
  { anim: 'IdleKneeling', label: 'Kneel Over', exit: 'IdleChairExitStart' },
  // Helgen (MQ101): the speaker's idle when Hadvar or Ralof cuts the player's binds, and the freed player's own motion
  { anim: 'BoundStandingCutNPC', label: 'Cut Free' },
  { anim: 'BoundStandingCut', label: 'Freed' },
];

// Eating and drinking in a chair, from the chair's own sitting state. They end with IdleStop and never with
// IdleForceDefaultState, which drops the chair's state and leaves the body standing inside the furniture.
const SEATED_IDLES = new Set<string>(['ChairEatingStart', 'ChairDrinkingStart', 'ChairEatingSoupStart']);
// Actor.GetSitState: 3 = sitting
const SITTING = 3;

const events = {
  play: 'emote:play',
  close: 'emote:close',
  stop: 'emote:stop',
};

// Movement input breaks an active emote, matching how remote clones exit poses.
const CANCEL_KEYS: DxScanCode[] = [
  DxScanCode.W,
  DxScanCode.A,
  DxScanCode.S,
  DxScanCode.D,
  DxScanCode.Spacebar,
  DxScanCode.R,
];

/**
 * Emote wheel (default B). Opens a radial menu of vanilla idle animations;
 * the chosen idle plays on the local player and reaches other players through
 * the regular animation sync pipeline. Movement keys break an active emote.
 * Ported from Vengeful Realms' emote system, used with permission.
 */
export class EmoteService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("gameLoad", () => { this.activeEmote = ""; this.chainId++; this.seatedChain++; });
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // A front reload drops the widget without an emote:close message.
    this.controller.emitter.on("browserWindowLoaded", () => { this.menuOpen = false; });
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });

    this.menuKey = readMenuKeyCode(this.sp, "emoteWheelKeyCode", DxScanCode.B);

    this.allowedAnims = new Set<string>();
    this.propAnims = new Set<string>();
    for (const group of GROUPS) {
      for (const emote of group.emotes) {
        this.allowedAnims.add(emote.anim);
        if (emote.prop) this.propAnims.add(emote.anim);
        if (emote.exit) this.exitEvents.set(emote.anim, emote.exit);
      }
    }
    for (const idle of ACTION_IDLES) {
      this.allowedAnims.add(idle.anim);
      if (idle.exit) this.exitEvents.set(idle.anim, idle.exit);
    }

    // Records whether the graph accepted the exit event probed by tryExitChain.
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        if (this.probeAnim && ctx.animEventName === this.probeAnim) {
          this.probeSucceeded = ctx.animationSucceeded;
        }
        if (this.diagAnim && ctx.animEventName === this.diagAnim) {
          emoteNote(`graph ${this.diagAnim} accepted=${ctx.animationSucceeded}`);
          this.diagAnim = "";
        }
      },
    }, 0x14, 0x14);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // Gamepad idCodes are bitmasks that alias onto keyboard scancodes
    if (e.device !== InputDeviceType.Keyboard) return;
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    // Movement is real gameplay even with the interface hidden
    if (e.isDown && this.activeEmote && CANCEL_KEYS.includes(e.code) && !isGameInputBlocked(this.sp, this.controller)) {
      this.stopActiveEmote(false, `movement key ${e.code}`);
    }
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) {
      return;
    }
    if (this.isPoseLocked()) {
      notifyNextUpdate(this.controller, this.sp, "You cannot use emotes while restrained.");
      return;
    }
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("emote:")) {
      return;
    }
    // A message tagged emote: can only have come from the wheel, so the wheel is on screen whatever the flag
    // says. It can say the wrong thing: browserWindowLoaded clears menuOpen without removing the widget, and
    // opening the wheel makes the browser visible and focused, which is the sort of thing that fires it. The
    // wheel then sat there ignoring every click and its own Cancel button, silently, because each message was
    // dropped here (Nat, 2026-09-28: "the wheel opens but nothing happens ... cancel doesnt work either").
    // Trusting the message rather than the flag removes the dependency on getting that flag right.
    this.menuOpen = true;
    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.stop) {
      this.closeMenu();
      this.stopActiveEmote(true, "the wheel's stop");
      return;
    }
    if (key === events.play) {
      const anim = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      // The player's own choice is never the server's idle, even when it is the same clip
      this.serverIdle = "";
      this.closeMenu();
      emoteNote(`play ${anim || "?"} (active ${this.activeEmote || "none"})`);
      if (!this.allowedAnims.has(anim)) {
        logTrace(this, `Emote not in the catalog`, anim);
        emoteNote(`refused ${anim || "?"}: not in the catalog`);
        return;
      }
      if (this.isPoseLocked()) {
        notifyNextUpdate(this.controller, this.sp, "You cannot use emotes while restrained.");
        emoteNote(`refused ${anim}: restrained`);
        return;
      }
      const blocker = this.idleBlocker();
      if (blocker) {
        notifyNextUpdate(this.controller, this.sp, blocker);
        logTrace(this, `Emote refused`, anim, blocker);
        emoteNote(`refused ${anim}: ${blocker}`);
        return;
      }
      this.playEmote(anim);
    }
  }

  /**
   * Plays a catalog idle on the local player (drinking a potion, eating food)
   * and releases it after `seconds`: an idle that `endsItself` has returned to
   * the default state by then, any other is exited through its own exit clip.
   * Movement keys still break it early like any emote.
   */
  public playIdle(anim: string, seconds: number, endsItself: boolean): void {
    if (!this.allowedAnims.has(anim) || this.menuOpen || this.isPoseLocked() || !this.canPlayIdle()) return;
    this.playEmote(anim);
    const chain = this.chainId;
    this.sp.Utility.wait(seconds).then(() => {
      if (this.activeEmote !== anim || this.chainId !== chain) return;
      if (endsItself) {
        this.activeEmote = "";
      } else {
        this.stopActiveEmote(true);
      }
    });
  }

  /**
   * Server -> client: { customPacketType: "dboIdle", anim: string, seconds: number, endsItself: boolean }
   * An interaction animation the gamemode asks for (a notice board, an introduction, a trade, a rope). It goes through
   * playIdle, so the wheel's catalog plus ACTION_IDLES is the allowlist, the same blockers apply (weapon drawn, seated,
   * swimming, mounted, restrained, the wheel open) and movement ends it. Never while a game menu is open: those pause the
   * world, and a clip started under one would play out after it closed. An older client ignores the packet.
   */
  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    // Server -> client: { customPacketType: "dboIdleStop", anim?: string }, the end of an idle it began (the journal closed)
    if (content["customPacketType"] === "dboIdleStop") {
      if (stopsIdle(this.activeEmote, this.serverIdle, content["anim"])) {
        this.serverIdle = "";
        this.stopActiveEmote(true);
      }
      return;
    }
    if (content["customPacketType"] !== "dboIdle") return;
    const anim = typeof content["anim"] === "string" ? (content["anim"] as string) : "";
    if (!this.allowedAnims.has(anim)) {
      logTrace(this, `dboIdle not allowed`, anim);
      return;
    }
    // hold: played until its dboIdleStop (the journal's page-turn while it is open), not for the usual few seconds. A held
    // idle never replaces the player's own emote (a seat, a lute): it only decorates, and closing would leave them standing
    const req = idleRequest(content);
    if (req.hold && this.activeEmote && this.activeEmote !== this.serverIdle) {
      logTrace(this, `Held idle skipped over the player's own emote`, anim);
      return;
    }
    this.playActionIdle(anim, req.seconds, content["endsItself"] === true, req.hold, true);
  }

  /**
   * An interaction idle (dboIdle, or a client event such as a finished trade): on the next frame, through playIdle,
   * and not while a game menu is open. Seconds are held between MIN_IDLE_SECONDS and MAX_IDLE_SECONDS.
   */
  public playActionIdle(anim: string, seconds: number, endsItself: boolean, hold = false, fromServer = false): void {
    const held = hold ? seconds : Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, seconds));
    this.controller.once("update", () => {
      if (this.gameMenuOpen()) {
        logTrace(this, `Interaction idle skipped under a game menu`, anim);
        return;
      }
      this.playIdle(anim, held, endsItself);
      // The server's idle only once it really began (a refused one leaves nothing for a stop to end)
      if (fromServer && this.activeEmote === anim) this.serverIdle = anim;
    });
  }

  // A vanilla menu (inventory, container, barter, book, lockpicking, dialogue, map, console...) is open; our own panels
  // are not counted, so a board's panel does not stop the idle it asked for
  private gameMenuOpen(): boolean {
    try {
      return this.controller.lookupListener(BrowserService).liveBlockingMenus().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Eating or drinking in a chair (ChairEatingStart, ChairDrinkingStart, ChairEatingSoupStart). Only while sitting, and
   * outside the emote bookkeeping: movement keys stand the player up through the chair itself, and the exit is IdleStop
   * alone, sent only if they are still sitting when the clip should be over.
   */
  public playSeatedIdle(anim: string, seconds: number): void {
    if (!SEATED_IDLES.has(anim) || this.menuOpen || this.isPoseLocked()) return;
    const chain = ++this.seatedChain;
    this.controller.once("update", () => {
      const player = this.sp.Game.getPlayer();
      if (!player || !player.getFurnitureReference() || player.getSitState() !== SITTING || player.isWeaponDrawn()) return;
      this.sp.Debug.sendAnimationEvent(player, anim);
      logTrace(this, `Playing seated idle`, anim);
      this.sp.Utility.wait(seconds).then(() => {
        this.controller.once("update", () => {
          if (chain !== this.seatedChain) return;
          const p = this.sp.Game.getPlayer();
          if (p && p.getFurnitureReference() && p.getSitState() === SITTING) this.sp.Debug.sendAnimationEvent(p, "IdleStop");
        });
      });
    });
  }

  // Idles live in the unarmed standing graph; a global one like IdleForceDefaultState strands a drawn weapon there
  private idleBlocker(): string {
    const player = this.sp.Game.getPlayer();
    if (!player) return "There is no body to animate.";
    if (player.isWeaponDrawn()) return "Sheathe your weapon to use emotes.";
    if (player.getFurnitureReference()) return "Stand up to use emotes.";
    if (player.isSwimming()) return "You cannot use emotes while swimming.";
    if (player.isOnMount()) return "You cannot use emotes while mounted.";
    return "";
  }

  private canPlayIdle(): boolean {
    return this.idleBlocker() === "";
  }

  private playEmote(anim: string): void {
    const previous = this.activeEmote;
    this.activeEmote = anim;
    // Offset overlays live on their own graph layer: crossing between an
    // overlay and a state idle needs the previous emote exited first, and the
    // exit event must go out alone so the single-slot animation sync relays it.
    // Prop idles are exited first too, otherwise the next idle keeps the prop.
    // Ground poses hold the sit state, which refuses every other idle until it is left.
    const pose = this.exitEvents.get(previous) === "IdleChairExitStart";
    if (previous && ((previous.indexOf("Offset") === 0) !== (anim.indexOf("Offset") === 0) || this.propAnims.has(previous) || pose)) {
      this.exitEmote(previous, () => this.sendEmote(anim));
      return;
    }
    this.chainId++;
    this.sendEmote(anim);
  }

  private sendEmote(anim: string): void {
    this.controller.once("update", () => {
      if (this.activeEmote !== anim) return;
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      const blocker = this.idleBlocker();
      if (blocker) {
        this.activeEmote = "";
        notifyNextUpdate(this.controller, this.sp, blocker);
        logTrace(this, `Emote dropped before playing`, anim, blocker);
        emoteNote(`dropped ${anim} before playing: ${blocker}`);
        return;
      }
      this.diagAnim = anim;
      this.diagSentAt = Date.now();
      emoteNote(`sent ${anim}`);
      this.sp.Debug.sendAnimationEvent(player, anim);
      logTrace(this, `Playing emote`, anim);
    });
  }

  private stopActiveEmote(graceful = false, why = "an idle's end or a newer idle"): void {
    const anim = this.activeEmote;
    this.activeEmote = "";
    // An emote ended within two seconds of being sent is the "nothing happens" the wheel shows: say what ended it
    if (anim && Date.now() - this.diagSentAt < 2000) emoteNote(`stopped ${anim} after ${Date.now() - this.diagSentAt} ms by ${why}`);
    if (anim) this.exitEmote(anim, undefined, graceful);
  }

  // IdleForceDefaultState breaks most idles; state idles that reject it get
  // their <base>ExitStart / <base>Exit events, offset overlays need OffsetStop.
  // A graceful exit tries the idle's own exit clip first.
  private exitEmote(anim: string, onDone?: () => void, graceful = false): void {
    const chain = ++this.chainId;
    if (anim.indexOf("Offset") === 0) {
      this.controller.once("update", () => {
        const player = this.sp.Game.getPlayer();
        if (player) this.sp.Debug.sendAnimationEvent(player, "OffsetStop");
        // Let the sync poll relay OffsetStop before any follow-up event.
        this.sp.Utility.wait(0.1).then(() => {
          if (chain === this.chainId && onDone) onDone();
        });
      });
      return;
    }
    const base = anim.replace(/(Start|Enter)$/, "");
    const ownExit = graceful ? this.exitEvents.get(anim) : undefined;
    const attempts = [...(ownExit ? [ownExit] : []), "IdleForceDefaultState", base + "ExitStart", base + "Exit"];
    if (!this.propAnims.has(anim)) {
      this.tryExitChain(attempts, 0, chain, onDone);
      return;
    }
    // IdleForceDefaultState skips the graph's unequip state and leaves the prop in hand
    attempts.splice(ownExit ? 1 : 0, 0, "IdleStop");
    this.tryExitChain(attempts, 0, chain, onDone && (() => this.waitPropUnload(chain, 0, onDone)));
  }

  // Holds a follow-up emote until the IdleStop exit has dropped the prop.
  private waitPropUnload(chain: number, tries: number, onDone: () => void): void {
    this.sp.Utility.wait(0.2).then(() => {
      this.controller.once("update", () => {
        if (chain !== this.chainId) return;
        const player = this.sp.Game.getPlayer();
        if (player && player.getAnimationVariableBool("bAnimObjectLoaded") && tries < 8) {
          this.waitPropUnload(chain, tries + 1, onDone);
          return;
        }
        onDone();
      });
    });
  }

  private tryExitChain(attempts: string[], index: number, chain: number, onDone?: () => void): void {
    if (chain !== this.chainId) return;
    if (index >= attempts.length) {
      if (onDone) onDone();
      return;
    }
    this.controller.once("update", () => {
      if (chain !== this.chainId) return;
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      // Drawing, sitting, swimming or mounting already left the idle
      if (!this.canPlayIdle()) {
        if (onDone) onDone();
        return;
      }
      this.probeAnim = attempts[index];
      this.probeSucceeded = false;
      this.sp.Debug.sendAnimationEvent(player, attempts[index]);
      this.sp.Utility.wait(0.15).then(() => {
        if (chain !== this.chainId) return;
        const ok = this.probeSucceeded;
        this.probeAnim = "";
        if (!ok) {
          this.tryExitChain(attempts, index + 1, chain, onDone);
        } else if (onDone) {
          onDone();
        }
      });
    });
  }

  private isPoseLocked(): boolean {
    try {
      return this.controller.lookupListener(RestraintService).isPoseLocked;
    } catch {
      return false;
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.emoteWidgetSetter, { GROUPS, events, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private emoteWidgetSetter = () => {
    const widget = {
      type: "emoteWheel",
      id: WIDGET_ID,
      groups: GROUPS,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.B;
  private menuOpen = false;
  // The idle a dboIdle began, the only one a dboIdleStop may end
  private serverIdle = "";
  private activeEmote = "";
  private allowedAnims: Set<string>;
  private propAnims: Set<string>;
  private exitEvents = new Map<string, string>();
  private probeAnim = "";
  // The emote last sent to the graph, for its diagnostic line (emoteNote), and when
  private diagAnim = "";
  private diagSentAt = 0;
  private probeSucceeded = false;
  // Generation counter: bumping it abandons any pending exit chain.
  private chainId = 0;
  // The same for a seated idle's IdleStop
  private seatedChain = 0;
}
