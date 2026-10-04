import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { readMenuKeyCode, isMenuKeyPressBlocked } from "./widgetMenuUtil";
import { buttonKeyCode } from "./mouseKeys";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";

/**
 * The player menu (default U). The panel itself is the server's: this asks for
 * it and lets the relay (DboRelayService) draw it, so what it offers is always
 * what the server would list in /help for this character.
 *
 *   Client -> Server: dbo "menuOpen"  (the server answers with the playerMenu widget)
 *   Browser -> Server: dbo:menuRun, dbo:menuClose (forwarded by the relay)
 *
 * Switching character is the one button the server cannot serve: it is a
 * client request for character select, kept here from the old menu.
 */
export class PersonalMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

    this.menuKey = readMenuKeyCode(this.sp, "personalMenuKeyCode", DxScanCode.U);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // The key's scan code, or 256 + the button for a bindable mouse button (mouseKeys.ts); gamepad idCodes alias onto
    // keyboard scancodes and are never a key here
    const code = buttonKeyCode(e);
    if (code === null) return;
    if (code !== this.menuKey || !e.isDown) return;
    if (isMenuKeyPressBlocked(this.sp, this.controller, e)) return;

    logTrace(this, `Requesting the player menu`);
    sendCustomPacket(this.controller, { customPacketType: "dbo", event: "menuOpen", args: [], widget: 0 });
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] !== "dbo:menuSwitchChar") return;
    // Reopens character select in-world; the server parks this body (logout
    // grace) and assigns the picked character, no main-menu round trip.
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: "characterSelectMenuRequest" }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private menuKey: DxScanCode = DxScanCode.U;
}
