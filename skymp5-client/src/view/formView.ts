import { Actor, ActorBase, createText, destroyText, EffectShader, Faction, Form, FormType, Game, Keyword, NetImmerse, ObjectReference, once, printConsole, setTextPos, setTextSize, setTextString, storage, TESModPlatform, Utility, worldPointToScreenPoint } from "skyrimPlatform";
import { setDefaultAnimsDisabled, applyAnimation, restoreSitCollisionIfMoving, isInSitPose, clearSitPose, setRefrCollision } from "../sync/animation";
import { Appearance, applyAppearance } from "../sync/appearance";
import { isBadMenuShown, applyEquipment } from "../sync/equipment";
import { RespawnNeededError } from "../lib/errors";
import { FormModel } from "./model";
import { applyMovement, settleTranslation } from "../sync/movementApply";
import { driftConfig } from "../sync/driftConfig";
import { Movement } from "../sync/movement";
import { SpawnProcess } from "./spawnProcess";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { PlayerCharacterDataHolder } from "./playerCharacterDataHolder";
import { lastTryHost, tryHost } from "./hostAttempts";
import { GHOST_ALPHA, GHOST_SHADER_ID } from "../lib/ghostLook";
import { ModelApplyUtils } from "./modelApplyUtils";
import { localIdToRemoteId } from "./worldViewMisc";
import { SpApiInteractor } from "../services/spApiInteractor";
import { WorldCleanerService } from "../services/services/worldCleanerService";
import { GamemodeUpdateService } from "../services/services/gamemodeUpdateService";
import { isOwnCompanion, isAnyCompanion } from "../services/services/companionService";
import { sendCustomPacket } from "../services/services/customPacketUtil";

export interface ScreenResolution {
  width: number;
  height: number;
}

type AdminView = "visible" | "hidden" | "ghost";

// A copy nobody drives this far from where the server holds it is re-seated, not left standing there
const STRANDED_UNITS = 512;
// Werewolf (Skyrim 0CDD84) and Vampire Lord (Dawnguard 00283A). A watcher crashed updating a remote werewolf's
// behaviour graph one second after the race swap respawned it; the new copy's first moments are left alone
const BEAST_RACE_IDS = new Set([0x000cdd84, 0x0200283a]);
const BEAST_SPAWN_SETTLE_MS = 1500;
// A hosted copy this far from the server position has its updates refused, so it is snapped back
const RESYNC_UNITS = 3000;

let _screenResolution: ScreenResolution | undefined;
export const getScreenResolution = (): ScreenResolution => {
  if (!_screenResolution) {
    _screenResolution = {
      width: Utility.getINIInt("iSize W:Display"),
      height: Utility.getINIInt("iSize H:Display"),
    }
  }
  return _screenResolution;
}

export class FormView {
  constructor(private remoteRefrId?: number) { }

