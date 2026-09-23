import { ClientListener, CombinedController, Sp } from "./clientListener";
import { closeWidget, isUiHidden, isGameInputBlocked } from "./widgetMenuUtil";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { FunctionInfo } from "../../lib/functionInfo";
import { ObjectReference, worldPointToScreenPoint } from "skyrimPlatform";
import { logError } from "../../logging";

declare const window: any;

const WIDGET_ID = 38;
const POLL_MS = 100;
// Board top plus a little air; the reach keeps markers to boards the player could walk to now
const HEIGHT_ABOVE_BOARD = 190;
const MAX_DISTANCE = 4000;
// Nat: the letter showed through walls. A board counts only while the player can see it (Actor.hasLOS, re-checked
// every LOS_MS per board), or when standing right at it, where hasLOS can flicker on the board's own mesh
const LOS_MS = 500;
const ALWAYS_SHOW_WITHIN = 300;

interface Marker { x: number; y: number; near: number }

// Module-level so the browser-side widget setter can read it (runtime injection).
let markers: Marker[] = [];
let unread = 0;

// Server -> Client: { customPacketType: "dboMail", unread, boards: [refId, ...] }; floats a letter icon over nearby boards while mail waits
export class BoardMailService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("customPacketMessage", (e) => this.onMailMessage(e));
    this.controller.emitter.on("browserWindowLoaded", () => { this.lastKey = ""; });
  }

  private onMailMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboMail") return;
    unread = Math.max(0, Number(content["unread"]) || 0);
    if (Array.isArray(content["boards"])) this.boards = (content["boards"] as unknown[]).map((x) => Number(x) >>> 0).filter(Boolean);
    this.lastKey = "";
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now - this.lastPollMs < POLL_MS) return;
    this.lastPollMs = now;
    try {
      const next = unread > 0 && !isUiHidden(this.controller) && !isGameInputBlocked(this.sp, this.controller) ? this.visibleMarkers() : [];
      const key = next.map((m) => `${m.x.toFixed(3)},${m.y.toFixed(3)}`).join(";") + `|${unread}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      markers = next;
      if (!markers.length) { closeWidget(this.sp, WIDGET_ID); return; }
      this.sp.browser.executeJavaScript(new FunctionInfo(this.markerWidgetSetter).getText({ markers, unread, WIDGET_ID }));
    } catch (e) {
      if (!this.errorLogged) { this.errorLogged = true; logError(this, `update failed: ${e}`); }
    }
  }

  private visibleMarkers(): Marker[] {
    const player = this.sp.Game.getPlayer();
    if (!player) return [];
    const out: Marker[] = [];
    for (const id of this.boards) {
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (!ref || !ref.is3DLoaded()) continue;
      const distance = player.getDistance(ref);
      if (distance > MAX_DISTANCE) continue;
      if (distance > ALWAYS_SHOW_WITHIN && !this.inSight(player, ref, id)) continue;
      const [p] = worldPointToScreenPoint([ref.getPositionX(), ref.getPositionY(), ref.getPositionZ() + HEIGHT_ABOVE_BOARD]);
      if (!(p[2] > 0 && p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1)) continue;
      out.push({ x: p[0], y: 1 - p[1], near: 1 - distance / MAX_DISTANCE });
    }
    return out;
  }

  private markerWidgetSetter = () => {
    const widget = { type: "mailMarkers", id: WIDGET_ID, markers, unread };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private inSight(player: { hasLOS(r: ObjectReference | null): boolean }, ref: ObjectReference, id: number): boolean {
    const now = Date.now();
    const cached = this.los.get(id);
    if (cached && now - cached.at < LOS_MS) return cached.seen;
    let seen = false;
    try { seen = player.hasLOS(ref); } catch { seen = false; }
    this.los.set(id, { seen, at: now });
    return seen;
  }

  private los = new Map<number, { seen: boolean; at: number }>();
  private boards: number[] = [];
  private lastPollMs = 0;
  private lastKey = "";
  private errorLogged = false;
}
