import { Actor, createText, destroyText, Game, NetImmerse, setTextPos, setTextSize, setTextString, worldPointToScreenPoint } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { remoteIdToLocalId } from "../../view/worldViewMisc";
import { getScreenResolution } from "../../view/formView";

// A countdown over each downed player you can see (Nate, 2026-09-27: "a timer on the player for others to see").
//
// Server -> client: { customPacketType: "dboDowned", list: [{ id: <server actor id>, seconds: <left> }] }, the whole
// list of downed players near you, resent whenever it changes; an empty list clears every timer.
// Drawn like the nametags in formView (head node + 32, in screen space), a line below the name, in red.
const HEAD = "NPC Head [Head]";
const MAX_DISTANCE = 1500;
const LINE_BELOW_NAME_PX = 18;

interface Entry { endsAt: number; textId: number; shown: string }

export class DownedTimerService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboDowned") return;
    const list = Array.isArray(content["list"]) ? content["list"] as Array<{ id: number; seconds: number }> : [];
    const seen = new Set<number>();
    for (const row of list) {
      const id = Number(row && row.id) >>> 0;
      const secs = Number(row && row.seconds);
      if (!id || !Number.isFinite(secs)) continue;
      seen.add(id);
      const cur = this.entries.get(id);
      const endsAt = Date.now() + Math.max(0, secs) * 1000;
      if (cur) cur.endsAt = endsAt; else this.entries.set(id, { endsAt, textId: 0, shown: "" });
    }
    for (const id of Array.from(this.entries.keys())) if (!seen.has(id)) this.drop(id);
  }

  private onUpdate(): void {
    if (this.entries.size === 0) return;
    const player = Game.getPlayer();
    if (!player) return;
    const now = Date.now();
    const res = getScreenResolution();
    for (const [id, e] of Array.from(this.entries.entries())) {
      const left = Math.ceil((e.endsAt - now) / 1000);
      if (left <= -5) { this.drop(id); continue; }
      let actor: Actor | null = null;
      try { actor = Actor.from(Game.getFormEx(remoteIdToLocalId(id))); } catch { actor = null; }
      const visible = !!actor && actor.isDead() && player.getDistance(actor) <= MAX_DISTANCE && player.hasLOS(actor);
      if (!visible || !actor) { this.hide(e); continue; }
      const p = worldPointToScreenPoint([
        NetImmerse.getNodeWorldPositionX(actor, HEAD, false),
        NetImmerse.getNodeWorldPositionY(actor, HEAD, false),
        NetImmerse.getNodeWorldPositionZ(actor, HEAD, false) + 32,
      ])[0];
      if (!p || p[2] <= 0) { this.hide(e); continue; }
      const x = Math.round(p[0] * res.width);
      const y = Math.round((1 - p[1]) * res.height) + LINE_BELOW_NAME_PX;
      const s = Math.max(0, left);
      const text = `Down ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (!e.textId) {
        e.textId = createText(x, y, text, [1, 0.35, 0.3, 0.9]);
        setTextSize(e.textId, 0.45);
        e.shown = text;
      } else {
        setTextPos(e.textId, x, y);
        if (e.shown !== text) { setTextString(e.textId, text); e.shown = text; }
      }
    }
  }

  private hide(e: Entry): void {
    if (e.textId) { try { destroyText(e.textId); } catch { /* gone */ } e.textId = 0; e.shown = ""; }
  }

  private drop(id: number): void {
    const e = this.entries.get(id);
    if (e) this.hide(e);
    this.entries.delete(id);
  }

  private entries = new Map<number, Entry>();
}
