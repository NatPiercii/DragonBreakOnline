import { ClientListener, CombinedController, Sp } from "./clientListener";

// The front sizes itself to the screen on its own (utils/UiScale.js). This only
// carries the launcher's override across, for players who want the widgets
// bigger or smaller than the automatic choice. uiScale 0 or absent means auto.

export class UiScaleService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("browserWindowLoaded", () => this.push());
    this.controller.once("update", () => this.push());
  }

  private push() {
    const scale = this.readSetting();
    try {
      this.sp.browser.executeJavaScript(
        `if (window.dboSetUiScale) window.dboSetUiScale(${scale});`,
      );
    } catch {
      // the front applies its automatic scale without us
    }
  }

  private readSetting(): number {
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      const raw = settings ? Number(settings["uiScale"]) : 0;
      if (raw > 0 && raw <= 3) {
        return raw;
      }
    } catch {
      // fall through to automatic
    }
    return 0;
  }
}