  update(model: FormModel): void {
    // Other players mutate into PC clones when moving to another location
    if (model.movement) {
      if (!this.lastWorldOrCell)
        this.lastWorldOrCell = model.movement.worldOrCell;
      if (this.lastWorldOrCell !== model.movement.worldOrCell) {
        printConsole(
          `[1] worldOrCell changed, destroying FormView ${this.lastWorldOrCell.toString(
            16
          )} => ${model.movement.worldOrCell.toString(16)}`
        );
        this.lastWorldOrCell = model.movement.worldOrCell;
        this.destroy();
        this.refrId = 0;
        this.appearanceBasedBaseId = 0;
        return;
      }
    }



    // Dead players stay hidden until they respawn; NPC corpses spawn and are killed on the first apply
    if (model.isDead && this.refrId === 0 && model.appearance) {
      return;
    }

    // Players with different worldOrCell should be invisible
    if (model.movement) {
      const worldOrCell = ObjectReferenceEx.getWorldOrCell(Game.getPlayer() as Actor);
      if (
        worldOrCell !== 0 &&
        model.movement.worldOrCell !== worldOrCell
      ) {
        this.destroy();
        this.refrId = 0;
        return;
      }
    }

    // Apply appearance before base form selection to prevent double-spawn
    if (model.appearance || (!model.appearance && this.appearanceState.appearance)) {
      if (
        !this.appearanceState.appearance ||
        model.numAppearanceChanges !== this.appearanceState.lastNumChanges
      ) {

        // Both non-null
        if (model.appearance && this.appearanceState.appearance) {
          const modelAppearanceCopy: Appearance = JSON.parse(JSON.stringify(model.appearance));
          const stateAppearanceCopy: Appearance = JSON.parse(JSON.stringify(this.appearanceState.appearance));
          modelAppearanceCopy.name = "";
          stateAppearanceCopy.name = "";
          const equalWithoutNames = JSON.stringify(modelAppearanceCopy) === JSON.stringify(stateAppearanceCopy);

          if (equalWithoutNames) {
            // Change name inplace
            const refr = ObjectReference.from(Game.getFormEx(this.refrId));
            refr?.getBaseObject()?.setName(model.appearance.name);
            refr?.setDisplayName(model.appearance.name, true);
            // Recreate the floating tag so watchers see the new name (/mask)
            this.removeNickname();
            //printConsole("Appearance updated, changing name inplace");
          } else {
            // Force re-apply appearance on the next getAppearanceBasedBase call
            this.appearanceBasedBaseId = 0;
            //printConsole("Appearance updated");
          }
        } else {
          // Force re-apply appearance on the next getAppearanceBasedBase call
          this.appearanceBasedBaseId = 0;
          //printConsole("Appearance updated");
        }

        this.appearanceState.appearance = model.appearance || null;
        this.appearanceState.lastNumChanges = model.numAppearanceChanges as number;
      }
    }

    const refId =
      model.refrId && model.refrId < 0xff000000 ? model.refrId : undefined;
    if (refId) {
      if (this.refrId !== refId) {
        this.destroy();
        this.refrId = model.refrId as number;
        this.ready = true;
        // dealWithRef waits in applyAll until the ref exists (spawn, teleport: cells attach after the server streams them)
        this.dealtWithRef = false;
      }
    } else {
      let templateChain = model.templateChain;

      // There is no place for random/leveling in 1-sized chain
      // Just spawn an NPC, do not generate a temporary TESNPC form
      if (templateChain?.length === 1) {
        templateChain = undefined;
      }

      // TODO: getLeveledBase crashes too often ATM
      let base = null; //Game.getFormEx(this.getLeveledBase(templateChain));
      if (base === null) {
        base = Game.getFormEx(model.baseId || NaN);
      }
      if (base === null) {
        base = Game.getFormEx(this.getAppearanceBasedBase());
      }
      if (base === null) {
        return;
      }

      let refr = ObjectReference.from(Game.getFormEx(this.refrId));

      let respawnRequired = false;
      if (!refr) {
        respawnRequired = true;
      } else if (!refr.getBaseObject()) {
        respawnRequired = true;
      } else if ((refr.getBaseObject() as Form).getFormID() !== base.getFormID()) {
        respawnRequired = true;
      }

      if (respawnRequired) {
        this.destroy();

        const player = Game.getPlayer() as Actor;

        const spawnMethodOriginal = {
          spawn(baseForm: Form, _spawnPosition: [number, number, number], _spawnRotation: [number, number, number]): ObjectReference {
            return player.placeAtMe(
              baseForm,
              1,
              true,
              true
            ) as ObjectReference;
          },

          triggerSpawnProcess(spawningRefr: ObjectReference, spawnPosition: [number, number, number], appearance: Appearance | null, callback: () => void) {
            new SpawnProcess(
              appearance,
              spawnPosition,
              spawningRefr.getFormID(),
              callback
            );
          }
        };

        const spawnMethodStub = {
          spawn(baseForm: Form, spawnPosition: [number, number, number], spawnRotation: [number, number, number]): ObjectReference {
            const f = storage["formViewFunc1"] as Function;
            const ref: ObjectReference = f(baseForm, spawnPosition, spawnRotation);
            return ref;
          },

          triggerSpawnProcess(spawningRefr: ObjectReference, spawnPosition: [number, number, number], appearance: Appearance | null, callback: () => void) {
            const f = storage["formViewFunc2"] as Function;
            f(spawningRefr, spawnPosition, appearance, callback);
          }
        };

        const spawnUsingStubMethod = base.getType() === FormType.NPC
          && !this.appearanceState.appearance
          && storage["formViewFunc1Set"] === true
          && storage["formViewFunc2Set"] === true;
        const spawnMethod = spawnUsingStubMethod ? spawnMethodStub : spawnMethodOriginal;

        if (model.movement) {
          refr = spawnMethod.spawn(base, model.movement.pos, model.movement.rot);
        } else {
          printConsole("model.movement was " + model.movement);
        }

        this.state = {};
        delete this.wasHostedByOther;
        if (base.getType() !== FormType.NPC) {
          refr?.setAngle(
            model.movement?.rot[0] || 0,
            model.movement?.rot[1] || 0,
            model.movement?.rot[2] || 0
          );
        } else {
          const actor = Actor.from(refr);
          if (actor) {
            this.applyFactions(actor, model);
            this.applyOutfit(actor, model);
            this.applyHostility(actor, model);
          }
        }

        if (refr !== null) {
          SpApiInteractor.getControllerInstance().lookupListener(WorldCleanerService).modWcProtection(refr.getFormID(), 1);
        }

        // TODO: reset all states?
        this.eqState = this.getDefaultEquipState();
        this.animState = this.getDefaultAnimState();

        this.ready = false;

        let spawnPos;
        if (model.movement) {
          spawnPos = model.movement.pos;
          // printConsole("Spawn NPC at movement.pos");
        } else {
          spawnPos = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
          printConsole("Spawn NPC at player pos");
        }

        if (refr) {
          spawnMethod.triggerSpawnProcess(refr, spawnPos, model.appearance || null, () => {
            this.ready = true;
            this.spawnMoment = Date.now();
          });
        } else {
          printConsole("Unable to triggerSpawnProcess for null refr");
        }

        if (model.appearance && model.appearance.name) {
          refr?.setDisplayName("" + model.appearance.name, true);
        }
        Actor.from(refr)?.setActorValue("attackDamageMult", 0);
      }
      this.refrId = (refr as ObjectReference).getFormID();
    }

    if (!this.ready) {
      return;
    }

    const refr = ObjectReference.from(Game.getFormEx(this.refrId));
    if (refr) {
      const actor = Actor.from(refr);
      if (actor && !this.localImmortal) {
        actor.startDeferredKill();
        actor.setActorValue("health", 1000000);
        actor.setActorValue("magicka", 1000000);
        this.localImmortal = true;
      }
      if (actor && !refId) {
        this.applyFactions(actor, model);
        this.applyOutfit(actor, model);
        this.applyHostility(actor, model);
      }
      this.applyAll(refr, model);

      const gamemodeUpdateService = SpApiInteractor.getControllerInstance().lookupListener(GamemodeUpdateService);
      gamemodeUpdateService.updateNeighbor(refr, model, this.state);
    }
  }

