import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent } from "skyrimPlatform";
import { logTrace } from "../../logging";

// The client half of the page-side diagnostics (skymp5-front src/utils/InputDiag.js and PageHeartbeat.js), for the
// MO2 players sitting at character select with neither mouse nor keyboard (2026-09-28: GroundedPasta, Silanth,
// Vaelis; emma got through on the same versions, so it is specific setups rather than everyone).
//
// It writes what the page reports into skyrim-platform.log, which is what Report a Problem collects, so one report
// carries both halves: what the engine saw (Worker A's native logging) and what the page saw.
//
// It also watches the heartbeat. Mouse and keyboard dying together is what a hung page or renderer looks like, so a
// beat that stops while character select is up is worth a line of its own - that is the difference between "the page
// is dead" and "the page is alive and never being told".
//
// The page uses `diag:page` rather than a `dbo:` key on purpose, so DboRelayService does not forward every line to
// the server as well. Logging only: this sends nothing and changes nothing.

const KEY = "diag:page";
// Data\Platform\Logs\dbo-diag-logs.txt
const LOG_NAME = "dbo-diag";
// A page that somehow spammed this must not fill the log or the player's report
const MAX_LINES = 600;
// One beat in five reaches the log, so a beat every 2 s costs a line every 10 s
const BEAT_EVERY = 5;
const BEAT_GAP_MS = 6000;
const GAP_CHECK_MS = 1000;

export class PageInputDiagService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("tick", () => this.onTick());
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] !== KEY) return;
    const text = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";

    if (text.startsWith("beat ")) {
      this.beats++;
      this.lastBeatAt = Date.now();
      if (this.gapOpen) {
        this.gapOpen = false;
        this.write(`page heartbeat came back after ${Math.round((Date.now() - this.gapStartedAt) / 1000)}s: ${text}`);
      }
      // Every fifth beat, so the log keeps a pulse without being filled by it
      if (this.beats % BEAT_EVERY !== 0) return;
    }

    this.write(text);
  }

  // A beat that stops while character select is up is the thing worth catching; tick still runs when update does not
  private onTick(): void {
    const now = Date.now();
    if (now - this.lastCheck < GAP_CHECK_MS) return;
    this.lastCheck = now;
    if (!this.lastBeatAt || this.gapOpen) return;
    if ((globalThis as any).__dboCharacterSelectOpen !== true) return;
    if (now - this.lastBeatAt < BEAT_GAP_MS) return;
    this.gapOpen = true;
    this.gapStartedAt = this.lastBeatAt;
    this.write(`page heartbeat STOPPED: nothing for ${Math.round((now - this.lastBeatAt) / 1000)}s while character select is open (last beat #${this.beats})`);
  }

  // logTrace goes to printConsole, which is the in-game console and nothing else: EventsApi.cpp says as much ("We
  // still write to the game console as we were doing before spdlog integration"), and spdlog is what writes
  // skyrim-platform.log. Report a Problem collects that file and skse64.log, so a diagnostic logged only with
  // logTrace never reaches a report - which is exactly what GroundedPasta's 0.3.61 report showed: not one diag line
  // in it. writeLogs puts them in Data\Platform\Logs\dbo-diag-logs.txt, which the launcher now collects too.
  private write(text: string): void {
    if (this.lines >= MAX_LINES) return;
    this.lines++;
    const line = text.slice(0, 900);
    logTrace(this, line);
    try {
      (this.sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, line);
    } catch (e) {
      // An older SkyrimPlatform without writeLogs: the console still has it
    }
    if (this.lines === MAX_LINES) logTrace(this, `(page diagnostic stopped after ${MAX_LINES} lines)`);
  }

  private lines = 0;
  private beats = 0;
  private lastBeatAt = 0;
  private lastCheck = 0;
  private gapOpen = false;
  private gapStartedAt = 0;
}
