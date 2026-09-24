import { Actor, Form, Game, Menu, Shout, TESModPlatform, Utility, once } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { SPELL_ENFORCE_PASSES } from "./remoteServer";
import { getInventory } from "../../sync/inventory";
import { logError, logTrace } from "../../logging";

interface FavoriteEntry { id: number; hotkey: number }
interface FavoritesSnapshot { items: FavoriteEntry[]; spells: FavoriteEntry[] }

// Natives added to TESModPlatform in this fork; the npm typings predate them
const favoriteNatives = TESModPlatform as unknown as {
  setItemFavorite(item: Form | null, hotkey: number): void;
  setSpellFavorite(spellOrShout: Form | null, hotkey: number): void;
};

const HOTKEY_SLOTS = 8;
const SNAPSHOT_EVERY_MS = 30000;
const RESTORE_AFTER_LOGIN_S = Math.max(...SPELL_ENFORCE_PASSES) + 2;
const RETRY_AFTER_S = 5;
// Without a server list, snapshots wait this long past the restore point in case it arrives late
const NO_PACKET_GRACE_S = 8;
const SNAPSHOT_MENUS: string[] = [Menu.Favorites, Menu.Inventory, Menu.Magic];

/**
 * The login rebuild removes and re-adds every item and spell, which drops favorites and hotkeys 1-8.
 * The gamemode stores the last snapshot and sends it back after login; it is re-applied once the
 * rebuild's last spell pass has run, and snapshots resume only after that.
 *
 *   Client -> Server: { customPacketType: "dbo", event: "favorites", args: [{ items, spells }] }
 *   Server -> Client: { customPacketType: "dboFavorites", items, spells }
 *   Entries are { id: base form id, hotkey: 0..7 or -1 }
 */
