import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket } from "./customPacketUtil";
import { NetworkingService } from "./networkingService";
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
// Relayed to the server as well, so a stuck player has to do nothing: no launcher build, no Report a Problem, no
// getting the timing right. gamemode.js writes each line to the server log as "[dboDiag] <profile> <line>".
// Lines are buffered from front load, because the interesting ones happen before the connection is up.
const RELAY_EVERY_MS = 5000;
// Until the first packet gets through, try every second: for a stuck player the connection may not last, so the
// buffer has to leave as soon as there is anything to leave on (Worker A: the server hears nothing from
// GroundedPasta after "Logged as").
const RELAY_FIRST_MS = 1000;
const RELAY_MAX_LINES = 40;
const RELAY_MAX_PER_PACKET = 8;
// Only the lines worth a packet: the summaries, the first few DOM events, the load and heartbeat lines, the open dump
const RELAY_WANTED = /^(lag |load |open |overlays |media |page heartbeat |closed,|mousemove #[1-5] |mousedown #[1-5] |click #[1-5] |keydown #[1-5] )/;
// Data\Platform\Logs\dbo-diag-logs.txt
const LOG_NAME = "dbo-diag";
// A page that somehow spammed this must not fill the log or the player's report
const MAX_LINES = 600;
// One beat in five reaches the log, so a beat every 2 s costs a line every 10 s
const BEAT_EVERY = 5;
const BEAT_GAP_MS = 6000;
const GAP_CHECK_MS = 1000;
// A line the CLIENT writes, needing nothing from the page. GroundedPasta's 0.3.62 sessions sent not one page line
// while he could see character select with his slots filled, so client -> page works on his machine and page ->
// client does not. executeJavaScript returns void and browserMessage is the only route back (checked against the
// typings), so there is no way to ask the page anything - but this says plainly whether the page has ever answered.
const CLIENT_LINE_MS = 5000;

export class PageInputDiagService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("tick", () => this.onTick());
    this.countExecuteJavaScript();
  }

  // Counting the calls the client makes into the page is what turns "the page said nothing" into "the client spoke to
  // the page N times and the page never answered". Wrapped once, and failure to wrap is not worth an error: the count
  // simply stays at -1.
  private countExecuteJavaScript(): void {
    try {
      const b = this.sp.browser as unknown as { executeJavaScript: (src: string) => void };
      const original = b.executeJavaScript.bind(this.sp.browser);
      b.executeJavaScript = (src: string) => { this.execCalls++; original(src); };
      this.execCalls = 0;
    } catch (e) {
      this.execCalls = -1;
    }
  }

  // What the client knows on its own, with nothing from the page involved
  private clientLine(): string {
    const since = this.lastAnyMessageAt ? String(Date.now() - this.lastAnyMessageAt) : "-1 never";
    let vis = "?";
    let foc = "?";
    try { vis = String(this.sp.browser.isVisible()); } catch (e) { /* unreadable */ }
    try { foc = String(this.sp.browser.isFocused()); } catch (e) { /* unreadable */ }
    return `client: widget7 open, beats seen ${this.beats}, page messages ${this.anyMessages}, last browserMessage ${since} ms ago, executeJavaScript calls ${this.execCalls}, browser visible=${vis} focused=${foc}`;
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    // Counted before the filter: ANY message from the page proves the channel back works
    this.anyMessages++;
    this.lastAnyMessageAt = Date.now();
    if (e.arguments[0] !== KEY) return;
    const text = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
    this.queueForRelay(text);

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

  // Buffered from front load; sent once there is a connection to send it on
  private queueForRelay(text: string): void {
    if (this.relayed >= RELAY_MAX_LINES) return;
    if (!RELAY_WANTED.test(text)) return;
    if (this.queue.length >= RELAY_MAX_LINES) return;
    this.queue.push(text.slice(0, 400));
  }

  private flushRelay(): void {
    if (!this.queue.length || this.relayed >= RELAY_MAX_LINES) return;
    try {
      if (!this.controller.lookupListener(NetworkingService).isConnected()) return;
    } catch (e) {
      return;   // too early: the service is not up yet
    }
    const room = RELAY_MAX_LINES - this.relayed;
    const lines = this.queue.splice(0, Math.min(RELAY_MAX_PER_PACKET, room));
    this.relayed += lines.length;
    try {
      sendCustomPacket(this.controller, { customPacketType: "dboDiag", lines });
    } catch (e) {
      // Put them back for the next try rather than losing them
      this.relayed -= lines.length;
      this.queue.unshift(...lines);
    }
  }

  // A beat that stops while character select is up is the thing worth catching; tick still runs when update does not
  private onTick(): void {
    const now = Date.now();
    // The client's own line goes in first, so it is in the very first packet even when the page has said nothing
    if ((globalThis as any).__dboCharacterSelectOpen === true && now - this.lastClientLine >= CLIENT_LINE_MS) {
      this.lastClientLine = now;
      if (this.queue.length < RELAY_MAX_LINES) this.queue.push(this.clientLine());
      this.write(this.clientLine());
    }
    const every = this.relayed ? RELAY_EVERY_MS : RELAY_FIRST_MS;
    if (now - this.lastRelay >= every) { this.lastRelay = now; this.flushRelay(); }
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
  private queue: string[] = [];
  private relayed = 0;
  private lastRelay = 0;
  private lastClientLine = 0;
  private anyMessages = 0;
  private lastAnyMessageAt = 0;
  private execCalls = -1;
}
