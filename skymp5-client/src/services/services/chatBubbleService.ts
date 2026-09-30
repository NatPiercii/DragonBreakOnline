import { Actor, createText, destroyText, Game, NetImmerse, setTextColor, setTextPos, setTextSize, setTextString, worldPointToScreenPoint } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { getScreenResolution } from "../../view/formView";
import { BubbleBoard, bubbleSettings, lineHeightPx, readBubblePacket } from "./chatBubblePlan";

// Chat bubbles over the speaker's head for in-character local lines (dboBubble, see chatBubblePlan.ts)
// Placed each frame from the head node like the nametags; only ids are kept across frames

const HEAD = "NPC Head [Head]";
// Head + 32 is the nametag's bar line and the name sits 46 px above it
const ABOVE_NAME_PX = 72;
const LOS_EVERY_MS = 250;
const UNITS_PER_METER = 70;

interface Drawn { ids: number[]; texts: string[] }

// This game's form id for a server actor id: 0x14 for our own, 0 when not loaded
export const speakerLocalId = (serverId: number): number => {
  if (!serverId) return 0;
  try {
    const mine = localIdToRemoteId(0x14, true);
    if (mine && (mine >>> 0) === (serverId >>> 0)) return 0x14;
  } catch { /* no remote server yet */ }
  try {
    return remoteIdToLocalId(serverId >>> 0) || 0;
  } catch {
    return 0;
  }
};

export class ChatBubbleService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const p = readBubblePacket(parseCustomPacket(event));
    if (!p || !bubbleSettings.on) return;
    this.board.add(p, Date.now());
  }

  private onUpdate(): void {
    if (!bubbleSettings.on) {
      if (this.board.size || this.drawn.size) { this.board.clear(); this.hideAll(); }
      return;
    }
    if (!this.board.size && !this.drawn.size) return;
    const now = Date.now();
    this.board.expire(now);
    const player = Game.getPlayer();
    if (!player) { this.hideAll(); return; }
    const res = getScreenResolution();
    const size = bubbleSettings.size;
    const lineH = lineHeightPx(size);
    const live = new Set<number>();
    for (const id of this.board.ids()) {
      const lines = this.board.linesFor(id, now, lineH);
      const actor = this.visibleActor(id, player, now);
      if (!actor || !lines.length) { this.hide(id); continue; }
      const p = worldPointToScreenPoint([
        NetImmerse.getNodeWorldPositionX(actor, HEAD, false),
        NetImmerse.getNodeWorldPositionY(actor, HEAD, false),
        NetImmerse.getNodeWorldPositionZ(actor, HEAD, false) + 32,
      ])[0];
      if (!p || p[2] <= 0 || p[0] < -0.1 || p[0] > 1.1 || p[1] < -0.1 || p[1] > 1.1) { this.hide(id); continue; }
      live.add(id);
      const x = Math.round(p[0] * res.width);
      const anchorY = Math.round((1 - p[1]) * res.height) - ABOVE_NAME_PX;
      this.draw(id, lines.map((l) => ({ ...l, x, y: anchorY - l.up })), size);
    }
    for (const id of Array.from(this.drawn.keys())) if (!live.has(id)) this.hide(id);
  }

  // Loaded, within the line's range and in sight (always for our own lines)
  private visibleActor(serverId: number, player: Actor, now: number): Actor | null {
    const localId = speakerLocalId(serverId);
    if (!localId) return null;
    let actor: Actor | null = null;
    try { actor = localId === 0x14 ? player : Actor.from(Game.getFormEx(localId)); } catch { actor = null; }
    if (!actor) return null;
    if (localId === 0x14) return actor;
    try {
      if (player.getDistance(actor) > (this.board.rangeOf(serverId) + 2) * UNITS_PER_METER) return null;
      const seen = this.los.get(serverId);
      if (!seen || now - seen.at >= LOS_EVERY_MS) this.los.set(serverId, { at: now, ok: player.hasLOS(actor) });
      return this.los.get(serverId)!.ok ? actor : null;
    } catch {
      return null;
    }
  }

  private draw(id: number, lines: Array<{ text: string; color: number[]; alpha: number; x: number; y: number }>, size: number): void {
    const d = this.drawn.get(id) || { ids: [], texts: [] };
    const resize = this.drawnSize !== size;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const color = [l.color[0], l.color[1], l.color[2], 0.95 * l.alpha];
      if (!d.ids[i]) {
        d.ids[i] = createText(l.x, l.y, l.text, color);
        setTextSize(d.ids[i], size);
        d.texts[i] = l.text;
        continue;
      }
      setTextPos(d.ids[i], l.x, l.y);
      setTextColor(d.ids[i], color);
      if (resize) setTextSize(d.ids[i], size);
      if (d.texts[i] !== l.text) { setTextString(d.ids[i], l.text); d.texts[i] = l.text; }
    }
    for (let i = lines.length; i < d.ids.length; i++) { try { destroyText(d.ids[i]); } catch { /* gone */ } }
    d.ids.length = lines.length;
    d.texts.length = lines.length;
    this.drawn.set(id, d);
    this.drawnSize = size;
  }

  private hide(id: number): void {
    const d = this.drawn.get(id);
    if (d) for (const t of d.ids) { try { destroyText(t); } catch { /* gone */ } }
    this.drawn.delete(id);
  }

  private hideAll(): void {
    for (const id of Array.from(this.drawn.keys())) this.hide(id);
    this.los.clear();
  }

  private board = new BubbleBoard();
  private drawn = new Map<number, Drawn>();
  private drawnSize = 0;
  private los = new Map<number, { at: number; ok: boolean }>();
}