  destroy(): void {
    this.isOnScreen = false;
    this.lastNiNodeUpdateMs = 0;
    this.spawnMoment = 0;
    this.dealtWithRef = false;
    const refrId = this.refrId;
    const remoteRefrId = this.remoteRefrId;
    if (remoteRefrId) {
      const rawAll = storage["allCompanionIds"];
      if (Array.isArray(rawAll) && rawAll.includes(remoteRefrId)) {
        storage["allCompanionIds"] = rawAll.filter((id) => id !== remoteRefrId);
      }
    }
    once("update", () => {
      if (refrId >= 0xff000000) {
        const refr = ObjectReference.from(Game.getFormEx(refrId));
        if (refr) {
          refr.delete();
        }
        SpApiInteractor.getControllerInstance().lookupListener(WorldCleanerService).modWcProtection(refrId, -1);
        const ac = Actor.from(refr);
        if (ac) {
          TESModPlatform.setWeaponDrawnMode(ac, -1);
        }
      }
    })

    this.localImmortal = false;
    this.hostilityApplied = false;
    this.aggressionBeforeRaise = undefined;
    this.factionsSeen = "";
    this.outfitSeen = "";
    this.adminView = "visible";
    this.adminShaderOn = false;
    this.adminShaderReplayAt = 0;
    this.movState.havokSeated = false;
    this.removeNickname();
  }

  private lastHarvestedApply = 0;
  private lastOpenApply = 0;
  private dealtWithRef = false;
  private isSetNodeTextureSetApplied = false;
  private isSetNodeScaleApplied = false;