export class FavoritesService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionDisconnect", () => this.reset());
    this.controller.on("menuClose", (e) => {
      if (SNAPSHOT_MENUS.includes(e.name)) this.snapshotAt = 0;
    });
    this.controller.on("update", () => this.onUpdate());
  }

  private onCreateActorMessage(event: ConnectionMessage<CreateActorMessage>): void {
    if (!event.message.isMe) return;
    const gen = ++this.loginGen;
    this.snapshotsEnabled = false;
    this.restoreReady = false;
    // A respawn rebuilds the inventory too; with no fresh server list the last snapshot is re-applied
    this.pending = this.lastSent;
    // Same clock and start point as the login spell passes, so this always runs after the last one
    once("update", () => {
      Utility.wait(RESTORE_AFTER_LOGIN_S).then(() => {
        if (gen !== this.loginGen) return;
        this.restoreReady = true;
        if (this.pending) return this.restore(gen);
        Utility.wait(NO_PACKET_GRACE_S).then(() => {
          if (gen !== this.loginGen || this.snapshotsEnabled) return;
          if (this.pending) return this.restore(gen);
          this.enableSnapshots();
        });
      });
    });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "dboFavorites") return;
    this.pending = { items: this.parseEntries(content["items"]), spells: this.parseEntries(content["spells"]) };
    // The server's copy is what was last sent, so an unchanged snapshot is not echoed back
    this.lastSent = this.pending;
    if (this.restoreReady && !this.snapshotsEnabled) this.restore(this.loginGen);
  }

  private restore(gen: number): void {
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) return this.enableSnapshots();
    const missing = this.apply(snapshot);
    logTrace(this, "restored", snapshot.items.length + snapshot.spells.length, "favorite(s),", missing.items.length + missing.spells.length, "not present yet");
    Utility.wait(RETRY_AFTER_S).then(() => {
      if (gen !== this.loginGen) return;
      if (missing.items.length + missing.spells.length > 0) this.apply(missing);
      this.enableSnapshots();
    });
  }

  // Returns the entries whose form the player does not have yet
  private apply(snapshot: FavoritesSnapshot): FavoritesSnapshot {
    const missing: FavoritesSnapshot = { items: [], spells: [] };
    const player = Game.getPlayer();
    if (!player) return snapshot;
    try {
      const owned = this.ownedItemIds(player);
      const known = this.knownSpellIds(player);
      for (const e of snapshot.items) {
        const form = owned.has(e.id) ? Game.getFormEx(e.id) : null;
        if (form) favoriteNatives.setItemFavorite(form, e.hotkey);
        else missing.items.push(e);
      }
      for (const e of snapshot.spells) {
        const form = Game.getFormEx(e.id);
        const has = form && (known.has(e.id) || (Shout.from(form) && player.hasSpell(form)));
        if (has) favoriteNatives.setSpellFavorite(form, e.hotkey);
        else missing.spells.push(e);
      }
    } catch (err) {
      logError(this, "restore failed", String(err));
    }
    return missing;
  }

  private onUpdate(): void {
    if (!this.snapshotsEnabled) return;
    const now = Date.now();
    if (now < this.snapshotAt) return;
    this.snapshotAt = now + SNAPSHOT_EVERY_MS;
    const player = Game.getPlayer();
    if (!player || player.isDead()) return;
    try {
      const snapshot = this.snapshot(player);
      if (this.lastSent && JSON.stringify(snapshot) === JSON.stringify(this.lastSent)) return;
      this.lastSent = snapshot;
      sendCustomPacket(this.controller, { customPacketType: "dbo", event: "favorites", args: [snapshot] });
    } catch (err) {
      logError(this, "snapshot failed", String(err));
    }
  }

  private snapshot(player: Actor): FavoritesSnapshot {
    const hotkeys = new Map<number, number>();
    for (let slot = 0; slot < HOTKEY_SLOTS; slot++) {
      const form = Game.getHotkeyBoundObject(slot);
      if (form) hotkeys.set(form.getFormID() >>> 0, slot);
    }
    const hotkeyOf = (id: number): number => hotkeys.get(id) ?? -1;
    const favorited = (ids: Set<number>): FavoriteEntry[] => Array.from(ids)
      .filter((id) => Game.isObjectFavorited(Game.getFormEx(id)))
      .sort((a, b) => a - b)
      .map((id) => ({ id, hotkey: hotkeyOf(id) }));

    const itemIds = this.ownedItemIds(player);
    const spellIds = this.knownSpellIds(player);
    // Shouts cannot be listed, so only the hotkeyed ones are kept
    hotkeys.forEach((_, id) => { if (!itemIds.has(id)) spellIds.add(id); });
    return { items: favorited(itemIds), spells: favorited(spellIds) };
  }

  private ownedItemIds(player: Actor): Set<number> {
    return new Set(getInventory(player).entries.filter((e) => e.count > 0).map((e) => e.baseId >>> 0));
  }

  private knownSpellIds(player: Actor): Set<number> {
    const ids = new Set<number>();
    const add = (source: { getSpellCount(): number; getNthSpell(n: number): Form | null } | null) => {
      if (!source) return;
      for (let i = 0; i < source.getSpellCount(); i++) {
        const spell = source.getNthSpell(i);
        if (spell) ids.add(spell.getFormID() >>> 0);
      }
    };
    add(player);
    add(player.getRace());
    add(player.getLeveledActorBase());
    return ids;
  }

  private parseEntries(raw: unknown): FavoriteEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && typeof e.id === "number")
      .map((e) => ({ id: e.id >>> 0, hotkey: typeof e.hotkey === "number" && e.hotkey >= 0 && e.hotkey < HOTKEY_SLOTS ? e.hotkey : -1 }));
  }

  private enableSnapshots(): void {
    this.snapshotsEnabled = true;
    this.snapshotAt = 0;
  }

  private reset(): void {
    this.loginGen++;
    this.snapshotsEnabled = false;
    this.restoreReady = false;
    this.pending = null;
    this.lastSent = null;
  }

  private loginGen = 0;
  private snapshotsEnabled = false;
  private restoreReady = false;
  private snapshotAt = 0;
  private pending: FavoritesSnapshot | null = null;
  private lastSent: FavoritesSnapshot | null = null;
}
