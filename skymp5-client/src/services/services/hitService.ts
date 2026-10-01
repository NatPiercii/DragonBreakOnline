// TODO: refactor this out
import { isHostedByMe, localIdToRemoteId } from "../../view/worldViewMisc";

import { Form, FormType, HitEvent, Weapon } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { Hit } from "../messages/hitMessage";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { HeldWeapon, HitFacts, readStaffDiagRequest, routeHit, StaffShotTrace, STAFF_WEAPON_TYPE } from "./staffHit";

export class HitService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('hit', (e) => this.onHit(e));
        // The staff trace (staffHit.ts): opened by the server, flushed each frame while it holds shots
        controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
        controller.on("update", () => this.staffTrace.flush(Date.now()));
    }

    private onCustomPacketMessage(e: ConnectionMessage<CustomPacketMessage>) {
        const ms = readStaffDiagRequest(parseCustomPacket(e));
        if (ms !== null) this.staffTrace.open(ms, Date.now());
    }

    private onHit(e: HitEvent) {
        // TODO: add more logging in case of 'return'
        const aggressor = e.aggressor.getFormID();
        if (aggressor < 0xff000000 && aggressor !== 0x14) return; // all skymp npcs are FF+

        if (aggressor >= 0xff000000 && !isHostedByMe(aggressor)) {
            return;
        }

        const base = e.target.getBaseObject();
        const type = base?.getType();

        if (type === FormType.Static || type === FormType.MovableStatic) {
            return;
        }

        // A staff hit is reported as its enchantment (staffHit.ts); everything else as before
        const facts = this.readFacts(e);
        const route = routeHit(facts);
        const now = Date.now();

        // prevent double hit that happens for some reason with magic projectiles
        // Keyed per target: area spells hit every target in the same frame
        let deduped = false;
        if (route.kind === "spell" || route.kind === "scroll" || route.kind === "staff") {
            const key = `${aggressor}:${e.target.getFormID()}`;
            const lastHitTime = this.recentMagicHits.get(key);
            if (lastHitTime && now - lastHitTime < this.magicHitDedupMs) {
                deduped = true;
            } else {
                this.recentMagicHits.set(key, now);
                this.pruneRecentMagicHits(now);
            }
        }

        if (this.staffTrace.isOpen(now)) {
            this.staffTrace.record(now, aggressor, e.target.getFormID(), e.projectile ? e.projectile.getFormID() : 0, facts, route, deduped);
        }

        if (deduped || route.kind === "drop") {
            return;
        }

        const hitData = this.getHitData(e);
        if (route.kind === "staff") hitData.source = route.enchId;
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.OnHit, data: hitData },
            reliability: "reliable"
        });
    }

    // The hit's source and the aggressor's hands, as numbers. Native objects expire with the frame, so none is kept.
    private readFacts(e: HitEvent): HitFacts {
        const sp = this.sp;
        const source = e.source;
        const weapon = source ? sp.Weapon.from(source) : null;
        const isSpell = !weapon && !!source && !!sp.Spell.from(source);
        const isScroll = !weapon && !isSpell && !!source && !!sp.Scroll.from(source);
        const isEnchantment = !weapon && !isSpell && !isScroll && !!source && !!sp.Enchantment.from(source);
        const weaponType = weapon ? weapon.getWeaponType() : -1;
        const facts: HitFacts = {
            sourceId: source ? source.getFormID() : 0,
            sourceType: this.typeOf(source),
            isWeapon: !!weapon, isSpell, isScroll, isEnchantment,
            weaponType,
            weaponEnchId: weapon ? this.enchIdOf(weapon) : 0,
            right: null,
            left: null,
        };
        // The hands are read only when they can matter: a staff, an enchantment, or a source the trace looks at
        const staffLike = weapon ? weaponType === STAFF_WEAPON_TYPE : !isSpell && !isScroll;
        if (staffLike) {
            const actor = sp.Actor.from(e.aggressor);
            if (actor) {
                facts.right = this.held(actor.getEquippedWeapon(false));
                facts.left = this.held(actor.getEquippedWeapon(true));
            }
        }
        return facts;
    }

    private held(w: Weapon | null): HeldWeapon | null {
        return w ? { id: w.getFormID(), weaponType: w.getWeaponType(), enchId: this.enchIdOf(w) } : null;
    }

    private enchIdOf(w: Weapon): number {
        const ench = w.getEnchantment();
        return ench ? ench.getFormID() : 0;
    }

    private typeOf(f: Form | null): number {
        try { return f ? f.getType() : 0; } catch (err) { return 0; }
    }

    private getHitData(e: HitEvent): Hit {
        const hitData: Hit = {
            aggressor: localIdToRemoteId(e.aggressor.getFormID()),
            isBashAttack: e.isBashAttack,
            isHitBlocked: e.isHitBlocked,
            isPowerAttack: e.isPowerAttack,
            isSneakAttack: e.isSneakAttack,
            projectile: e.projectile ? e.projectile.getFormID() : 0,
            source: e.source ? e.source.getFormID() : 0,
            target: localIdToRemoteId(e.target.getFormID())
        }
        return hitData;
    }

    private pruneRecentMagicHits(now: number) {
        if (this.recentMagicHits.size <= 64) {
            return;
        }
        this.recentMagicHits.forEach((time, key) => {
            if (now - time >= this.magicHitDedupMs) {
                this.recentMagicHits.delete(key);
            }
        });
    }

    private readonly magicHitDedupMs = 100;
    private recentMagicHits: Map<string, number> = new Map();
    private staffTrace = new StaffShotTrace((line) => {
        sendCustomPacket(this.controller, { customPacketType: "dbo", event: "staffShot", args: [line] });
    });
}