  private applyAll(refr: ObjectReference, model: FormModel) {
    let forcedWeapDrawn: boolean | null = null;

    if (PlayerCharacterDataHolder.getCrosshairRefId() === this.refrId) {
      this.lastHarvestedApply = 0;
      this.lastOpenApply = 0;
    }
    const now = Date.now();
    if (now - this.lastHarvestedApply > 666) {
      this.lastHarvestedApply = now;
      ModelApplyUtils.applyModelIsHarvested(refr, !!model.isHarvested);
    }
    if (!this.dealtWithRef) {
      const base = refr.getBaseObject();
      if (base) {
        ObjectReferenceEx.dealWithRef(refr, base);
        this.dealtWithRef = true;
      }
    }
    if (now - this.lastOpenApply > 133) {
      this.lastOpenApply = now;
      ModelApplyUtils.applyModelIsOpen(refr, !!model.isOpen);
      // A reloaded cell recreates the ref without its activation block, so doors would open locally again
      if (!refr.isActivationBlocked()) {
        const base = refr.getBaseObject();
        if (base && ObjectReferenceEx.wantsActivationBlock(base)) {
          refr.blockActivation(true);
        }
      }
    }
    if (!this.isSetNodeScaleApplied) {
      this.isSetNodeScaleApplied = true;
      ModelApplyUtils.applyModelNodeScale(refr, model.setNodeScale);
    }
    if (!this.isSetNodeTextureSetApplied) {
      this.isSetNodeTextureSetApplied = true;
      ModelApplyUtils.applyModelNodeTextureSet(refr, model.setNodeTextureSet);
    }

    if (
      model.inventory &&
      PlayerCharacterDataHolder.getCrosshairRefId() == this.refrId &&
      !isBadMenuShown()
    ) {
      // Do not let actors breaking their equipment via inventory apply
      // However, actually, actors do not have inventory in their models
      // Except your clone.
      if (!Actor.from(refr)) {
        ModelApplyUtils.applyModelInventory(refr, model.inventory);
        model.inventory = undefined;
      }
    }

    if (model.animation) {
      if (model.animation.animEventName === "SkympFakeUnequip") {
        forcedWeapDrawn = false;
      } else if (model.animation.animEventName === "SkympFakeEquip") {
        forcedWeapDrawn = true;
      }
    }

    // TODO: make host service
    const hosted = storage['hosted'];
    let alreadyHosted = false;
    if (Array.isArray(hosted)) {
      const remoteId = localIdToRemoteId(this.refrId);

      if (hosted.includes(remoteId) || hosted.includes(remoteId + 0x100000000)) {
        alreadyHosted = true;
      }
    }
    setDefaultAnimsDisabled(this.refrId, alreadyHosted ? false : true);

    const ac = Actor.from(refr);
    if (refr.is3DLoaded()) {
      if (!this.movState.havokSeated) {
        this.movState.havokSeated = true;
        settleTranslation(refr);
        setRefrCollision(this.refrId, true);
        if (ac && !isOwnCompanion(this.remoteRefrId)) {
          ac.clearKeepOffsetFromActor();
          this.movState.offsetApplied = false;
          ac.setPosition(ac.getPositionX(), ac.getPositionY(), ac.getPositionZ());
          ac.evaluatePackage();
        }
      }
      if (alreadyHosted && ac) {
        if (!this.movState.weapReleased) {
          TESModPlatform.setWeaponDrawnMode(ac, -1);
          this.movState.weapReleased = true;
        }
        if (isInSitPose(this.refrId)) {
          clearSitPose(this.refrId);
          setRefrCollision(this.refrId, true);
        }
      }
    } else {
      this.movState.havokSeated = false;
      this.movState.weapReleased = false;
    }

    if (!model.isHostedByOther && !alreadyHosted && !isOwnCompanion(this.remoteRefrId)) {
      if (ac && this.remoteRefrId) {
        this.tryHostIfNeed(ac, this.remoteRefrId, model.movement?.worldOrCell);
      }
    }

    if (model.movement) {
      let ac = Actor.from(refr);
      // The server hands a host over only after 2 s of silence, so a silent host is timed from its last packet
      // A player's own actor can never be taken over, so it keeps the old clock
      const packetClock = model.isHostedByOther && !model.appearance && driftConfig.rehostClock === "packet";
      const hostSilent = packetClock
        ? !!model.movementAt && Date.now() - model.movementAt > driftConfig.rehostAfterMs
        : !!this.movState.lastApply && Date.now() - this.movState.lastApply > 1500;
      if (hostSilent) {
        if (Date.now() - this.movState.lastRehost > (packetClock ? 2000 : 1000)) {
          this.movState.lastRehost = Date.now();
          const remoteId = this.remoteRefrId;
          if (ac && ac.is3DLoaded()) {
            this.tryHostIfNeed(ac, remoteId as number, model.movement?.worldOrCell);
            printConsole("tryHostIfNeed - reason: not seeing movement for long time");
          }
        }
      }

      const isNewMovement = +(model.numMovementChanges as number) !== this.movState.lastNumChanges;
      if (isNewMovement || Date.now() - this.movState.lastApply > 2000) {
        this.movState.lastApply = Date.now();
        // Nobody drives it yet: seat it on its spot without the collision-off slide, our AI takes it once hosted
        // A copy born on the spawn anchor, which is usually a player, stays there once everApplied is set
        // Nobody may drive it: not hosted here, not hosted elsewhere, and not one of our own companions
        const strandedFromServer = this.movState.everApplied && ac && !model.isDead
          && !alreadyHosted && !isOwnCompanion(this.remoteRefrId)
          && ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(refr), model.movement.pos) > STRANDED_UNITS;
        if (!model.isHostedByOther && (!this.movState.everApplied || strandedFromServer) && ac && !model.isDead) {
          const m = model.movement;
          try {
            if (ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(refr), m.pos) > 16) {
              refr.setPosition(m.pos[0], m.pos[1], m.pos[2]);
            }
            setRefrCollision(this.refrId, true);
            refr.setAngle(0, 0, m.rot[2]);
          } catch { /* not loaded yet, the next pass seats it */ }
          this.movState.lastNumChanges = +(model.numMovementChanges as number);
          this.movState.everApplied = true;
        } else if (model.isHostedByOther || !this.movState.everApplied) {
          const backup = model.movement.isWeapDrawn;
          const isDeadBackup = model.movement.isDead;
          if (forcedWeapDrawn === true || forcedWeapDrawn === false) {
            model.movement.isWeapDrawn = forcedWeapDrawn;
          }
          // The server's death state wins over a host that never saw the death
          if (model.isDead) {
            model.movement.isDead = true;
          }
          try {
            // A sender silent for 2 s (paused game, Steam overlay) settles at the copy's own height instead of running in place or hanging mid-air
            const movement: Movement = isNewMovement || !this.movState.everApplied || !ac
              ? model.movement
              : { ...model.movement, runMode: "Standing", isInJumpState: false, pos: [model.movement.pos[0], model.movement.pos[1], refr.getPositionZ()] };
            applyMovement(refr, movement, !!model.isMyClone);
            this.movState.offsetApplied = true;
            restoreSitCollisionIfMoving(refr, movement);
          } catch (e) {
            if (e instanceof RespawnNeededError) {
              this.lastWorldOrCell = model.movement.worldOrCell;
              this.destroy();
              this.refrId = 0;
              this.appearanceBasedBaseId = 0;
              return;
            } else {
              throw e;
            }
          } finally {
            model.movement.isWeapDrawn = backup;
            model.movement.isDead = isDeadBackup;
          }

          this.movState.lastNumChanges = +(model.numMovementChanges as number);
          this.movState.everApplied = true;
        } else {
          const remoteId = this.remoteRefrId;
          if (ac && remoteId && ac.is3DLoaded()) {
            // The server drops a hosted actor's movement once it disagrees by a cell width and never
            // corrects it, after which every hit on that actor is refused as too distant, forever.
            // Snapping our copy back to the server's position lets the next update be accepted again.
            if (model.movement && !isOwnCompanion(remoteId)
              && ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(refr), model.movement.pos) > RESYNC_UNITS) {
              const m = model.movement;
              refr.setPosition(m.pos[0], m.pos[1], m.pos[2]);
              setRefrCollision(this.refrId, true);
              printConsole(`dbo: resynced hosted ${remoteId.toString(16)} to the server position`);
            }
            // The server no longer drives this copy, so its last translateTo must not keep running.
            // Own companions are exempt: CompanionService drives a stuck one with its own translations.
            if (!isOwnCompanion(remoteId)) {
              settleTranslation(ac);
            }

            if (this.movState.offsetApplied && !isOwnCompanion(remoteId)) {
              ac.clearKeepOffsetFromActor();
              this.movState.offsetApplied = false;
            }

            // TODO: make host service
            const hosted = storage['hosted'];
            let alreadyHosted = false;
            if (Array.isArray(hosted) && remoteId) {
              if (hosted.includes(remoteId) || hosted.includes(remoteId + 0x100000000)) {
                alreadyHosted = true;
              }
            }

            if (!alreadyHosted && remoteId) {
              if (this.tryHostIfNeed(ac, remoteId, model.movement?.worldOrCell)) {

                // previously, we did this cleanup on each update
                // but I guess it's too expensive and can possibly hurt FPS
                TESModPlatform.setWeaponDrawnMode(ac, -1);
              }
            }
          }
        }
      }
    }

    // Hosts skip applyMovement, so a copy still standing after the server's death is killed here
    if (model.isDead) {
      const ac = Actor.from(refr);
      if (ac && !ac.isDead()) {
        SpApiInteractor.getControllerInstance().emitter.emit("applyDeathStateEvent", { actor: ac, isDead: true });
      }
    }

    if (refr.is3DLoaded() && !this.isSettlingBeast(model)) {
      if (model.animation) {
        if (alreadyHosted) {
          // The server echoes our own AI's animations back; replaying them restarts swings and can turn collision off
          this.animState.lastNumChanges = model.animation.numChanges;
        } else {
          applyAnimation(refr, model.animation, this.animState);
        }
      }
      // Use them only once, for spawning actors with correct animations
      this.animState.useAnimOverrides = false;
    }

    this.applyAdminInvisibility(refr, model);


    if (model.appearance) {
      const actor = Actor.from(refr);
      if (actor && !PlayerCharacterDataHolder.isInJumpState()) {
        if (PlayerCharacterDataHolder.getWorldOrCell()) {
          if (
            this.lastPcWorldOrCell &&
            PlayerCharacterDataHolder.getWorldOrCell() !== this.lastPcWorldOrCell
          ) {
            // Redraw tints if PC world/cell changed
            this.isOnScreen = false;
            this.lastNiNodeUpdateMs = 0;
          }
          this.lastPcWorldOrCell = PlayerCharacterDataHolder.getWorldOrCell();
        }

        const headPos = [
          NetImmerse.getNodeWorldPositionX(actor, "NPC Head [Head]", false),
          NetImmerse.getNodeWorldPositionY(actor, "NPC Head [Head]", false),
          NetImmerse.getNodeWorldPositionZ(actor, "NPC Head [Head]", false),
        ];
        const [screenPoint] = worldPointToScreenPoint(headPos);
        const isOnScreen =
          screenPoint[0] > 0 &&
          screenPoint[1] > 0 &&
          screenPoint[2] > 0 &&
          screenPoint[0] < 1 &&
          screenPoint[1] < 1 &&
          screenPoint[2] < 1;
        if (isOnScreen != this.isOnScreen) {
          this.isOnScreen = isOnScreen;
          // Never on a beast copy: the queued 3D reset holds a raw actor pointer and the beast graph is the one that crashed
          if (isOnScreen && !this.isBeastCopy(model) && Date.now() - this.lastNiNodeUpdateMs >= FormView.niNodeUpdateMinIntervalMs) {
            this.lastNiNodeUpdateMs = Date.now();
            actor.queueNiNodeUpdate();
            // The rebuilt 3D drops effect shaders
            if (this.adminShaderOn) {
              this.adminShaderReplayAt = this.lastNiNodeUpdateMs + FormView.adminShaderReplayDelayMs;
            }
          }
        }
      }
    }

    if (model.equipment) {
      if (this.eqState.lastNumChanges !== model.equipment.numChanges) {
        const ac = Actor.from(refr);
        // If we do not block inventory here, we will be able to reproduce the bug:
        // 1. Place ~90 bots and force them to reequip iron swords to the left hand (rate should be ~50ms)
        // 2. Open your inventory and reequip different items fast
        // 3. After 1-2 minutes close your inventory and see that HUD disappeared
        if (
          ac &&
          !isBadMenuShown() &&
          Date.now() - this.eqState.lastEqMoment > 500 &&
          Date.now() - this.spawnMoment > -1 &&
          this.spawnMoment > 0 &&
          !this.isSettlingBeast(model)
        ) {
          //if (this.spawnMoment > 0 && Date.now() - this.spawnMoment > 5000) {
          if (applyEquipment(ac, model.equipment)) {
            this.eqState.lastNumChanges = model.equipment.numChanges;
          }
          this.eqState.lastEqMoment = Date.now();
          //}
          //const res: boolean = applyEquipment(ac, model.equipment);
          //if (res) this.eqState.lastNumChanges = model.equipment.numChanges;
        }
      }
    }

    if (FormView.isDisplayingNicknames && this.refrId && model.appearance?.name) {
      const headPart = "NPC Head [Head]";
      const maxNicknameDrawDistance = 1000;
      const playerActor = Game.getPlayer()!;
      const isVisibleByPlayer = !model.movement?.isSneaking
        && playerActor.getDistance(refr) <= maxNicknameDrawDistance
        && playerActor.hasLOS(refr)
        && !this.isSweetHidePerson(refr)
        && FormView.adminViewOf(model) !== "hidden";
      if (isVisibleByPlayer) {
        const headScreenPos = worldPointToScreenPoint([
          NetImmerse.getNodeWorldPositionX(refr, headPart, false),
          NetImmerse.getNodeWorldPositionY(refr, headPart, false),
          NetImmerse.getNodeWorldPositionZ(refr, headPart, false) + 32
        ])[0];
        const resolution = getScreenResolution();
        const textXPos = Math.round(headScreenPos[0] * resolution.width);
        // Head + 32 is where TrueHUD draws the health bar (fInfoBarOffsetZ 30); the name and #TAG stack above it
        const barYPos = Math.round((1 - headScreenPos[1]) * resolution.height);
        const textYPos = barYPos - FormView.nameAboveBarPx;

        if (!this.textNameId && headScreenPos[2] > 0) {
          this.createdTagName = this.tagName(refr);
          this.createdActorIdLine = FormView.isDisplayingActorIds;
          this.createdSecondLine = FormView.secondLineOf(model, this.refrId);
          this.textNameId = createText(textXPos, textYPos, this.createdTagName, [1, 1, 1, 0.8]);
          setTextSize(this.textNameId, 0.5);
          // DragonBreak Online: the character's #TAG, faint, under the name (falls back to the ffxxxxxx id)
          if (this.createdActorIdLine) {
            this.textActorIdId = createText(
              textXPos,
              textYPos + FormView.actorIdLineOffset,
              this.createdSecondLine,
              [1, 1, 1, 0.35]
            );
            setTextSize(this.textActorIdId, 0.35);
          }
          SpApiInteractor.getControllerInstance().emitter.emit("nicknameCreate", {
            remoteRefrId: this.getRemoteRefrId(),
            textId: this.textNameId
          });
        } else {
          const deleteNickname = headScreenPos[2] < 0;
          if (deleteNickname) {
            this.removeNickname();
          }
          // Rename (/mask), a fresh introduction or a toggled id line: recreate
          if (this.textNameId
            && (this.tagName(refr) !== this.createdTagName || this.createdActorIdLine !== FormView.isDisplayingActorIds
              || FormView.secondLineOf(model, this.refrId) !== this.createdSecondLine)) {
            this.removeNickname();
          }
          if (this.textNameId) {
            setTextPos(this.textNameId, textXPos, textYPos);
          }
          if (this.textActorIdId) {
            setTextPos(this.textActorIdId, textXPos, textYPos + FormView.actorIdLineOffset);
          }
        }
      } else {
        this.removeNickname();
      }
    } else {
      this.removeNickname();
    }
  }

  // Real name once introduced to the local player (ff_knownIds owner prop), else "Stranger"
  // A missing list (gamemode without the feature) keeps real names for everyone
  private tagName(refr: ObjectReference): string {
    const name = refr.getDisplayName();
    if (storage["ownerModelSet"] !== true) {
      return name;
    }
    const owner = storage["ownerModel"] as Record<string, unknown> | undefined;
    const known = owner ? owner["ff_knownIds"] : undefined;
    if (!Array.isArray(known)) {
      return name;
    }
    return known.includes(this.getRemoteRefrId()) ? name : "Stranger";
  }

  private isSweetHidePerson(refr: ObjectReference): boolean {
    const actor = Actor.from(refr)
    if (!actor) {
      return false;
    }
    const keyword = Keyword.getKeyword('SweetHidePerson');
    return actor.wornHasKeyword(keyword);
  }

  // ff_hostile can arrive in an UpdateProperty after the copy spawned, so a changed flag is checked again
  // ff_outfit (server dungeons.js): armour the placement's template wears, which the spawned base does not.
  // The server cannot do this itself: an npc's inventory never leaves it and no snippet is sent for an npc.
  private applyOutfit(actor: Actor, model: FormModel): void {
    const value = (model as Record<string, unknown>)["ff_outfit"];
    if (!Array.isArray(value) || !value.length) {
      return;
    }
    const key = JSON.stringify(value);
    if (key === this.outfitSeen) {
      return;
    }
    this.outfitSeen = key;
    for (const entry of value) {
      const form = Game.getFormEx(Number(entry) || 0);
      if (!form) {
        continue;
      }
      actor.addItem(form, 1, true);
      actor.equipItem(form, false, true);
    }
  }

  // ff_factions (server dungeons.js): the placement's own Lvl* template factions, which the spawned concrete base lacks
  private applyFactions(actor: Actor, model: FormModel): void {
    const value = (model as Record<string, unknown>)["ff_factions"] as { f?: unknown; c?: unknown } | undefined;
    if (!value || !Array.isArray(value.f)) {
      return;
    }
    const key = JSON.stringify(value);
    if (key === this.factionsSeen) {
      return;
    }
    this.factionsSeen = key;
    actor.removeFromAllFactions();
    let applied = 0;
    for (const entry of value.f) {
      const faction = Faction.from(Game.getFormEx(Array.isArray(entry) ? Number(entry[0]) : 0));
      if (!faction) {
        continue;
      }
      const rank = Number(entry[1]) || 0;
      actor.setFactionRank(faction, rank);
      if (actor.getFactionRank(faction) === rank) applied++;
    }
    actor.setCrimeFaction(Faction.from(Game.getFormEx(Number(value.c) || 0)));
    sendCustomPacket(SpApiInteractor.getControllerInstance(), {
      customPacketType: "dbo", event: "npcDrift",
      args: [{ kind: "factions", remoteId: (this.remoteRefrId ?? 0).toString(16), sent: value.f.length, applied }],
    });
  }

  private applyHostility(actor: Actor, model: FormModel): void {
    const flag = (model as Record<string, unknown>)["ff_hostile"];
    if (this.hostilityApplied && flag === this.hostileFlagSeen) {
      return;
    }
    this.hostilityApplied = true;
    this.hostileFlagSeen = flag;
    const companionOf = (model as Record<string, unknown>)["ff_companionOf"];
    if (companionOf && this.remoteRefrId) {
      const rawAll = storage["allCompanionIds"];
      const all: number[] = Array.isArray(rawAll) ? rawAll : [];
      if (!all.includes(this.remoteRefrId)) storage["allCompanionIds"] = all.concat(this.remoteRefrId);
    }
    if (FormView.attacksEveryone(actor, model, this.remoteRefrId)) {
      if (this.aggressionBeforeRaise === undefined) {
        this.aggressionBeforeRaise = actor.getActorValue("Aggression");
      }
      actor.setActorValue("Aggression", 2);
    } else if (this.aggressionBeforeRaise !== undefined && flag === false && !isOwnCompanion(this.remoteRefrId)) {
      // Raised before the server's false flag arrived (PlaceAtMe sends the copy first), so it goes back; CompanionService sets up own companions
      actor.setActorValue("Aggression", this.aggressionBeforeRaise);
      this.aggressionBeforeRaise = undefined;
    }
  }

  // Remote players' copies are neutral to every NPC, so NPCs that attack players on sight are raised to attack neutrals too
  private static attacksEveryone(actor: Actor, model: FormModel, remoteId: number | undefined): boolean {
    const hostile = (model as Record<string, unknown>)["ff_hostile"];
    const companionOf = (model as Record<string, unknown>)["ff_companionOf"];
    // Companions are flagged false by the server, and CompanionService sets up the player's own ones
    if (hostile === false || isOwnCompanion(remoteId) || isAnyCompanion(remoteId) || companionOf) {
      return false;
    }
    if (FormView.ambushRaces.includes(actor.getRace()?.getFormID() ?? 0)) {
      return true;
    }
    if (model.appearance || actor.getActorValue("Aggression") >= 2) {
      return false;
    }
    // Allies and friends of the player (followers, housecarls) never turn on anyone
    const player = Game.getPlayer();
    if (player && actor.getFactionReaction(player) >= 2) {
      return false;
    }
    // Without the server's flag, fall back to the plugin's own aggression
    return typeof hostile === "boolean" ? hostile : actor.getActorValue("Aggression") >= 1;
  }

  // Admin Invisible and Ghost ride the neighbor-visible ff_adminModes prop; 3D reloads reset alpha and shaders, so both are reapplied
  private applyAdminInvisibility(refr: ObjectReference, model: FormModel): void {
    let view = FormView.adminViewOf(model);
    if (view === "visible" && this.spellInvisible(refr)) view = "hidden";
    if (view === "visible" && this.adminView === "visible") {
      return;
    }
    const actor = Actor.from(refr);
    if (!actor || !actor.is3DLoaded()) {
      this.adminShaderOn = false;
      return;
    }
    const now = Date.now();
    const leavingGhost = this.adminView === "ghost" && view !== "ghost";
    const playShader = view === "ghost"
      && (!this.adminShaderOn || (this.adminShaderReplayAt > 0 && now >= this.adminShaderReplayAt));
    if (leavingGhost || playShader) {
      const shader = EffectShader.from(Game.getFormEx(GHOST_SHADER_ID));
      shader?.stop(actor);
      if (playShader) {
        shader?.play(actor, -1);
      }
      this.adminShaderOn = playShader;
      this.adminShaderReplayAt = 0;
    }
    if (view !== this.adminView || now - this.lastAdminHideApply >= FormView.adminHideReapplyMs) {
      actor.setAlpha(view === "hidden" ? 0 : view === "ghost" ? GHOST_ALPHA : 1, false);
      this.adminView = view;
      this.lastAdminHideApply = now;
    }
  }

  // Invisible admins are hidden from players and shown to admins as ghosts; Ghost admins look like ghosts to everyone
  private static adminViewOf(model: FormModel): AdminView {
    const modes = (model as Record<string, unknown>)["ff_adminModes"];
    if (!modes || typeof modes !== "object") return "visible";
    const m = modes as Record<string, unknown>;
    if (m["invis"]) return FormView.viewerIsAdmin() ? "ghost" : "hidden";
    return m["ghost"] ? "ghost" : "visible";
  }

  // A replayed Invisibility spell would otherwise draw the caster as vanilla's shimmer instead of hiding them
  private spellInvisible(refr: ObjectReference): boolean {
    const now = Date.now();
    if (now - this.lastSpellInvisCheck < FormView.spellInvisCheckMs) return this.spellInvisibleSeen;
    this.lastSpellInvisCheck = now;
    try { this.spellInvisibleSeen = (Actor.from(refr)?.getActorValue("Invisibility") ?? 0) > 0; } catch { this.spellInvisibleSeen = false; }
    return this.spellInvisibleSeen;
  }

  private static viewerIsAdmin(): boolean {
    if (storage["ownerModelSet"] !== true) {
      return false;
    }
    const owner = storage["ownerModel"] as Record<string, unknown> | undefined;
    return !!owner && owner["isAdmin"] === true;
  }

  private removeNickname() {
    if (this.textNameId) {
      SpApiInteractor.getControllerInstance().emitter.emit("nicknameDestroy", {
        remoteRefrId: this.getRemoteRefrId(),
        textId: this.textNameId
      });
      destroyText(this.textNameId);
      this.textNameId = undefined;
    }
    if (this.textActorIdId) {
      destroyText(this.textActorIdId);
      this.textActorIdId = undefined;
    }
  }

  private isBeastCopy(model: FormModel): boolean {
    return !!model.appearance && BEAST_RACE_IDS.has(Number(model.appearance.raceId) >>> 0);
  }

  private isSettlingBeast(model: FormModel): boolean {
    return this.isBeastCopy(model) && (this.spawnMoment === 0 || Date.now() - this.spawnMoment < BEAST_SPAWN_SETTLE_MS);
  }

  private getAppearanceBasedBase(): number {
    const base = ActorBase.from(Game.getFormEx(this.appearanceBasedBaseId));
    if (!base && this.appearanceState.appearance) {
      this.appearanceBasedBaseId = applyAppearance(this.appearanceState.appearance).getFormID();
    }
    return this.appearanceBasedBaseId;
  }

  private getLeveledBase(templateChain: number[] | undefined): number {
    if (templateChain === undefined) {
      return 0;
    }

    const str = templateChain.join(',');

    if (this.leveledBaseId === 0) {
      // @ts-ignore
      const leveledBase = TESModPlatform.evaluateLeveledNpc(str);
      if (!leveledBase) {
        printConsole("Failed to evaluate leveled npc", str);
      }
      this.leveledBaseId = leveledBase?.getFormID() || 0;
    }

    return this.leveledBaseId;
  }

  private getDefaultEquipState() {
    return { lastNumChanges: 0, lastEqMoment: 0 };
  };

  private getDefaultAppearanceState() {
    return { lastNumChanges: 0, appearance: null as (null | Appearance) };
  };

  private getDefaultAnimState() {
    return { lastNumChanges: 0, useAnimOverrides: true };
  };

  private tryHostIfNeed(ac: Actor, remoteId: number, worldOrCell?: number) {
    const last = lastTryHost[remoteId];
    if (!last || Date.now() - last >= 1000) {
      try {
        const pc = Game.getPlayer() as Actor;
        if (pc && ac && ac.is3DLoaded()) {
          const d = ObjectReferenceEx.getDistance(ObjectReferenceEx.getPos(pc), ObjectReferenceEx.getPos(ac));
          const isInterior = !pc.getWorldSpace() || (pc.getParentCell() && pc.getParentCell()?.isInterior());
          const maxD = isInterior ? 25000 : 6000;
          if (d > maxD) return false;
        }
      } catch { /* ignore */ }
      const pcWorld = PlayerCharacterDataHolder.getWorldOrCell() || ObjectReferenceEx.getWorldOrCell(Game.getPlayer() as Actor);
      const acWorld = ObjectReferenceEx.getWorldOrCell(ac);
      const modelWorld = worldOrCell;
      const sameWorld = (acWorld && acWorld === pcWorld) || (modelWorld && modelWorld === pcWorld);
      if (sameWorld || (!acWorld && !modelWorld)) {
        lastTryHost[remoteId] = Date.now();
        tryHost(remoteId);
        return true;
      }
    }
    return false;
  };

  getLocalRefrId(): number {
    return this.refrId;
  }

  getRemoteRefrId(): number {
    return this.remoteRefrId as number;
  }

  // Player characters carry an appearance; server-spawned NPCs are placed from a base and never do
  isPlayerCharacter(): boolean {
    return !!this.appearanceState.appearance;
  }

  private refrId = 0;
  private ready = false;
  private animState = this.getDefaultAnimState();
  private movState = {
    lastNumChanges: 0,
    lastApply: 0,
    lastRehost: 0,
    everApplied: false,
    offsetApplied: false,
    weapReleased: false,
    havokSeated: false,
  };
  private appearanceState = this.getDefaultAppearanceState();
  private eqState = this.getDefaultEquipState();
  private appearanceBasedBaseId = 0;
  private leveledBaseId = 0;
  private isOnScreen = false;
  private lastNiNodeUpdateMs = 0;
  // A head at the camera (a carried player inside their carrier) flickers on and off screen; each rebuild is a hitch
  private static readonly niNodeUpdateMinIntervalMs = 5000;
  private lastPcWorldOrCell = 0;
  private lastWorldOrCell = 0;
  private spawnMoment = 0;
  private wasHostedByOther: boolean | undefined = undefined;
  private state = {};
  private localImmortal = false;
  private hostilityApplied = false;
  private hostileFlagSeen: unknown = undefined;
  private factionsSeen = "";
  private outfitSeen = "";
  private aggressionBeforeRaise: number | undefined = undefined;
  private adminView: AdminView = "visible";
  private adminShaderOn = false;
  private adminShaderReplayAt = 0;
  private lastSpellInvisCheck = 0;
  private spellInvisibleSeen = false;
  private lastAdminHideApply = 0;
  private textNameId: number | undefined = undefined;
  private textActorIdId: number | undefined = undefined;
  private createdTagName = "";
  private createdActorIdLine = false;
  private createdSecondLine = "";

  // "#TAG" from the server's ff_charTag property, else the local actor id
  private static secondLineOf(model: FormModel, refrId: number): string {
    const tag = (model as Record<string, unknown>)["ff_charTag"];
    if (typeof tag === "string" && tag.length === 4) return "#" + tag;
    return refrId.toString(16).toUpperCase().padStart(8, "0");
  }

  // Screen-space pixels between the name line and the actor id line
  private static readonly actorIdLineOffset = 24;
  private static readonly nameAboveBarPx = 46;
  private static readonly adminHideReapplyMs = 1000;
  private static readonly spellInvisCheckMs = 250;
  private static readonly adminShaderReplayDelayMs = 1000;
  // Draugr, falmer, chaurus, frostbite spiders, dwarven automatons, spriggans and wolves: ambush AI can start them passive
  private static readonly ambushRaces = [0xd53, 0x131f4, 0x131eb, 0x4e507, 0x53477, 0x131f1, 0x131f2, 0x131f3, 0x2013b77, 0xf3903, 0x13204, 0x401b644, 0x9aa44, 0x1320a];

  public static isDisplayingNicknames: boolean = true;
  public static isDisplayingActorIds: boolean = true;
}
