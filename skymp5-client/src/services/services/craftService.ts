// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { Actor, ContainerChangedEvent, MenuCloseEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { Inventory } from "../../sync/inventory";
import { MsgType } from "../../messages";
import { logTrace, logError } from "../../logging";

type FurnitureId = number;

export class CraftService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
        controller.on('menuClose', (e) => this.onMenuClose(e));
        controller.on('update', () => this.onUpdate());
    }

    // A report nothing arrived to close (a disenchant: the item goes and nothing comes back) is sent once the Crafting Menu
    // has been closed a moment, or once the player has left that furniture, with no result; the gamemode reads it
    // (alchemy.js onCraftUnmatched). The moment lets an item still on its way close the report the usual way
    private onMenuClose(e: MenuCloseEvent) {
        if (e.name === CRAFTING_MENU && this.furnitureStreak.size > 0) this.menuClosedAt = Date.now();
    }

    private onUpdate() {
        if (this.furnitureStreak.size === 0) return;
        const now = Date.now();
        if (now < this.nextCheckAt) return;
        this.nextCheckAt = now + CHECK_EVERY_MS;
        const closed = this.menuClosedAt > 0 && now - this.menuClosedAt >= FLUSH_AFTER_CLOSE_MS;
        if (closed) this.menuClosedAt = 0;
        let seatedAt = 0;
        try {
            const furnitureRef = (this.sp.Game.getPlayer() as Actor).getFurnitureReference();
            seatedAt = furnitureRef ? furnitureRef.getFormID() : 0;
        } catch (e) {
            return;
        }
        for (const furnitureId of Array.from(this.furnitureStreak.keys())) {
            if (closed || furnitureId !== seatedAt) this.sendCraft(furnitureId, 0, closed ? 'menu closed' : 'left the furniture');
        }
    }

    // Sends the report bundled for this furniture, if it holds anything, and forgets it
    private sendCraft(furnitureId: FurnitureId, resultObjectId: number, why: string) {
        const craftInputObjects = this.furnitureStreak.get(furnitureId);
        if (!craftInputObjects || !craftInputObjects.entries.length) {
            this.furnitureStreak.delete(furnitureId);
            return;
        }
        this.furnitureStreak.delete(furnitureId);
        const workbench = localIdToRemoteId(furnitureId);
        if (!workbench) {
            logError(this, `localIdToRemoteId returned 0 for furnitureId`, furnitureId);
            return;
        }

        logTrace(this, `Sending craft (${why}) workbench`, workbench, `resultObjectId`, resultObjectId, `craftInputObjects`, JSON.stringify(craftInputObjects.entries));

        this.controller.emitter.emit("sendMessage", {
            message: {
                t: MsgType.CraftItem,
                data: { workbench, craftInputObjects, resultObjectId },
            },
            reliability: "reliable"
        });
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const oldContainerId = e.oldContainer ? e.oldContainer.getFormID() : 0;
        const newContainerId = e.newContainer ? e.newContainer.getFormID() : 0;
        const baseObjId = e.baseObj ? e.baseObj.getFormID() : 0;
        if (oldContainerId !== 0x14 && newContainerId !== 0x14) {
          return;
        }

        const furnitureRef = (this.sp.Game.getPlayer() as Actor).getFurnitureReference();
        if (!furnitureRef) {
          return;
        }

        const furnitureId = furnitureRef.getFormID();

        if (oldContainerId === 0x14 && newContainerId === 0) {
            let craftInputObjects = this.furnitureStreak.get(furnitureId);
            if (!craftInputObjects) {
                craftInputObjects = { entries: [] };
            }
            craftInputObjects.entries.push({
                baseId: baseObjId,
                count: e.numItems,
            });
            this.furnitureStreak.set(furnitureId, craftInputObjects);
            logTrace(this,
                `Adding baseObjId`, baseObjId.toString(16), `numItems`, e.numItems, `to craft`,
            );
        } else if (oldContainerId === 0 && newContainerId === 0x14) {
            logTrace(this, 'Finishing craft');
            const craftInputObjects = this.furnitureStreak.get(furnitureId);
            if (craftInputObjects && craftInputObjects.entries.length) {
                this.sendCraft(furnitureId, baseObjId, 'item arrived');
            }
        }
    }

    private furnitureStreak = new Map<FurnitureId, Inventory>();
    private menuClosedAt = 0;
    private nextCheckAt = 0;
}

const CRAFTING_MENU = "Crafting Menu";
const CHECK_EVERY_MS = 250;
const FLUSH_AFTER_CLOSE_MS = 500;
