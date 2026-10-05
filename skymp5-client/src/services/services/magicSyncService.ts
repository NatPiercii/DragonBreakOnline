// TODO: refactor this out
import { isHostedByMe, localIdToRemoteId } from "../../view/worldViewMisc";

// @ts-expect-error (TODO: Remove in 2.10.0)
import { SpellCastEvent, ActionEvent, Actor, printConsole, Game, getAnimationVariablesFromActor, ActorAnimationVariables, SpellType, SlotType, EquippedItemType, Spell, Debug, Form } from 'skyrimPlatform'
import { guardedRaceOf } from '../../sync/beastRaces';
import { ClientListener, CombinedController, Sp } from './clientListener';
import { logError, logTrace } from '../../logging';
import { consumeServerCast } from './castSelfService';
import { sendCustomPacket } from './customPacketUtil';
import { SCROLL_FORM_TYPE, ScrollFireTracker } from './scrollFireFallback';

import { MsgType } from "../../messages";
import { SpellCastMsgData, SpellCastMessage } from "../messages/spellCastMessage";
import { UpdateAnimVariablesMessageMsgData } from "../messages/updateAnimVariablesMessage";

// Racial greater powers are disabled on this server (form ids verified against Skyrim.esm on the reference install)
const BLOCKED_POWER_IDS = new Set([
    0x000E40C3, // PowerNordBattleCry
    0x000E40C8, // PowerHighElfMagickaRegen (Highborn)
    0x000E40CA, // PowerImperialPacify (Voice of the Emperor)
    0x000E40CE, // PowerRedguardStaminaRegen (Adrenaline Rush)
    0x000E40CF, // PowerWoodElfCommandAnimal
    0x000E40D4, // PowerDarkElfFlameCloak (Ancestor's Wrath)
    0x000E40D5, // PowerArgonianHistskin
    0x000AA01D, // PowerKhajiitNightEye
    0x000AA022, // PowerBretonAbsorbSpell (Dragonskin)
    0x000AA026, // RaceOrcBerserk (Berserker Rage)
]);

// A relayed cast, tracked per caster and hand until its stop and echoes are sent
interface RelayedCast {
    msg: SpellCastMsgData;
    // The player's remote id has no form view, so the caster is never mapped back from msg.caster
    casterLocalId: number;
    startedMs: number;
    lastKeepAliveMs: number;
    seenCasting: boolean;
    stopEchoAt: number[];
}

// Kept by id: native objects expire each frame
interface ScrollFire {
    casterLocalId: number;
    scrollId: number;
    castingSource: number;
    aimAngle: number;
    aimHeading: number;
}

export class MagicSyncService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("spellCast", (e) => this.onSpellCast(e));
        this.controller.on("actionSpellFire", (e) => this.onActionSpellFire(e));

        const self = this;


        this.sp.hooks.sendAnimationEvent.add({
            enter: (ctx) => { },
            leave: (ctx) => {
                self.onSendAnimationEventLeave(ctx);
            }
        }, this.playerId, this.playerId);
    }

    private onUpdate() {
        this.syncRelayedCasts();
        this.relayDueScrollFires();

        if (this.isAnyMagicStuffEquiped() === false) {
            return;
        }

        if (Date.now() - this.lastSendUpdateAnimationVariables <= this.sendUpdateAnimationVariablesRateMs) {
            return;
        }

        this.lastSendUpdateAnimationVariables = Date.now();

        this.controller.once('update', () => {
            const ac = Game.getPlayer();

            if (!ac || guardedRaceOf(ac)) {
                return;
            }

            const animVariables = this.getAnimationVariablesFromActorConverted(ac.getFormID());

            this.controller.emitter.emit("sendMessage", {
                message: { t: MsgType.UpdateAnimVariables, data: this.getUpdateAnimVariablesEventData(ac, animVariables) },
                reliability: "reliable"
            });
        });

    }

    // A throw in the relay used to stop it in silence, and the server then gave the cast's scroll back (summon scrolls,
    // #bugs 1553254532333445211): say which cast it was
    private onSpellCast(event: SpellCastEvent) {
        try {
            if (event.spell && event.caster && event.spell.getType() === SCROLL_FORM_TYPE && this.isOwnCaster(event.caster.getFormID()) &&
                !this.scrollFires.onPlatformCast(event.caster.getFormID(), event.spell.getFormID())) {
                logTrace(this, "scroll cast already relayed from its fire:", this.describeCast(event));
                return;
            }
            this.relaySpellCast(event);
        } catch (e) {
            logError(this, "spellCast not relayed:", this.describeCast(event), e);
        }
    }

    // The platform's late hand check drops a last scroll's cast (it is used up by then); its fire stands in for it
    private onActionSpellFire(event: ActionEvent) {
        try {
            const source = event.source;
            if (!event.actor || !source || source.getType() !== SCROLL_FORM_TYPE) {
                return;
            }
            const casterLocalId = event.actor.getFormID();
            if (!this.isOwnCaster(casterLocalId)) {
                return;
            }
            const fire: ScrollFire = {
                casterLocalId,
                scrollId: source.getFormID(),
                // The native sends SKSE's slot (0 left, 1 right, 2 voice), not SlotType
                castingSource: Number(event.slot) === 0 ? SpellType.Left : SpellType.Right,
                // The engine's aim (GetAimAngle/GetAimHeading) has no script binding: the caster's facing, degrees to radians
                aimAngle: event.actor.getAngleX() * Math.PI / 180,
                aimHeading: event.actor.getAngleZ() * Math.PI / 180,
            };
            const decision = this.scrollFires.onFire(casterLocalId, fire.scrollId, this.isScrollUsedUp(event.actor, source), fire);
            if (decision === "relay") {
                this.relayScrollFire(fire);
            }
        } catch (e) {
            logError(this, "actionSpellFire not handled:", e);
        }
    }

    private relayDueScrollFires() {
        if (this.scrollFires.size() === 0) {
            return;
        }
        const due = this.scrollFires.takeDue((casterLocalId, scrollId) => {
            const caster = Actor.from(Game.getFormEx(casterLocalId));
            const scroll = Game.getFormEx(scrollId);
            return !!caster && !!scroll && this.isScrollUsedUp(caster, scroll);
        });
        due.forEach((fire) => this.relayScrollFire(fire));
    }

    private isScrollUsedUp(caster: Actor, scroll: Form): boolean {
        return caster.getItemCount(scroll) <= 0;
    }

    // Goes through relaySpellCast, so its early exits apply to a fire as they do to the platform's cast
    private relayScrollFire(fire: ScrollFire) {
        const caster = Actor.from(Game.getFormEx(fire.casterLocalId));
        const scroll = Game.getFormEx(fire.scrollId);
        if (!caster || !scroll) {
            return;
        }
        const event = {
            caster,
            spell: scroll,
            target: undefined,
            isDualCasting: false,
            castingSource: fire.castingSource,
            aimAngle: fire.aimAngle,
            aimHeading: fire.aimHeading,
        } as unknown as SpellCastEvent;
        logTrace(this, "scroll cast relayed from its fire:", this.describeCast(event));
        this.relaySpellCast(event);
    }

    private describeCast(event: SpellCastEvent): string {
        const id = (form: { getFormID(): number } | null | undefined) => {
            try { return form ? form.getFormID().toString(16) : "none"; } catch { return "unreadable"; }
        };
        let type = "?";
        try { type = event.spell ? String(event.spell.getType()) : "none"; } catch { /* unreadable */ }
        return `caster ${id(event.caster)}, spell ${id(event.spell)} (form type ${type})`;
    }

    private relaySpellCast(event: SpellCastEvent) {
        // Blocked racial powers: dispel locally, tell the player, do not relay
        if (event.caster && event.caster.getFormID() === this.playerId &&
            event.spell && BLOCKED_POWER_IDS.has(event.spell.getFormID())) {
            const spellId = event.spell.getFormID();
            this.controller.once('update', () => {
                const player = Game.getPlayer();
                const spell = Spell.from(Game.getFormEx(spellId));
                if (player && spell) {
                    player.dispelSpell(spell);
                }
                Debug.notification("Racial powers are disabled on this server.");
            });
            return;
        }

        // A spell the server asked this client to cast on the player is not the player's cast (castSelfService)
        if (event.spell && event.caster && event.caster.getFormID() === this.playerId && consumeServerCast(event.spell.getFormID())) {
            return;
        }

        // Scrolls are traced until the summon scrolls are understood: whether the event arrives, and what it carries
        if (event.spell && event.spell.getType() === SCROLL_FORM_TYPE && event.caster && event.caster.getFormID() === this.playerId) {
            logTrace(this, "scroll cast relayed:", this.describeCast(event));
        }

        // Clone replays fire this event too, but the server only accepts our own and hosted casters
        const casterLocalId = event.caster.getFormID();
        if (!this.isOwnCaster(casterLocalId)) {
            return;
        }

        const msg: SpellCastMsgData = this.getSpellCastEventData(event, false);
        this.sendSpellCast(msg);

        // The server no longer takes a player's shout word as a cast (review A4-1), so nobody else saw a shout but its
        // animation. The player's own shout goes to the gamemode as well: it checks the word against the shout gate
        // and hands it to the players around, who replay it on our clone (ShoutPushService, dboShoutFx). A shout word
        // arrives from the platform with castingSource kOther, the Voise slot (EventHandler.cpp, 2253ab04).
        if (casterLocalId === this.playerId && msg.castingSource === SpellType.Voise) {
            sendCustomPacket(this.controller, { customPacketType: "dboShoutCast", data: msg });
        }

        const now = Date.now();
        this.relayedCasts.set(this.getCastKey(casterLocalId, msg.castingSource), {
            msg,
            casterLocalId,
            startedMs: now,
            lastKeepAliveMs: now,
            seenCasting: false,
            stopEchoAt: [],
        });
    }

    private isOwnCaster(casterLocalId: number): boolean {
        return casterLocalId === this.playerId || isHostedByMe(casterLocalId);
    }

    private onSendAnimationEventLeave(ctx: { animEventName: string, animationSucceeded: boolean }) {
        const source = this.getEquippedAnimSource(ctx.animEventName);
        if (source === undefined) {
            return;
        }

        // Hook context cannot touch game state, so the stop waits for the next update
        this.controller.once('update', () => {
            const cast = this.relayedCasts.get(this.getCastKey(this.playerId, source));
            if (cast && !this.isCastSourceCasting(cast)) {
                this.sendCastStop(cast);
            }
        });
    }

    // Shared stop path: marks the cast, sends it and arms the echoes
    private sendCastStop(cast: RelayedCast) {
        const msg = cast.msg;
        if (msg.interruptCast) {
            return;
        }
        msg.interruptCast = true;
        msg.keepAlive = false;
        if (Actor.from(Game.getFormEx(cast.casterLocalId))) {
            msg.actorAnimationVariables = this.getAnimationVariablesFromActorConverted(cast.casterLocalId);
        }
        this.sendSpellCast(msg);
        // Echoes cover a keep-alive or cast landing after the stop, client to server reliable is unordered
        const now = Date.now();
        cast.stopEchoAt = this.castStopEchoDelaysMs.map(delay => now + delay);
    }

    private sendSpellCast(msg: SpellCastMsgData) {
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.SpellCast, data: msg },
            reliability: "reliable"
        });
    }

    private isCastSourceCasting(cast: RelayedCast): boolean {
        const ac = Actor.from(Game.getFormEx(cast.casterLocalId));
        // Stowed magic cannot be casting, whatever the anim vars say
        if (!ac || !ac.isWeaponDrawn()) {
            return false;
        }
        const left = ac.getAnimationVariableBool("IsCastingLeft");
        const right = ac.getAnimationVariableBool("IsCastingRight");
        const dual = ac.getAnimationVariableBool("IsCastingDual");
        const spellId = cast.msg.spell;
        // The platform reports a spell held in both hands as right-handed, so either hand counts
        const inBothHands = ac.getEquippedSpell(SpellType.Left)?.getFormID() === spellId
            && ac.getEquippedSpell(SpellType.Right)?.getFormID() === spellId;
        if (dual || inBothHands) {
            return left || right || dual;
        }
        if (cast.msg.castingSource === SpellType.Left) {
            return left;
        }
        return cast.msg.castingSource === SpellType.Right && right;
    }

    private getSpellCastEventData(e: SpellCastEvent, isInterruptCast: boolean): SpellCastMsgData {
        const spellCastData: SpellCastMsgData = {
            caster: localIdToRemoteId(e.caster.getFormID(), true),
            // @ts-expect-error (TODO: Remove in 2.10.0)
            target: e.target ? localIdToRemoteId(e.target.getFormID(), true) : 0,
            spell: e.spell ? e.spell.getFormID() : 0,
            interruptCast: isInterruptCast,
            keepAlive: false,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            isDualCasting: e.isDualCasting,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            castingSource: e.castingSource,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimAngle: e.aimAngle,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimHeading: e.aimHeading,
            actorAnimationVariables: this.getAnimationVariablesFromActorConverted(e.caster.getFormID()),
        }
        return spellCastData;
    }

    private getAnimationVariablesFromActorConverted(actorId: number) {
        // A beast or other non-humanoid caster sends none: the native reads at the humanoid graph's indexes, past the end
        // of its graph, and a watcher would write that into its copy (sync/beastRaces.ts)
        if (guardedRaceOf(Actor.from(Game.getFormEx(actorId)))) {
            return { booleans: [] as number[], floats: [] as number[], integers: [] as number[] };
        }
        const animVars = getAnimationVariablesFromActor(actorId);
        const booleans: ArrayBuffer = animVars.booleans;
        const floats: ArrayBuffer = animVars.floats;
        const integers: ArrayBuffer = animVars.integers;
        return {
            booleans: Array.from(new Uint8Array(booleans)),
            floats: Array.from(new Uint8Array(floats)),
            integers: Array.from(new Uint8Array(integers)),
        }
    }

    private getUpdateAnimVariablesEventData(ac: Actor, animVariables: ActorAnimationVariables): UpdateAnimVariablesMessageMsgData {
        const animVarsData: UpdateAnimVariablesMessageMsgData = {
            actorRemoteId: localIdToRemoteId(ac.getFormID(), true),
            actorAnimationVariables: animVariables,
        }
        return animVarsData;
    }

    // Concentration release fires no event, so each relayed cast polls its hand for the stop and keep-alives
    private syncRelayedCasts() {
        const now = Date.now();
        for (const [key, cast] of Array.from(this.relayedCasts)) {
            const msg = cast.msg;
            const casting = this.isCastSourceCasting(cast);
            if (!msg.interruptCast) {
                cast.seenCasting = cast.seenCasting || casting;
                // Casting vars can lag the cast event, so a hand never seen casting gets a grace period
                if (!casting && (cast.seenCasting || now - cast.startedMs > this.castStartGraceMs)) {
                    this.sendCastStop(cast);
                } else if (casting && now - cast.lastKeepAliveMs > this.castKeepAliveRateMs) {
                    // Keep-alive while channeling so the server channel and observer clones can time out a lost stop
                    cast.lastKeepAliveMs = now;
                    msg.keepAlive = true;
                    this.sendSpellCast(msg);
                }
                continue;
            }
            if (casting) {
                // The hand is casting again and its next cast event replaces this record
                cast.stopEchoAt = [];
            } else if (cast.stopEchoAt.length > 0 && now >= cast.stopEchoAt[0]) {
                cast.stopEchoAt.shift();
                this.sendSpellCast(msg);
            }
            if (cast.stopEchoAt.length === 0) {
                this.relayedCasts.delete(key);
            }
        }
    }

    private getCastKey(casterLocalId: number, castingSource: number): string {
        return `${casterLocalId}:${castingSource}`;
    }

    private getEquippedAnimSource(animEventName: string): number | undefined {
        const eventName = animEventName.toLowerCase();
        if (eventName === "mlh_equipped_event") {
            return SpellType.Left;
        }
        if (eventName === "mrh_equipped_event") {
            return SpellType.Right;
        }
        return undefined;
    }

    private isSpellCastAnim(animEventName: string): boolean {
        const eventName = animEventName.toLowerCase();

        const isSpellCastAnimForLeftHand = eventName === "mlh_spellaimedconcentrationstart" || eventName === "mlh_spellaimedstart" || eventName === "mlh_spellready_event" ||
            eventName === "mlh_spellrelease_event" || eventName === "mlh_equipped_event";

        const isSpellCastAnimForRightHand = eventName === "mrh_spellaimedconcentrationstart" || eventName === "mrh_spellaimedstart" || eventName === "mrh_spellready_event" ||
            eventName === "mrh_spellrelease_event" || eventName === "mrh_equipped_event";

        return isSpellCastAnimForLeftHand || isSpellCastAnimForRightHand;
    };

    private isAnyMagicStuffEquiped(): boolean {
        const ac = Game.getPlayer();

        if (!ac) {
            return false;
        }

        if (ac.getEquippedSpell(SpellType.Left) || ac.getEquippedSpell(SpellType.Right)) {
            return true;
        }

        if (ac.getEquippedSpell(SpellType.Voise) || ac.getEquippedSpell(SpellType.Instant)) {
            return true;
        }

        const leftHandEquipmentType = ac.getEquippedItemType(SlotType.Left);
        const rightHandEquipmentType = ac.getEquippedItemType(SlotType.Right);

        if (leftHandEquipmentType === 9 || leftHandEquipmentType === EquippedItemType.Staff ||
            rightHandEquipmentType === 9 || rightHandEquipmentType === EquippedItemType.Staff) {
            return true;
        }

        return false;
    }

    private playerId = 0x14;
    private sendUpdateAnimationVariablesRateMs = 500;
    private castKeepAliveRateMs = 3000;
    private castStartGraceMs = 250;
    private readonly castStopEchoDelaysMs = [1000, 3500];
    private relayedCasts = new Map<string, RelayedCast>();
    private scrollFires = new ScrollFireTracker<ScrollFire>();
    private lastSendUpdateAnimationVariables: number = 0;
}
