#include "ActionListener.h"
#include "AnimationSystem.h"
#include "ConditionsEvaluator.h"
#include "ConsoleCommands.h"
#include "CropRegeneration.h"
#include "Exceptions.h"
#include "GetBaseActorValues.h"
#include "HitData.h"
#include "MathUtils.h"
#include "MovementValidation.h"
#include "MpObjectReference.h"
#include "MsgType.h"
#include "Overloaded.h"
#include "WorldState.h"
#include "gamemode_events/CustomEvent.h"
#include "gamemode_events/EatItemEvent.h"
#include "gamemode_events/UpdateAppearanceAttemptEvent.h"
#include "gamemode_events/UpdateEquipmentAttemptEvent.h"
#include "formulas/TES5DamageFormula.h"
#include "script_objects/EspmGameObject.h"
#include <fmt/format.h>
#include <fmt/ranges.h>
#include <spdlog/spdlog.h>
#include <unordered_set>

#include "CustomPacketMessage.h"
#include "HostStartMessage.h"
#include "HostStopMessage.h"
#include "SpSnippet.h"
#include "UpdateAnimVariablesMessage.h"
#include "UpdateEquipmentMessage.h"
#include <algorithm>

namespace FormIdCasts {
uint32_t LongToNormal(uint64_t longFormId)
{
  return static_cast<uint32_t>(longFormId % 0x100000000);
}
}

namespace {
// Bounds a channel whose stop was lost, matching the observers' clone watch
constexpr auto kCastRefreshTimeout = std::chrono::milliseconds(8000);

// mp[eventName](refrId, ...args); false when a handler refuses
bool FireGamemodeEvent(WorldState& worldState, uint32_t refrId,
                       const char* eventName, const nlohmann::json& args)
{
  CustomEvent event(refrId, eventName, args.dump());
  return event.Fire(&worldState);
}

bool HasSweetPie(const WorldState& worldState)
{
  const auto& files = worldState.espmFiles;
  return std::find(files.begin(), files.end(), "SweetPie.esp") != files.end();
}

// Non-hostile Health/Magicka/Stamina effects; areaOnly keeps those a self cast spreads to others
std::vector<espm::Effects::Effect> GetRestorativeEffects(WorldState* worldState,
                                                         uint32_t spellId,
                                                         bool areaOnly)
{
  std::vector<espm::Effects::Effect> result;
  const auto spellLookup =
    worldState->GetEspm().GetBrowser().LookupById(spellId);
  if (!espm::IsSpellItem(spellLookup.rec)) {
    return result;
  }
  const auto spellData =
    espm::GetSpellItemData(spellLookup.rec, worldState->GetEspmCache());
  for (const auto& effect : spellData.effects) {
    if (!effect.effectItem || effect.effectFormId == 0) {
      continue;
    }
    if (areaOnly && effect.effectItem->areaOfEffect == 0) {
      continue;
    }
    const uint32_t effectId = spellLookup.ToGlobalId(effect.effectFormId);
    const auto magicEffect = espm::GetData<espm::MGEF>(effectId, worldState);
    if (magicEffect.data.IsFlagSet(espm::MGEF::Flags::Hostile) ||
        magicEffect.data.IsFlagSet(espm::MGEF::Flags::Detrimental)) {
      continue;
    }
    const auto av = magicEffect.data.primaryAV;
    if (av != espm::ActorValue::Health && av != espm::ActorValue::Magicka &&
        av != espm::ActorValue::Stamina) {
      continue;
    }
    espm::Effects::Effect converted;
    converted.effectId = effectId;
    converted.magnitude = effect.effectItem->magnitude;
    converted.areaOfEffect = effect.effectItem->areaOfEffect;
    converted.duration = effect.effectItem->duration;
    result.push_back(converted);
  }
  return result;
}

// Learned, NPC_/template/race and currently equipped spells
std::vector<uint32_t> GetKnownSpells(const MpActor& actor)
{
  std::vector<uint32_t> spells = actor.GetSpellList();
  const auto baseSpells = actor.GetBaseSpells();
  spells.insert(spells.end(), baseSpells.begin(), baseSpells.end());
  const auto& equipment = actor.GetEquipment();
  for (const auto& slot : { equipment.leftSpell, equipment.rightSpell,
                            equipment.voiceSpell, equipment.instantSpell }) {
    if (slot) {
      spells.push_back(*slot);
    }
  }
  return spells;
}

// Calls callback(effectItem, mgefData, mgefLookup) for each effect of a SPEL, effectItem may be null
template <class Callback>
void ForEachSpellEffectData(WorldState* worldState, uint32_t spellId,
                            const Callback& callback)
{
  auto& browser = worldState->GetEspm().GetBrowser();
  const auto spellLookup = browser.LookupById(spellId);
  // A scroll's effects work like its spell's (SCRL carries the same SPIT and EFID/EFIT)
  if (!espm::IsSpellItem(spellLookup.rec)) {
    return;
  }
  const auto spellData =
    espm::GetSpellItemData(spellLookup.rec, worldState->GetEspmCache());
  for (const auto& effect : spellData.effects) {
    if (effect.effectFormId == 0) {
      continue;
    }
    const auto mgefLookup =
      browser.LookupById(spellLookup.ToGlobalId(effect.effectFormId));
    const auto mgef = espm::Convert<espm::MGEF>(mgefLookup.rec);
    if (!mgef) {
      continue;
    }
    callback(effect.effectItem, mgef->GetData(worldState->GetEspmCache()).data,
             mgefLookup);
  }
}

// Calls callback(effectType, associatedItem, projectile) with global ids for each effect of a SPEL
template <class Callback>
void ForEachSpellEffect(WorldState* worldState, uint32_t spellId,
                        const Callback& callback)
{
  ForEachSpellEffectData(
    worldState, spellId,
    [&](const espm::SPEL::EFIT*, const espm::MGEF::DATA& data,
        const espm::LookupResult& mgefLookup) {
      callback(data.effectType,
               data.associatedItem ? mgefLookup.ToGlobalId(data.associatedItem)
                                   : 0,
               data.projectile ? mgefLookup.ToGlobalId(data.projectile) : 0);
    });
}

bool IsWardSpell(WorldState* worldState, uint32_t spellId)
{
  bool isWard = false;
  ForEachSpellEffectData(
    worldState, spellId,
    [&](const espm::SPEL::EFIT*, const espm::MGEF::DATA& data,
        const espm::LookupResult&) {
      isWard = isWard ||
        (data.effectType == espm::MGEF::EffectType::AccumulateMagnitude &&
         data.primaryAV == espm::ActorValue::WardPower);
    });
  return isWard;
}

// Longest visible Paralysis effect in seconds, hidden perk riders need conditions the server does not evaluate
uint32_t GetParalysisSeconds(WorldState* worldState, uint32_t spellId)
{
  uint32_t seconds = 0;
  bool damagesHealth = false;
  ForEachSpellEffectData(
    worldState, spellId,
    [&](const espm::SPEL::EFIT* effectItem, const espm::MGEF::DATA& data,
        const espm::LookupResult&) {
      if (!effectItem) {
        return;
      }
      damagesHealth = damagesHealth ||
        ((data.IsFlagSet(espm::MGEF::Flags::Hostile) ||
          data.IsFlagSet(espm::MGEF::Flags::Detrimental)) &&
         data.primaryAV == espm::ActorValue::Health);
      if (data.effectType == espm::MGEF::EffectType::Paralysis &&
          !data.IsFlagSet(espm::MGEF::Flags::HideInUI)) {
        seconds = std::max(seconds, effectItem->duration);
      }
    });
  // Replaying a damaging spell on the target's client would damage it twice
  return damagesHealth ? 0 : seconds;
}

// Bound weapon spells equip a weapon (and the bound arrow) the inventory never holds
bool IsGrantedBoundItem(const MpActor& actor, uint32_t itemId)
{
  WorldState* worldState = actor.GetParent();
  if (!worldState || !worldState->HasEspm()) {
    return false;
  }
  const auto itemLookup = worldState->GetEspm().GetBrowser().LookupById(itemId);
  const auto ammo = espm::Convert<espm::AMMO>(itemLookup.rec);
  if (!ammo && !espm::Convert<espm::WEAP>(itemLookup.rec)) {
    return false;
  }
  uint32_t ammoProjectile = 0;
  if (ammo) {
    const uint32_t raw = ammo->GetData(worldState->GetEspmCache()).projectile;
    if (raw == 0) {
      return false;
    }
    ammoProjectile = itemLookup.ToGlobalId(raw);
  }
  for (uint32_t spellId : GetKnownSpells(actor)) {
    bool granted = false;
    ForEachSpellEffect(worldState, spellId,
                       [&](espm::MGEF::EffectType type,
                           uint32_t associatedItem, uint32_t projectile) {
                         if (type != espm::MGEF::EffectType::BoundWeapon) {
                           return;
                         }
                         granted = granted ||
                           (ammo ? projectile == ammoProjectile
                                 : associatedItem == itemId);
                       });
    if (granted) {
      return true;
    }
  }
  return false;
}

// The host's engine rolls leveled templates on its own, so any spell in the base's template tree is valid
bool IsSpellInTemplateTree(const MpActor& actor, uint32_t spellId)
{
  WorldState* worldState = actor.GetParent();
  if (!worldState || !worldState->HasEspm()) {
    return false;
  }
  auto& browser = worldState->GetEspm().GetBrowser();
  std::vector<uint32_t> pending = { actor.GetBaseId() };
  std::unordered_set<uint32_t> visited;
  constexpr size_t kMaxVisited = 512;
  while (!pending.empty() && visited.size() < kMaxVisited) {
    const uint32_t formId = pending.back();
    pending.pop_back();
    if (formId == spellId) {
      return true;
    }
    if (!visited.insert(formId).second) {
      continue;
    }
    const auto lookup = browser.LookupById(formId);
    if (const auto npc = espm::Convert<espm::NPC_>(lookup.rec)) {
      const auto npcData = npc->GetData(worldState->GetEspmCache());
      for (uint32_t rawSpellId : npcData.spells) {
        pending.push_back(lookup.ToGlobalId(rawSpellId));
      }
      if (npcData.baseTemplate != 0 &&
          (npcData.templateDataFlags & espm::NPC_::UseSpelllist)) {
        pending.push_back(lookup.ToGlobalId(npcData.baseTemplate));
      }
      continue;
    }
    const espm::LeveledListBase* list = espm::Convert<espm::LVLN>(lookup.rec);
    if (!list) {
      list = espm::Convert<espm::LVSP>(lookup.rec);
    }
    if (list) {
      const auto listData = list->GetData(worldState->GetEspmCache());
      for (uint8_t i = 0; i < listData.numEntries; ++i) {
        pending.push_back(lookup.ToGlobalId(listData.entries[i].formId));
      }
    }
  }
  return false;
}

// Hosted NPCs keep no spell equipment on the server, their spell list is the gate
// A scroll the actor holds in a hand and still has in its inventory (read once, see OnSpellCast)
bool IsHeldScroll(const MpActor& actor, uint32_t spellId)
{
  if (actor.GetInventory().GetItemCount(spellId) < 1) {
    return false;
  }
  for (const auto& entry : actor.GetEquippedScroll()) {
    if (entry && entry->baseId == spellId) {
      return true;
    }
  }
  return false;
}

bool CanCastSpell(const MpActor& actor, uint32_t spellId)
{
  if (actor.GetEquipment().IsSpellEquipped(spellId)) {
    return true;
  }
  // Scrolls are items, not equipped spells: every scroll cast was refused here and the scroll never left the
  // inventory, so it came back after each cast (2026-09-25)
  if (IsHeldScroll(actor, spellId)) {
    return true;
  }
  return actor.GetProfileId() == -1 &&
    (actor.IsSpellLearned(spellId) || IsSpellInTemplateTree(actor, spellId));
}

// Cloaks and hazards (Blizzard) hit with a spell they grant, not the spell that was cast
bool IsSpellGrantedBy(WorldState* worldState, uint32_t parentSpellId,
                      uint32_t sourceId)
{
  bool granted = false;
  ForEachSpellEffect(
    worldState, parentSpellId,
    [&](espm::MGEF::EffectType type, uint32_t associatedItem, uint32_t) {
      if (granted || associatedItem == 0) {
        return;
      }
      if (type == espm::MGEF::EffectType::Cloak) {
        granted = associatedItem == sourceId;
        return;
      }
      if (type != espm::MGEF::EffectType::SpawnHazard) {
        return;
      }
      const auto hazardLookup =
        worldState->GetEspm().GetBrowser().LookupById(associatedItem);
      const auto hazard = espm::Convert<espm::HAZD>(hazardLookup.rec);
      if (!hazard) {
        return;
      }
      const uint32_t hazardSpell =
        hazard->GetData(worldState->GetEspmCache()).spell;
      granted =
        hazardSpell != 0 && hazardLookup.ToGlobalId(hazardSpell) == sourceId;
    });
  return granted;
}

// Projectiles, cloaks and hazards may land after the spell left the hand
bool CanHitWithSpell(const MpActor& actor, uint32_t spellId)
{
  if (actor.GetEquipment().IsSpellEquipped(spellId) ||
      actor.IsSpellLearned(spellId)) {
    return true;
  }
  if (actor.GetProfileId() == -1 && IsSpellInTemplateTree(actor, spellId)) {
    return true;
  }
  for (uint32_t knownSpellId : GetKnownSpells(actor)) {
    if (IsSpellGrantedBy(actor.GetParent(), knownSpellId, spellId)) {
      return true;
    }
  }
  return false;
}
}

MpActor* ActionListener::SendToNeighbours(uint32_t idx,
                                          Networking::UserId userId,
                                          Networking::PacketData data,
                                          size_t length, bool reliable,
                                          bool checkOnly,
                                          bool echoHostedToSender)
{
  MpActor* myActor = partOne.serverState.ActorByUser(userId);
  // The old behavior is doing nothing in that case. This is covered by tests
  if (!myActor) {
    spdlog::warn("SendToNeighbours - No actor assigned to user");
    return nullptr;
  }

  MpForm* form = partOne.worldState.LookupFormByIdx(idx);
  MpActor* actor = form ? form->AsActor() : nullptr;
  if (!actor) {
    spdlog::error("SendToNeighbours - Target actor doesn't exist");
    return nullptr;
  }

  if (idx != myActor->GetIdx()) {
    // Possible fix for "players link to each other" bug
    // See also PartOne::SetUserActor
    Networking::UserId actorsOwningUserId =
      partOne.serverState.UserByActor(actor);
    if (actorsOwningUserId != Networking::InvalidUserId) {
      spdlog::error("SendToNeighbours - No permission to update actor {:x} "
                    "(already owned by user {})",
                    actor->GetFormId(), actorsOwningUserId);
      partOne.SendHostStop(userId, *actor);

      partOne.worldState.hosters.erase(actor->GetFormId());
      return nullptr;
    }

    auto it = partOne.worldState.hosters.find(actor->GetFormId());
    if (it == partOne.worldState.hosters.end() ||
        it->second != myActor->GetFormId()) {
      if (idx == 0) {
        spdlog::warn("SendToNeighbours - idx=0, <Message>::ReadJson or "
                     "similar is probably incorrect");
      }
      spdlog::error(
        "SendToNeighbours - No permission to update actor {:x} (not a hoster)",
        actor->GetFormId());
      partOne.SendHostStop(userId, *actor);
      return nullptr;
    }
  }

  if (checkOnly) {
    return actor;
  }

  const bool skipSender = !echoHostedToSender && idx != myActor->GetIdx();
  for (auto listener : actor->GetActorListeners()) {
    auto targetuserId = partOne.serverState.UserByActor(listener);
    if (targetuserId == Networking::InvalidUserId ||
        (skipSender && targetuserId == userId)) {
      continue;
    }
    partOne.GetSendTarget().Send(targetuserId, data, length, reliable);
  }

  return actor;
}

MpActor* ActionListener::SendToNeighbours(uint32_t idx,
                                          const RawMessageData& rawMsgData,
                                          bool reliable, bool checkOnly,
                                          bool echoHostedToSender)
{
  return SendToNeighbours(idx, rawMsgData.userId, rawMsgData.unparsed,
                          rawMsgData.unparsedLength, reliable, checkOnly,
                          echoHostedToSender);
}

// The server owns where an NPC is (Nat, 2026-09-25). A hoster's copy that jumps further in one update than any
// NPC can move (1024 units, or 2500 units/s since the last accepted update) is not relayed and not applied, and
// the hoster's copy is teleported back to the server's position, at most once a second. The playtest showed
// hosted copies jumping 450-4300 units back to stale spots and every watcher seeing them rubber-band. If the
// hoster insists for 3 s its position wins, so an NPC that really moved (a fall, a slip in the server's own
// copy) is never frozen, which is why NPC moves used to be relayed before any check.
bool ActionListener::RefuseNpcJump(MpActor& actor, const NiPoint3& newPos)
{
  constexpr float kMinJump = 1024.f;
  constexpr float kMaxSpeed = 2500.f;
  constexpr float kMaxDtSec = 3.f;
  const auto kInsistFor = std::chrono::seconds(3);
  const auto kCorrectEvery = std::chrono::seconds(1);
  const auto kLogEvery = std::chrono::seconds(10);

  const auto now = std::chrono::steady_clock::now();
  auto& st = npcJumps[actor.GetFormId()];
  const float dtSec =
    st.lastAccepted.time_since_epoch().count() == 0
    ? kMaxDtSec
    : std::min(kMaxDtSec,
               std::chrono::duration<float>(now - st.lastAccepted).count());
  const float allowed = std::max(kMinJump, kMaxSpeed * dtSec);
  const float step = (newPos - actor.GetPos()).Length();

  if (step <= allowed) {
    st.disagreeing = false;
    st.lastAccepted = now;
    return false;
  }
  if (!st.disagreeing) {
    st.disagreeing = true;
    st.disagreeSince = now;
  }
  if (now - st.disagreeSince >= kInsistFor) {
    st.disagreeing = false;
    st.lastAccepted = now;
    partOne.GetLogger().info(
      "NpcJump {:x}: the hoster held a position {:.0f} away for 3 s, taking it",
      actor.GetFormId(), step);
    return false;
  }
  if (now - st.lastCorrection >= kCorrectEvery) {
    st.lastCorrection = now;
    LocationalData here;
    here.pos = actor.GetPos();
    here.rot = actor.GetAngle();
    here.cellOrWorldDesc = actor.GetCellOrWorld();
    actor.Teleport(here);
  }
  if (now - st.lastLog >= kLogEvery) {
    st.lastLog = now;
    partOne.GetLogger().info(
      "NpcJump {:x}: refused a {:.0f} step (allowed {:.0f}), hoster's copy "
      "sent back",
      actor.GetFormId(), step, allowed);
  }
  return true;
}

void ActionListener::ForgetForm(uint32_t formId)
{
  npcJumps.erase(formId);
}

void ActionListener::OnCustomPacket(const RawMessageData& rawMsgData,
                                    const CustomPacketMessage& msg)
{
  simdjson::dom::parser parser;
  auto content = parser.parse(msg.contentJsonDump).value();
  for (auto& listener : partOne.GetListeners()) {
    listener->OnCustomPacket(rawMsgData.userId, content);
  }
}

void ActionListener::OnUpdateMovement(const RawMessageData& rawMsgData,
                                      const UpdateMovementMessage& msg)
{
  // A paralysed player stays put until it ends or the server teleports them
  if (!paralyzedUntil.empty()) {
    MpActor* myActor = partOne.serverState.ActorByUser(rawMsgData.userId);
    if (myActor && myActor->GetIdx() == msg.idx && IsParalyzed(*myActor)) {
      if (!myActor->GetTeleportFlag()) {
        return;
      }
      paralyzedUntil.erase(myActor->GetFormId());
    }
  }

  MpActor* myActor = partOne.serverState.ActorByUser(rawMsgData.userId);
  const bool isOwnActor = myActor && myActor->GetIdx() == msg.idx;

  // A player's refused packet must not reach other clients, so own movement is
  // validated before it is relayed. A hosted NPC is checked for an impossible
  // jump before it is relayed; everything else about it keeps the old order
  MpActor* actor = myActor;
  if (!isOwnActor) {
    actor = SendToNeighbours(msg.idx, rawMsgData, false, true);
    if (!actor) {
      return;
    }
    const bool sameWorld = actor->GetCellOrWorld() ==
      FormDesc::FromFormId(msg.data.worldOrCell,
                           actor->GetParent()->espmFiles);
    if (sameWorld && !actor->GetTeleportFlag() &&
        RefuseNpcJump(*actor,
                      NiPoint3{ msg.data.pos[0], msg.data.pos[1],
                                msg.data.pos[2] })) {
      return;
    }
    // Right after a server teleport the next packet is refused below
    // (kInfinityPos); it was sent before the hoster saw the teleport, so
    // watchers are not shown that stale position either
    if (!actor->GetTeleportFlag()) {
      SendToNeighbours(msg.idx, rawMsgData);
    }
  }
  if (actor) {
    bool teleportFlag = actor->GetTeleportFlag();
    actor->SetTeleportFlag(false);

    static const NiPoint3 kInfinityPos = {
      std::numeric_limits<float>::infinity(),
      std::numeric_limits<float>::infinity(),
      std::numeric_limits<float>::infinity()
    };

    auto& espmFiles = actor->GetParent()->espmFiles;

    const auto& currentPos = actor->GetPos();
    const auto& currentRot = actor->GetAngle();
    const auto& currentCellOrWorld = actor->GetCellOrWorld();

    if (!MovementValidation::Validate(
          partOne, currentPos, currentRot, currentCellOrWorld,
          teleportFlag
            ? kInfinityPos
            : NiPoint3{ msg.data.pos[0], msg.data.pos[1], msg.data.pos[2] },
          FormDesc::FromFormId(msg.data.worldOrCell, espmFiles),
          rawMsgData.userId, actor, espmFiles, &movementTracker)) {
      return;
    }

    if (isOwnActor) {
      SendToNeighbours(msg.idx, rawMsgData);
    }

    if (!msg.data.isBlocking) {
      actor->IncreaseBlockCount();
    } else {
      actor->ResetBlockCount();
    }

    actor->SetPos(
      NiPoint3{ msg.data.pos[0], msg.data.pos[1], msg.data.pos[2] },
      SetPosMode::CalledByUpdateMovement);
    actor->SetAngle(
      NiPoint3{ msg.data.rot[0], msg.data.rot[1], msg.data.rot[2] },
      SetAngleMode::CalledByUpdateMovement);
    actor->SetAnimationVariableBool(
      AnimationVariableBool::kVariable_bInJumpState, msg.data.isInJumpState);
    actor->SetAnimationVariableBool(
      AnimationVariableBool::kVariable__skymp_isWeapDrawn,
      msg.data.isWeapDrawn);
    actor->SetAnimationVariableBool(
      AnimationVariableBool::kVariable_IsBlocking, msg.data.isBlocking);
    actor->SetAnimationVariableBool(
      AnimationVariableBool::kVariable_IsSneaking, msg.data.isSneaking);

    if (actor->GetBlockCount() == 5) {
      actor->SetIsBlockActive(false);
      actor->ResetBlockCount();
    }

    if (msg.data.runMode != "Standing") {
      actor->SetLastAnimEvent(std::nullopt);
    }

    if (partOne.worldState.lastMovUpdateByIdx.size() <= msg.idx) {
      auto newSize = static_cast<size_t>(msg.idx) + 1;
      partOne.worldState.lastMovUpdateByIdx.resize(newSize);
    }
    partOne.worldState.lastMovUpdateByIdx[msg.idx] =
      std::chrono::system_clock::now();
  }
}

void ActionListener::OnUpdateAnimation(const RawMessageData& rawMsgData,
                                       const UpdateAnimationMessage& msg)
{
  MpActor* myActor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!myActor) {
    return;
  }

  // A hoster got every animation of its NPC back; its client only skipped them (formView, alreadyHosted), and a
  // replay restarts swings and can turn collision off. Movement is still echoed: formView re-seats a hosted copy on
  // the last relayed position once they are 3000 units apart, so without the echo it would snap back
  constexpr bool kEchoHostedToSender = false;
  auto targetActor =
    SendToNeighbours(msg.idx, rawMsgData, false, false, kEchoHostedToSender);

  if (!targetActor) {
    return;
  }

  // Only process animation system and set last anim event for player's actor
  if (targetActor != myActor) {
    return;
  }

  partOne.animationSystem.Process(targetActor, msg.data);
  targetActor->SetLastAnimEvent(msg.data);
}

void ActionListener::OnUpdateAppearance(const RawMessageData& rawMsgData,
                                        const UpdateAppearanceMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor || !msg.data.has_value()) {
    return;
  }

  const bool isAllowed = actor->IsRaceMenuOpen();

  if (isAllowed) {
    actor->SetRaceMenuOpen(false);
    actor->SetAppearance(&msg.data.value());
    SendToNeighbours(msg.idx, rawMsgData, true);
  }

  UpdateAppearanceAttemptEvent updateAppearanceAttemptEvent(
    actor, msg.data.value(), isAllowed);
  updateAppearanceAttemptEvent.Fire(actor->GetParent());
}

void ActionListener::OnUpdateEquipment(const RawMessageData& rawMsgData,
                                       const UpdateEquipmentMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor) {
    return;
  }

  bool isAllowed = true;
  const auto actorFormId = actor->GetFormId();
  const Equipment& data = msg.data;
  const Inventory& equipmentInv = data.inv;
  uint32_t leftSpell = data.leftSpell.value_or(0);
  uint32_t rightSpell = data.rightSpell.value_or(0);
  uint32_t voiceSpell = data.voiceSpell.value_or(0);
  uint32_t instantSpell = data.instantSpell.value_or(0);

  enum class SpellSlotId : size_t
  {
    Left = 0,
    Right,
    Voice,
    Instant,
    kCount
  };

  std::array<uint32_t, static_cast<size_t>(SpellSlotId::kCount)>
    spellIdsToRemove = {};

  if (leftSpell > 0 && !actor->IsSpellLearned(leftSpell)) {
    spdlog::warn("ActionListener::OnUpdateEquipment {:x} - stripping "
                 "unlearned spell {:x} from the update",
                 actorFormId, leftSpell);
    spellIdsToRemove[static_cast<size_t>(SpellSlotId::Left)] = leftSpell;
  }

  if (rightSpell > 0 && !actor->IsSpellLearned(rightSpell)) {
    spdlog::warn("ActionListener::OnUpdateEquipment {:x} - stripping "
                 "unlearned spell {:x} from the update",
                 actorFormId, rightSpell);
    spellIdsToRemove[static_cast<size_t>(SpellSlotId::Right)] = rightSpell;
  }

  if (voiceSpell > 0 && !actor->IsSpellLearned(voiceSpell)) {
    spdlog::warn("ActionListener::OnUpdateEquipment {:x} - stripping "
                 "unlearned spell {:x} from the update",
                 actorFormId, voiceSpell);
    spellIdsToRemove[static_cast<size_t>(SpellSlotId::Voice)] = voiceSpell;
  }

  if (instantSpell > 0 && !actor->IsSpellLearned(instantSpell)) {
    spdlog::warn("ActionListener::OnUpdateEquipment {:x} - stripping "
                 "unlearned spell {:x} from the update",
                 actorFormId, instantSpell);
    spellIdsToRemove[static_cast<size_t>(SpellSlotId::Instant)] = instantSpell;
  }

  std::vector<uint32_t> itemIdsToUnequip;

  const auto& inventory = actor->GetInventory();
  for (auto& entry : equipmentInv.entries) {
    // Only worn items matter; validating the whole inventory would strip the player bare via the unequip path below
    if (entry.GetWorn() == Inventory::Worn::None) {
      continue;
    }
    if (!inventory.HasItem(entry.baseId) &&
        !IsGrantedBoundItem(*actor, entry.baseId)) {
      spdlog::warn(
        "ActionListener::OnUpdateEquipment {:x} - rejected equipment "
        "update: inventory does not contain item {:x}",
        actorFormId, entry.baseId);
      isAllowed = false;
      break;
    }
  }

  if (isAllowed) {
    auto worldState = actor->GetParent();
    if (worldState) {
      uint32_t occupiedSlots = 0;
      // Track which item owns each bit so we can report conflicts
      std::array<uint32_t, 32> slotOwner = {};
      for (auto& entry : equipmentInv.entries) {
        if (entry.GetWorn() == Inventory::Worn::None) {
          continue;
        }
        auto lookupRes =
          worldState->GetEspm().GetBrowser().LookupById(entry.baseId);
        if (!lookupRes.rec || lookupRes.rec->GetType() != espm::ARMO::kType) {
          continue;
        }
        auto armoData = espm::GetData<espm::ARMO>(entry.baseId, worldState);
        uint32_t bodyPartFlags = 0;
        if (armoData.bod2.present) {
          bodyPartFlags = armoData.bod2.bodyPartFlags;
        } else if (armoData.bodt.present) {
          bodyPartFlags = armoData.bodt.bodyPartFlags;
        }
        if (bodyPartFlags == 0) {
          continue;
        }
        uint32_t overlap = occupiedSlots & bodyPartFlags;
        if (overlap) {
          // Collect all conflicting item IDs from slotOwner
          std::unordered_set<uint32_t> conflictingItems;
          conflictingItems.insert(entry.baseId);
          for (int bit = 0; bit < 32; ++bit) {
            if (overlap & (1u << bit)) {
              conflictingItems.insert(slotOwner[bit]);
            }
          }
          std::string conflictList;
          for (uint32_t id : conflictingItems) {
            if (!conflictList.empty()) {
              conflictList += ", ";
            }
            conflictList += fmt::format("{:x}", id);
          }
          std::string binaryStr(32, '0');
          for (int bit = 31; bit >= 0; --bit) {
            if (overlap & (1u << (31 - bit))) {
              binaryStr[bit] = '1';
            }
          }
          spdlog::warn(
            "ActionListener::OnUpdateEquipment {:x} - rejected equipment "
            "update: items [{}] share armor slot flags {:x} (0b{})",
            actorFormId, conflictList, overlap, binaryStr);
          isAllowed = false;
          for (uint32_t id : conflictingItems) {
            itemIdsToUnequip.push_back(id);
          }
          break;
        }
        for (int bit = 0; bit < 32; ++bit) {
          if (bodyPartFlags & (1u << bit)) {
            slotOwner[bit] = entry.baseId;
          }
        }
        occupiedSlots |= bodyPartFlags;
      }
    }
  }

  const bool anySpellStripped =
    std::any_of(spellIdsToRemove.begin(), spellIdsToRemove.end(),
                [](uint32_t id) { return id != 0; });

  // Worn items show the extras the server holds, never ones a client made up
  UpdateEquipmentMessage sanitizedMsg = msg;
  bool extrasReplaced = false;
  for (auto& entry : sanitizedMsg.data.inv.entries) {
    if (entry.GetWorn() == Inventory::Worn::None) {
      continue;
    }
    Inventory::Entry one = entry;
    one.count = 1;
    const auto owned = inventory.FindEntriesFor(one);
    if (owned.empty() || owned[0].SameItemAs(entry)) {
      continue;
    }
    const auto worn = entry.GetWorn();
    const auto count = entry.count;
    entry = owned[0];
    entry.count = count;
    entry.SetWorn(worn);
    extrasReplaced = true;
  }

  if (isAllowed) {
    // An unlearned spell strips just that slot; weapons/armor still reach neighbours (avoids silent desync)
    if (anySpellStripped || extrasReplaced) {
      if (spellIdsToRemove[static_cast<size_t>(SpellSlotId::Left)]) {
        sanitizedMsg.data.leftSpell = std::nullopt;
      }
      if (spellIdsToRemove[static_cast<size_t>(SpellSlotId::Right)]) {
        sanitizedMsg.data.rightSpell = std::nullopt;
      }
      if (spellIdsToRemove[static_cast<size_t>(SpellSlotId::Voice)]) {
        sanitizedMsg.data.voiceSpell = std::nullopt;
      }
      if (spellIdsToRemove[static_cast<size_t>(SpellSlotId::Instant)]) {
        sanitizedMsg.data.instantSpell = std::nullopt;
      }
      for (auto listener : actor->GetActorListeners()) {
        listener->SendToUser(sanitizedMsg, true);
      }
      actor->SetEquipment(sanitizedMsg.data);
    } else {
      SendToNeighbours(msg.idx, rawMsgData, true);
      actor->SetEquipment(data);
    }
  } else {
    actor->SendInventoryUpdate();

    // Worn items the server equipment lacks or the inventory lacks are unequipped
    {
      const auto& currentEquip = actor->GetEquipment().inv;

      std::unordered_set<uint32_t> currentWornIds;
      for (const auto& entry : currentEquip.entries) {
        if (entry.GetWorn() != Inventory::Worn::None) {
          currentWornIds.insert(entry.baseId);
        }
      }

      for (const auto& entry : equipmentInv.entries) {
        if (entry.GetWorn() == Inventory::Worn::None) {
          continue;
        }
        const bool notEquipped =
          currentWornIds.find(entry.baseId) == currentWornIds.end();
        const bool notInInventory = !inventory.HasItem(entry.baseId) &&
          !IsGrantedBoundItem(*actor, entry.baseId);
        if (notEquipped || notInInventory) {
          spdlog::info(
            "ActionListener::OnUpdateEquipment {:x} - unequipping item {:x} "
            "({})",
            actorFormId, entry.baseId,
            notEquipped ? "not in current equipment" : "not in inventory");
          itemIdsToUnequip.push_back(entry.baseId);
        }
      }

      // TODO: consider doing EquipItem for items worn in current equipment
      // but not worn in the new equipment (client tried to unequip them)
    }

    for (uint32_t itemId : itemIdsToUnequip) {
      SpSnippetObjectArgument itemArg;
      itemArg.formId = itemId;
      itemArg.type = "Form";
      std::vector<std::optional<
        std::variant<bool, double, std::string, SpSnippetObjectArgument>>>
        args;
      args.push_back(itemArg);
      args.push_back(false);
      args.push_back(true);
      SpSnippet("Actor", "UnequipItem", args, actor->GetFormId())
        .Execute(actor, SpSnippetMode::kNoReturnResult);
    }
  }

  // Stripped spells are removed on the caster's client in both branches
  for (uint32_t spellId : spellIdsToRemove) {
    if (spellId == 0) {
      continue;
    }
    SpSnippetObjectArgument spellArg;
    spellArg.formId = spellId;
    spellArg.type = "Spell";
    std::vector<std::optional<
      std::variant<bool, double, std::string, SpSnippetObjectArgument>>>
      args;
    args.push_back(spellArg);
    SpSnippet("Actor", "RemoveSpell", args, actor->GetFormId())
      .Execute(actor, SpSnippetMode::kNoReturnResult);
  }

  UpdateEquipmentAttemptEvent updateEquipmentAttemptEvent(actor, data,
                                                          isAllowed);
  updateEquipmentAttemptEvent.Fire(actor->GetParent());
}

void ActionListener::OnActivate(const RawMessageData& rawMsgData,
                                const ActivateMessage& msg)
{
  if (!partOne.HasEspm())
    throw std::runtime_error("No loaded esm or esp files are found");

  const auto ac = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!ac)
    throw std::runtime_error("Can't do this without Actor attached");

  auto it =
    partOne.worldState.hosters.find(static_cast<uint32_t>(msg.data.caster));
  auto hosterId = it == partOne.worldState.hosters.end() ? 0 : it->second;

  if (msg.data.caster != 0x14) {
    if (hosterId != ac->GetFormId()) {
      std::stringstream ss;
      ss << std::hex << "Bad hoster is attached to caster 0x"
         << msg.data.caster << ", expected 0x" << ac->GetFormId()
         << ", but found 0x" << hosterId;
      throw std::runtime_error(ss.str());
    }
  }

  if (msg.data.caster == 0x14 && IsParalyzed(*ac)) {
    return;
  }

  auto targetPtr = std::dynamic_pointer_cast<MpObjectReference>(
    partOne.worldState.LookupFormById(static_cast<uint32_t>(msg.data.target)));
  if (!targetPtr)
    return;

  constexpr bool kDefaultProcessingOnlyFalse = false;
  targetPtr->Activate(
    msg.data.caster == 0x14 ? *ac
                            : partOne.worldState.GetFormAt<MpObjectReference>(
                                static_cast<uint32_t>(msg.data.caster)),
    kDefaultProcessingOnlyFalse, msg.data.isSecondActivation);
  // Every activation by a hosted NPC re-equipped it and broadcast UpdateEquipment; only one with no weapon in hand
  if (hosterId) {
    auto actor =
      std::dynamic_pointer_cast<MpActor>(partOne.worldState.LookupFormById(
        static_cast<uint32_t>(msg.data.caster)));
    if (actor && actor->HasWeaponToEquip()) {
      actor->EquipBestWeapon();
    }
  }
}

void ActionListener::OnPutItem(const RawMessageData& rawMsgData,
                               const PutItemMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor) {
    return;
  }

  auto& ref = partOne.worldState.GetFormAt<MpObjectReference>(msg.target);

  auto worldState = actor->GetParent();
  if (!worldState) {
    return spdlog::error("No WorldState attached");
  }

  if (worldState->HasKeyword(msg.baseId, "SweetCantDrop")) {
    return spdlog::error("Attempt to put SweetCantDrop item {:x}",
                         actor->GetFormId());
  }

  Inventory::Entry entry;
  entry.baseId = msg.baseId;
  entry.count = msg.count;
  static_cast<Inventory::ExtraData&>(entry) =
    static_cast<const Inventory::ExtraData&>(msg);
  entry.SetWorn(Inventory::Worn::None);

  const auto owned = actor->GetInventory().FindEntriesFor(entry);
  if (owned.empty()) {
    return ref.PutItem(*actor, entry);
  }
  for (const auto& e : owned) {
    ref.PutItem(*actor, e);
  }
}

void ActionListener::OnTakeItem(const RawMessageData& rawMsgData,
                                const TakeItemMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor) {
    return;
  }

  auto& ref = partOne.worldState.GetFormAt<MpObjectReference>(msg.target);

  auto worldState = actor->GetParent();
  if (!worldState) {
    return spdlog::error("No WorldState attached");
  }

  if (worldState->HasKeyword(msg.baseId, "SweetCantDrop")) {
    return spdlog::error("Attempt to take SweetCantDrop item {:x}",
                         actor->GetFormId());
  }

  Inventory::Entry entry;
  entry.baseId = msg.baseId;
  entry.count = msg.count;
  static_cast<Inventory::ExtraData&>(entry) =
    static_cast<const Inventory::ExtraData&>(msg);

  // A searched body's local copy holds plain stacks, so a take may stand for copies with extras
  const auto stored = ref.GetInventory().FindEntriesFor(entry, true);
  if (stored.empty()) {
    return ref.TakeItem(*actor, entry);
  }
  for (const auto& e : stored) {
    ref.TakeItem(*actor, e);
  }
}

void ActionListener::OnDropItem(const RawMessageData& rawMsgData,
                                const DropItemMessage& msg)
{
  uint32_t baseId = FormIdCasts::LongToNormal(msg.baseId);
  MpActor* ac = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!ac) {
    return spdlog::error("Unable to drop an item from user with id: {}.",
                         rawMsgData.userId);
  }

  auto worldState = ac->GetParent();
  if (!worldState) {
    return spdlog::error("No WorldState attached");
  }

  if (worldState->HasKeyword(baseId, "SweetCantDrop")) {
    return spdlog::error("Attempt to drop SweetCantDrop item {:x}",
                         ac->GetFormId());
  }

  Inventory::Entry entry;
  entry.baseId = baseId;
  entry.count = msg.count;
  static_cast<Inventory::ExtraData&>(entry) =
    static_cast<const Inventory::ExtraData&>(msg);
  entry.SetWorn(Inventory::Worn::None);

  const auto owned = ac->GetInventory().FindEntriesFor(entry);
  if (owned.empty()) {
    return ac->DropItem(baseId, Inventory::Entry(baseId, msg.count));
  }
  for (const auto& e : owned) {
    ac->DropItem(baseId, e);
  }
}

void ActionListener::OnPlayerBowShot(const RawMessageData& rawMsgData,
                                     const PlayerBowShotMessage& msg)
{
  MpActor* ac = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!ac) {
    return spdlog::error("Unable to shot from user with id: {}.",
                         rawMsgData.userId);
  }

  auto worldState = ac->GetParent();
  if (!worldState) {
    return;
  }

  auto ammoLookupRes =
    worldState->GetEspm().GetBrowser().LookupById(msg.ammoId);
  if (!ammoLookupRes.rec) {
    return spdlog::error("ActionListener::OnPlayerBowShot {:x} - unable to "
                         "find espm record for {:x}",
                         ac->GetFormId(), msg.ammoId);
  }

  if (ammoLookupRes.rec->GetType().ToString() != "AMMO") {
    return spdlog::error(
      "ActionListener::OnPlayerBowShot {:x} - unable to shot not an ammo {:x}",
      ac->GetFormId(), msg.ammoId);
  }

  ac->RemoveItem(msg.ammoId, 1, nullptr);
}

void ActionListener::OnFinishSpSnippet(const RawMessageData& rawMsgData,
                                       const FinishSpSnippetMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor) {
    throw std::runtime_error(
      "Unable to finish SpSnippet: No Actor found for user " +
      std::to_string(rawMsgData.userId));
  }

  actor->ResolveSnippet(
    static_cast<uint32_t>(msg.snippetIdx),
    SpSnippet::VarValueFromSpSnippetReturnValue(msg.returnValue));
}

void ActionListener::OnEquip(const RawMessageData& rawMsgData,
                             const OnEquipMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor) {
    throw std::runtime_error(
      "Unable to finish SpSnippet: No Actor found for user " +
      std::to_string(rawMsgData.userId));
  }

  std::ignore = actor->OnEquip(msg.baseId);
}

void ActionListener::OnConsoleCommand(const RawMessageData& rawMsgData,
                                      const ConsoleCommandMessage& msg)
{
  MpActor* me = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (me) {
    std::vector<ConsoleCommands::Argument> consoleArgs;
    consoleArgs.resize(msg.data.args.size());
    for (size_t i = 0; i < msg.data.args.size(); i++) {
      consoleArgs[i] = ConsoleCommands::Argument(msg.data.args[i]);
    }

    // Fired before Execute so denied attempts are visible to the gamemode
    // too; CustomEvent prepends the caller's form id
    nlohmann::json argsJson = nlohmann::json::array();
    argsJson.push_back(msg.data.commandName);
    for (const auto& arg : msg.data.args) {
      std::visit([&argsJson](const auto& value) { argsJson.push_back(value); },
                 arg);
    }
    CustomEvent consoleEvent(me->GetFormId(), "onConsoleCommand",
                             argsJson.dump());
    consoleEvent.Fire(&partOne.worldState);

    ConsoleCommands::Execute(*me, msg.data.commandName, consoleArgs);
  }
}

void ActionListener::OnCraftItem(const RawMessageData& rawMsgData,
                                 const CraftItemMessage& msg)
{
  craftService->OnCraftItem(rawMsgData, msg.data.craftInputObjects,
                            msg.data.workbench, msg.data.resultObjectId);
}

void ActionListener::OnHostAttempt(const RawMessageData& rawMsgData,
                                   const HostMessage& msg)
{
  uint32_t remoteId = FormIdCasts::LongToNormal(msg.remoteId);

  MpActor* me = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!me) {
    throw std::runtime_error("Unable to host without actor attached");
  }

  auto& remote = partOne.worldState.GetFormAt<MpObjectReference>(remoteId);

  auto user = partOne.serverState.UserByActor(remote.AsActor());
  if (user != Networking::InvalidUserId) {
    return;
  }

  // The gamemode can reserve an actor for one hoster (companions)
  if (!FireGamemodeEvent(partOne.worldState, me->GetFormId(), "onHostAttempt",
                         nlohmann::json::array({ remoteId }))) {
    return;
  }

  // find, not []: AssignHoster tells a first host by the missing entry
  auto hosterIt = partOne.worldState.hosters.find(remoteId);
  const uint32_t hoster =
    hosterIt == partOne.worldState.hosters.end() ? 0 : hosterIt->second;

  auto remoteIdx = remote.GetIdx();

  std::optional<std::chrono::system_clock::time_point> lastRemoteUpdate;
  if (partOne.worldState.lastMovUpdateByIdx.size() > remoteIdx) {
    lastRemoteUpdate = partOne.worldState.lastMovUpdateByIdx[remoteIdx];
  }

  const auto hostResetTimeout = std::chrono::seconds(2);

  if (hoster == 0 || !lastRemoteUpdate ||
      std::chrono::system_clock::now() - *lastRemoteUpdate >
        hostResetTimeout) {
    // The grant (HostStart, HostStop to the old hoster, listeners, stamp, health resync) is shared with the
    // gamemode's mp.setHoster, so a server-chosen host and a requested one behave the same
    partOne.AssignHoster(remoteId, me->GetFormId());
  }
}

void ActionListener::OnCustomEvent(const RawMessageData& rawMsgData,
                                   const CustomEventMessage& msg)
{
  auto ac = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!ac) {
    return;
  }
  if (msg.eventName.empty() || msg.eventName[0] != '_') {
    return;
  }

  nlohmann::json jsonArray = nlohmann::json::array();

  for (auto& arg : msg.argsJsonDumps) {
    jsonArray.push_back(nlohmann::json::parse(arg));
  }

  const std::string jsonArrayDump = jsonArray.dump();

  for (auto& listener : partOne.GetListeners()) {
    CustomEvent customEvent(ac->GetFormId(), msg.eventName, jsonArrayDump);
    listener->OnMpApiEvent(customEvent);
  }
}

void ActionListener::OnChangeValues(const RawMessageData& rawMsgData,
                                    const ChangeValuesMessage& msg)
{
  MpActor* actor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!actor) {
    return spdlog::error(
      "ActionListener::OnChangeValues - no Actor attached to userId {}",
      rawMsgData.userId);
  }

  const auto now = std::chrono::steady_clock::now();
  const float timeAfterHealthRegeneration = CropPeriodAfterLastRegen(
    actor->GetDurationOfPercentageUpdate(espm::ActorValue::Health, now)
      .count());
  const float timeAfterMagickaRegeneration = CropPeriodAfterLastRegen(
    actor->GetDurationOfPercentageUpdate(espm::ActorValue::Magicka, now)
      .count());
  const float timeAfterStaminaRegeneration =
    actor->GetDurationOfPercentageUpdate(espm::ActorValue::Stamina, now)
      .count();

  const auto& currentValues = actor->GetActorValues();

  ChangeValuesMessage outMsg;
  outMsg.idx = actor->GetIdx();
  bool sendOutMsg = false;

  auto process = [&](espm::ActorValue av, std::optional<float> inputVal,
                     float currentVal, std::optional<float>& outVal) {
    if (!inputVal.has_value()) {
      return;
    }

    if (MathUtils::IsNearlyEqual(currentVal, *inputVal)) {
      return;
    }

    // Echo a freshly restored value, the client's report predates it
    if (actor->ShouldSkipRestoration(av)) {
      outVal = currentVal;
      sendOutMsg = true;
      actor->SetLastPercentageUpdate(av, now);
      return;
    }

    float newVal = *inputVal;

    if (av == espm::ActorValue::Health) {
      newVal =
        CropHealthRegeneration(newVal, timeAfterHealthRegeneration, actor);
    } else if (av == espm::ActorValue::Magicka) {
      newVal =
        CropMagickaRegeneration(newVal, timeAfterMagickaRegeneration, actor);
    } else if (av == espm::ActorValue::Stamina) {
      newVal =
        CropStaminaRegeneration(newVal, timeAfterStaminaRegeneration, actor);
    }

    if (!MathUtils::IsNearlyEqual(newVal, *inputVal)) {
      outVal = newVal;
      sendOutMsg = true;
    }

    actor->SetPercentage(av, newVal);
  };

  process(espm::ActorValue::Health, msg.data.health,
          currentValues.healthPercentage, outMsg.data.health);
  process(espm::ActorValue::Magicka, msg.data.magicka,
          currentValues.magickaPercentage, outMsg.data.magicka);
  process(espm::ActorValue::Stamina, msg.data.stamina,
          currentValues.staminaPercentage, outMsg.data.stamina);

  if (sendOutMsg) {
    actor->SendToUser(outMsg, true);
  }
}

namespace {

bool IsUnarmedAttack(const uint32_t sourceFormId)
{
  return sourceFormId == 0x1f4;
}

float CalculateCurrentHealthPercentage(const MpActor& actor, float damage,
                                       float healthPercentage,
                                       float* outBaseHealth)
{
  const uint32_t baseId = actor.GetBaseId();
  const uint32_t raceId = actor.GetRaceId();
  WorldState* espmProvider = actor.GetParent();

  BaseActorValues maximum =
    GetBaseActorValues(espmProvider, baseId, raceId, actor.GetTemplateChain());
  actor.AddLevelBonus(maximum);
  const float baseHealth = maximum.health;

  if (outBaseHealth) {
    *outBaseHealth = baseHealth;
  }

  const float damagePercentage = damage / baseHealth;
  const float currentHealthPercentage = healthPercentage - damagePercentage;

  /// TODO add check for nan and inf!
  return currentHealthPercentage <= 0.f ? 0.f : currentHealthPercentage;
}

float GetReach(const MpActor& actor, const uint32_t source,
               float reachHotfixMult)
{
  auto espmProvider = actor.GetParent();
  if (IsUnarmedAttack(source)) {
    uint32_t raceId = actor.GetRaceId();
    return reachHotfixMult *
      espm::GetData<espm::RACE>(raceId, espmProvider).unarmedReach;
  }
  auto weapDNAM = espm::GetData<espm::WEAP>(source, espmProvider).weapDNAM;
  float fCombatDistance =
    espm::GetData<espm::GMST>(espm::GMST::kFCombatDistance, espmProvider)
      .value;
  float weaponReach = weapDNAM ? weapDNAM->reach : 0;
  return reachHotfixMult * weaponReach * fCombatDistance;
}

NiPoint3 RotateZ(const NiPoint3& point, float angle)
{
  static const float kPi = std::acos(-1.f);
  static const float kAngleToRadians = kPi / 180.f;
  float cos = std::cos(angle * kAngleToRadians);
  float sin = std::sin(angle * kAngleToRadians);

  return { point.x * cos - point.y * sin, point.x * sin + point.y * cos,
           point.z };
}

float GetSqrDistanceToBounds(const MpActor& actor, const MpActor& target)
{
  // TODO(#491): Figure out where to take the missing reach component
  constexpr float kPatch = 15.f;

  auto bounds = actor.GetBounds();
  auto targetBounds = target.GetBounds();

  // "Y" is "face" of character
  const float angleZ = 90.f - target.GetAngle().z;
  float direction = actor.GetAngle().z;

  // vector from target to the actor
  NiPoint3 position = actor.GetPos() - target.GetPos();
  position += RotateZ(
    NiPoint3(kPatch + bounds.pos2[1], 0.f, 0.f + bounds.pos2[2]), direction);

  NiPoint3 pos = RotateZ(position, angleZ);

  bool isProjectionInside[3] = {
    (targetBounds.pos1[0] <= pos.x && pos.x <= targetBounds.pos2[0]),
    (targetBounds.pos1[1] <= pos.y && pos.y <= targetBounds.pos2[1]),
    (targetBounds.pos1[2] <= pos.z && pos.z <= targetBounds.pos2[2])
  };

  NiPoint3 nearestCorner = {
    pos[0] > 0 ? 0.f + targetBounds.pos2[0] : 0.f + targetBounds.pos1[0],
    pos[1] > 0 ? 0.f + targetBounds.pos2[1] : 0.f + targetBounds.pos1[1],
    pos[2] > 0 ? 0.f + targetBounds.pos2[2] : 0.f + targetBounds.pos1[2],
  };

  return NiPoint3(isProjectionInside[0] ? 0.f : pos.x - nearestCorner.x,
                  isProjectionInside[1] ? 0.f : pos.y - nearestCorner.y,
                  isProjectionInside[2] ? 0.f : pos.z - nearestCorner.z)
    .SqrLength();
}

bool IsBowOrCrossbowShot(const HitData& hitData, WorldState* worldState)
{
  if (!worldState || !worldState->HasEspm()) {
    return false;
  }

  if (hitData.isBashAttack) {
    return false;
  }

  auto sourceLookupRes =
    worldState->GetEspm().GetBrowser().LookupById(hitData.source);
  if (!sourceLookupRes.rec) {
    return false;
  }

  auto source = espm::Convert<espm::WEAP>(sourceLookupRes.rec);
  if (!source) {
    return false;
  }

  auto weapDNAM = source->GetData(worldState->GetEspmCache()).weapDNAM;

  if (weapDNAM->animType != espm::WEAP::AnimType::Bow &&
      weapDNAM->animType != espm::WEAP::AnimType::Crossbow) {
    return false;
  }

  return true;
}

bool IsDistanceValid(const MpActor& actor, const MpActor& targetActor,
                     const HitData& hitData)
{
  float sqrDistance = GetSqrDistanceToBounds(actor, targetActor);

  // TODO: fix bounding boxes for creatures such as chicken, mudcrab, etc
  float reachPveHotfixMult =
    (actor.GetBaseId() <= 0x7 && targetActor.GetBaseId() <= 0x7)
    ? 1.f
    : std::numeric_limits<float>::infinity();

  float reach = GetReach(actor, hitData.source, reachPveHotfixMult);

  // For bow/crossbow shots we don't want to check melee radius
  if (IsBowOrCrossbowShot(hitData, actor.GetParent())) {
    constexpr float kExteriorCellWidthUnits = 4096.f;
    reach = kExteriorCellWidthUnits * 2;
  }

  return reach * reach > sqrDistance;
}

bool CanHit(const MpActor& actor, const HitData& hitData,
            const std::chrono::duration<float>& timePassed)
{
  WorldState* espmProvider = actor.GetParent();
  auto weapDNAM =
    espm::GetData<espm::WEAP>(hitData.source, espmProvider).weapDNAM;

  if (weapDNAM) {
    float speedMult = weapDNAM->speed;
    return timePassed.count() >= (1.1 * (1 / speedMult)) -
      (1.1 * (1 / speedMult) * (speedMult <= 0.75 ? 0.45 : 0.3));
  }

  throw std::runtime_error(
    fmt::format("Cannot get weapon speed from source: {0:x}", hitData.source));
}

bool ShouldBeBlocked(const MpActor& aggressor, const MpActor& target)
{
  NiPoint3 targetViewDirection = target.GetViewDirection();
  NiPoint3 aggressorDirection = aggressor.GetPos() - target.GetPos();
  // A block faces the attacker around, not up or down: height must not decide it (review SCH2-5)
  aggressorDirection.z = 0;
  if (targetViewDirection * aggressorDirection <= 0) {
    return false;
  }
  const float lengths =
    targetViewDirection.Length() * aggressorDirection.Length();
  if (lengths <= 0.f) {
    return false;
  }
  // Guard: rounding could put the cosine of a dead-on facing above 1, where acos is NaN (not seen in the unit test)
  const float cosine = std::clamp(
    (targetViewDirection * aggressorDirection) / lengths, -1.f, 1.f);
  return std::acos(cosine) < 1;
}
}

void ActionListener::OnHit(const RawMessageData& rawMsgData,
                           const HitMessage& msg)
{
  MpActor* myActor = partOne.serverState.ActorByUser(rawMsgData.userId);

  if (!myActor) {
    return spdlog::error(
      "ActionListener::OnHit - no Actor attached to userId {}",
      rawMsgData.userId);
  }

  MpActor* aggressor = nullptr;

  HitData hitData = msg.data;
  if (hitData.aggressor == 0x14) {
    aggressor = myActor;
    hitData.aggressor = aggressor->GetFormId();
  } else {
    aggressor = &partOne.worldState.GetFormAt<MpActor>(hitData.aggressor);
    auto it = partOne.worldState.hosters.find(hitData.aggressor);
    if (it == partOne.worldState.hosters.end() ||
        it->second != myActor->GetFormId()) {
      spdlog::error("SendToNeighbours - No permission to send OnHit with "
                    "aggressor actor {:x}",
                    aggressor->GetFormId());
      return;
    }
  }

  if (IsParalyzed(*aggressor)) {
    spdlog::info("ActionListener::OnHit - {:x} is paralysed and cannot hit",
                 aggressor->GetFormId());
    return;
  }

  if (hitData.target == 0x14) {
    hitData.target = myActor->GetFormId();
  }

  MpForm* targetForm = partOne.worldState.LookupFormById(hitData.target).get();
  MpObjectReference* targetRef =
    targetForm ? targetForm->AsObjectReference() : nullptr;
  if (!targetRef) {
    spdlog::error("ActionListener::OnHit - MpObjectReference not found for "
                  "hitData.target {:x}",
                  hitData.target);
    return;
  }

  const FormDesc& aggressorCellOrWorld = aggressor->GetCellOrWorld();
  const FormDesc& targetCellOrWorld = targetRef->GetCellOrWorld();

  if (aggressorCellOrWorld != targetCellOrWorld) {
    const EspmFileTable& files = partOne.worldState.espmFiles;
    spdlog::error(
      "ActionListener::OnHit - aggressor and targetRef are in different cells "
      "or world. Aggressor: {:x}, targetRef: {:x}, cellOrWorld of aggressor: "
      "{:x}, cellOrWorld of targetRef: {:x}",
      aggressor->GetFormId(), targetRef->GetFormId(),
      aggressorCellOrWorld.ToFormId(files), targetCellOrWorld.ToFormId(files));
    return;
  }

  // TODO: repair IsDistanceValid instead
  if (!IsBowOrCrossbowShot(hitData, &partOne.worldState)) {
    const NiPoint3& aggressorPos = aggressor->GetPos();
    const NiPoint3& targetPos = targetRef->GetPos();
    constexpr float kExteriorCellWidthUnits = 4096.f;
    if ((aggressorPos - targetPos).SqrLength() >
        kExteriorCellWidthUnits * kExteriorCellWidthUnits) {
      spdlog::error("ActionListener::OnHit - aggressor and targetRef are too "
                    "distant. Aggressor: {:x}, targetRef: {:x}",
                    aggressor->GetFormId(), targetRef->GetFormId());
      return;
    }
  }

  if (aggressor->IsDead()) {
    spdlog::debug(fmt::format("{:x} actor is dead and can't attack. "
                              "requesting respawn in order to fix death state",
                              aggressor->GetFormId()));
    aggressor->RespawnWithDelay(true);
    return;
  }

  auto sourceInEspm =
    partOne.GetEspm().GetBrowser().LookupById(hitData.source);

  const bool isSourceSpell =
    sourceInEspm.rec && sourceInEspm.rec->GetType() == espm::SPEL::kType;
  const bool isSourceScroll =
    sourceInEspm.rec && sourceInEspm.rec->GetType() == espm::SCRL::kType;

  const auto equipment = aggressor->GetEquipment();

  // A scroll's hit is a spell hit. It went to OnWeaponHit (a held scroll is equipment) and threw 'Expected record to be
  // WEAP, but found SCRL', so a scroll was used up and did nothing (review SCH-1, 2026-09-26). Only a scroll the server
  // just used up for this caster may hit, a few times, for a short while.
  if (isSourceScroll) {
    if (TakeScrollHit(aggressor->GetFormId(), hitData.source,
                      hitData.target)) {
      OnSpellHit(aggressor, targetRef, hitData);
    } else {
      spdlog::info("ActionListener::OnHit - {:x} has no scroll {:x} read "
                   "lately, hit refused",
                   hitData.aggressor, hitData.source);
    }
    return;
  }

  if (isSourceSpell) {
    // A wall or cloak scroll hits with the spell it grants (review SCH1-R3)
    if (CanHitWithSpell(*aggressor, hitData.source) ||
        TakeScrollGrantedHit(aggressor->GetFormId(), hitData.source)) {
      OnSpellHit(aggressor, targetRef, hitData);
    } else {
      spdlog::info("ActionListener::OnHit - {:x} cannot hit with spell {:x}",
                   hitData.aggressor, hitData.source);
    }
    return;
  }

  const bool isUnarmed = IsUnarmedAttack(hitData.source);

  if (equipment.inv.HasItem(hitData.source) || isUnarmed) {
    OnWeaponHit(aggressor, targetRef, hitData, isUnarmed);
    return;
  }

  if (aggressor->GetInventory().HasItem(hitData.source) == false) {
    spdlog::debug("{:x} actor has no {:x} weapon and can't attack",
                  hitData.aggressor, hitData.source);
  }

  spdlog::debug("{:x} weapon is not equipped by {:x} actor and cannot be used",
                hitData.source, hitData.aggressor);
}

void ActionListener::OnUpdateAnimVariables(
  const RawMessageData& rawMsgData, const UpdateAnimVariablesMessage& msg)
{
  const MpActor* myActor = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!myActor) {
    // The client sends these twice a second from the moment it connects, so
    // every login logged one throw per packet until the character loaded.
    // There is nothing to relay without an actor, so drop it quietly.
    return;
  }

  SendToNeighbours(myActor->idx, rawMsgData);
}

void ActionListener::OnSpellCast(const RawMessageData& rawMsgData,
                                 const SpellCastMessage& msg)
{
  MpActor* myActor = partOne.serverState.ActorByUser(rawMsgData.userId);

  if (!myActor) {
    throw std::runtime_error("Unable to change values without Actor attached");
  }

  MpActor* caster = nullptr;

  SpellCastData spellCastData = msg.data;

  if (spellCastData.caster == 0x14 ||
      spellCastData.caster == myActor->GetFormId()) {
    caster = myActor;
    spellCastData.caster = caster->GetFormId();
  } else {
    caster = &partOne.worldState.GetFormAt<MpActor>(spellCastData.caster);
    const auto it = partOne.worldState.hosters.find(spellCastData.caster);

    if (it == partOne.worldState.hosters.end() ||
        it->second != myActor->GetFormId()) {
      spdlog::error(
        "SendToNeighbours - No permission to send OnSpellCast with "
        "caster actor {:x}",
        caster->GetFormId());
      return;
    }
  }

  if (spellCastData.target == 0x14) {
    spellCastData.target = myActor->GetFormId();
  }

  // Stops are relayed before the death, equipment and denylist gates so none is dropped
  // Relays are reliable so observers get casts, keep-alives and stops in order
  if (spellCastData.interruptCast) {
    SendToNeighbours(myActor->idx, rawMsgData, true);
    UpdateWardChannel(caster->GetFormId(), spellCastData);
    // Only the stopped spell's channel ends, the other hand may still heal
    auto channelIt = restorationChannels.find(caster->GetFormId());
    const bool hadChannel = channelIt != restorationChannels.end() &&
      channelIt->second.spellId == spellCastData.spell;
    if (hadChannel) {
      const RestorationChannel channel = std::move(channelIt->second);
      restorationChannels.erase(channelIt);
      ApplyRestorationChannelRemainder(caster->GetFormId(), channel);
    }
    spdlog::info("ActionListener::OnSpellCast - {:x} interrupted spell {:x} "
                 "(restoration channel erased: {})",
                 caster->GetFormId(), spellCastData.spell, hadChannel);
    return;
  }

  if (IsParalyzed(*caster)) {
    spdlog::info("ActionListener::OnSpellCast - {:x} is paralysed and cannot "
                 "cast",
                 caster->GetFormId());
    return;
  }

  if (caster->IsDead()) {
    spdlog::info(fmt::format("{:x} actor is dead and can't spell cast. "
                             "requesting respawn in order to fix death state",
                             caster->GetFormId()));
    caster->RespawnWithDelay(true);
    return;
  }

  if (!CanCastSpell(*caster, spellCastData.spell)) {
    spdlog::info("ActionListener::OnSpellCast - spell {0:x} not "
                 "found in equipment of {1:x}",
                 spellCastData.spell, caster->GetFormId());
    return;
  }

  // Server-settings denylist (blockedSpells): never replicated, no OnSpellCast
  if (partOne.worldState.IsSpellBlocked(spellCastData.spell)) {
    spdlog::info("ActionListener::OnSpellCast - spell {:x} is blocked by "
                 "server settings",
                 spellCastData.spell);
    return;
  }

  // Decided before any handler runs, which could take or unequip the scroll
  const bool scrollCast =
    !caster->GetEquipment().IsSpellEquipped(spellCastData.spell) &&
    IsHeldScroll(*caster, spellCastData.spell);

  SendToNeighbours(myActor->idx, rawMsgData, true);
  UpdateWardChannel(caster->GetFormId(), spellCastData);

  auto& browser = partOne.worldState.GetEspm().GetBrowser();

  const std::array<VarValue, 1> args{ VarValue(
    std::make_shared<EspmGameObject>(
      browser.LookupById(spellCastData.spell))) };

  caster->SendPapyrusEvent("OnSpellCast", args.data(), args.size());

  if (!spellCastData.keepAlive) {
    FireGamemodeEvent(partOne.worldState, caster->GetFormId(), "onSpellCast",
                      nlohmann::json::array({ spellCastData.spell }));
  }

  // A scroll is read once: one leaves the caster's inventory per cast, and its hits may land for a short while
  // (TakeScrollHit). The restorative handling below is for spells the caster knows, so a scroll stops here.
  if (scrollCast) {
    if (!spellCastData.keepAlive && IsHeldScroll(*caster, spellCastData.spell)) {
      caster->RemoveItem(spellCastData.spell, 1, nullptr);
      RecordScrollRead(caster->GetFormId(), spellCastData.spell);
      spdlog::info("ActionListener::OnSpellCast - {:x} read scroll {:x}",
                   caster->GetFormId(), spellCastData.spell);
    }
    return;
  }

  const auto targetRef = std::dynamic_pointer_cast<MpObjectReference>(
    partOne.worldState.LookupFormById(spellCastData.target));

  // Restorative (non-hostile) effects apply here; hostile damage stays on the OnSpellHit path
  const auto spellData =
    espm::GetData<espm::SPEL>(spellCastData.spell, &partOne.worldState);

  MpActor* targetActor = nullptr;
  const bool selfDelivery = spellData.spellItem &&
    spellData.spellItem->delivery == espm::SPEL::Delivery::Self;

  // The cast event's target is always the caster, fire-and-forget heals on others land in OnSpellHit
  if (!selfDelivery && spellData.spellItem &&
      spellData.spellItem->castType == espm::SPEL::CastType::FireAndForget) {
    return;
  }

  if (selfDelivery) {
    targetActor = caster;
  } else if (targetRef) {
    targetActor = targetRef->AsActor();
  }

  if (!targetActor) {
    return;
  }

  if (targetActor != caster) {
    if (targetActor->GetCellOrWorld() != caster->GetCellOrWorld()) {
      return;
    }
    constexpr float kMaxHealDistance = 4096.f;
    if ((targetActor->GetPos() - caster->GetPos()).SqrLength() >
        kMaxHealDistance * kMaxHealDistance) {
      return;
    }
  }

  auto restoreEffects =
    GetRestorativeEffects(&partOne.worldState, spellCastData.spell, false);

  if (!restoreEffects.empty()) {
    const bool hasSweetpie = HasSweetPie(partOne.worldState);

    const bool isConcentration = spellData.spellItem &&
      spellData.spellItem->castType == espm::SPEL::CastType::Concentration;
    const uint32_t casterId = caster->GetFormId();
    auto existing = restorationChannels.find(casterId);
    const bool hadChannel = existing != restorationChannels.end();

    // Concentration heals accrue per second of channel so a tap heals a tap's worth
    if (!isConcentration && !spellCastData.keepAlive) {
      targetActor->ApplyMagicEffects(restoreEffects, hasSweetpie);
      spdlog::info("ActionListener::OnSpellCast - applied {} restorative "
                   "effect(s) of spell {:x} to actor {:x}",
                   restoreEffects.size(), spellCastData.spell,
                   targetActor->GetFormId());
    }

    // Concentration restoratives heal per second until a stop, a failed check or a missed keep-alive
    if (isConcentration) {
      const auto now = std::chrono::steady_clock::now();
      RestorationChannel channel;
      channel.spellId = spellCastData.spell;
      // Keep-alives resend the caster as target, a beam hit's retarget must survive them
      const bool keepsTarget = hadChannel && spellCastData.keepAlive &&
        existing->second.spellId == spellCastData.spell;
      channel.targetId = keepsTarget ? existing->second.targetId
                                     : targetActor->GetFormId();
      channel.effects = restoreEffects;
      channel.hasSweetpie = hasSweetpie;
      channel.lastRefresh = now;
      // A live channel keeps its generation and accrual so its timer chain carries on
      channel.generation = hadChannel ? existing->second.generation
                                      : ++restorationChannelGeneration;
      channel.lastApplied = hadChannel ? existing->second.lastApplied : now;
      const uint32_t generation = channel.generation;
      restorationChannels[casterId] = std::move(channel);
      if (!hadChannel) {
        spdlog::info("ActionListener::OnSpellCast - opened restoration "
                     "channel of spell {:x} on actor {:x}",
                     spellCastData.spell, targetActor->GetFormId());
        partOne.worldState.SetTimer(std::chrono::milliseconds(1000))
          .Then([this, casterId, generation](Viet::Void) {
            TickRestorationChannel(casterId, generation);
          });
      }
    }
  }
}

void ActionListener::TickRestorationChannel(uint32_t casterId,
                                            uint32_t generation)
{
  auto it = restorationChannels.find(casterId);
  // A different generation means this chain belongs to a replaced channel
  if (it == restorationChannels.end() ||
      it->second.generation != generation) {
    return;
  }
  auto& channel = it->second;

  constexpr uint32_t kMaxChannelTicks = 30;

  const auto now = std::chrono::steady_clock::now();
  const bool refreshed = now - channel.lastRefresh <= kCastRefreshTimeout;
  if (!refreshed) {
    spdlog::info("ActionListener::TickRestorationChannel - channel of {:x} "
                 "expired without keep-alive",
                 casterId);
  }

  MpActor* targetActor = refreshed && ++channel.ticks <= kMaxChannelTicks
    ? GetRestorationChannelTarget(casterId, channel)
    : nullptr;
  if (!targetActor) {
    restorationChannels.erase(it);
    return;
  }

  channel.lastApplied = now;
  targetActor->ApplyMagicEffects(channel.effects, channel.hasSweetpie);

  partOne.worldState.SetTimer(std::chrono::milliseconds(1000))
    .Then([this, casterId, generation](Viet::Void) {
      TickRestorationChannel(casterId, generation);
    });
}

MpActor* ActionListener::GetRestorationChannelTarget(
  uint32_t casterId, const RestorationChannel& channel)
{
  auto& worldState = partOne.worldState;
  auto casterForm = worldState.LookupFormById(casterId);
  MpActor* caster = casterForm
    ? std::dynamic_pointer_cast<MpActor>(casterForm).get()
    : nullptr;
  if (!caster || caster->IsDead() ||
      partOne.GetUserByActor(casterId) == Networking::InvalidUserId ||
      !caster->GetEquipment().IsSpellEquipped(channel.spellId)) {
    return nullptr;
  }

  auto targetForm = worldState.LookupFormById(channel.targetId);
  MpActor* targetActor = targetForm
    ? std::dynamic_pointer_cast<MpActor>(targetForm).get()
    : nullptr;
  if (!targetActor || targetActor->IsDead()) {
    return nullptr;
  }

  if (targetActor != caster) {
    constexpr float kMaxHealDistance = 4096.f;
    if (targetActor->GetCellOrWorld() != caster->GetCellOrWorld() ||
        (targetActor->GetPos() - caster->GetPos()).SqrLength() >
          kMaxHealDistance * kMaxHealDistance) {
      return nullptr;
    }
  }
  return targetActor;
}

// A stopped channel still owes the part of a second since its last tick
void ActionListener::ApplyRestorationChannelRemainder(
  uint32_t casterId, const RestorationChannel& channel)
{
  const std::chrono::duration<float> sinceApplied =
    std::chrono::steady_clock::now() - channel.lastApplied;
  const float fraction = std::clamp(sinceApplied.count(), 0.f, 1.f);
  MpActor* targetActor =
    fraction > 0.f ? GetRestorationChannelTarget(casterId, channel) : nullptr;
  if (!targetActor) {
    return;
  }

  auto effects = channel.effects;
  for (auto& effect : effects) {
    effect.magnitude *= fraction;
  }
  targetActor->ApplyMagicEffects(effects, channel.hasSweetpie);
}

void ActionListener::OnUnknown(const RawMessageData& rawMsgData)
{
  spdlog::warn("ActionListener::OnUnknown - Got unhandled message");
}

void ActionListener::OnSpellHit(MpActor* aggressor,
                                MpObjectReference* targetRef,
                                const HitData& hitData)
{
  auto* targetActorPtr = targetRef ? targetRef->AsActor() : nullptr;
  if (!targetActorPtr) {
    SendPapyrusOnHitEvent(aggressor, targetRef, hitData);
    return; // Not an actor, damage calculation is not needed
  }

  auto targetActorValues = targetActorPtr->GetChangeForm().actorValues;

  SpellCastData spellCastData{ aggressor->GetFormId(),
                               targetActorPtr->GetFormId(),
                               hitData.source,
                               false,
                               false,
                               SpellType::Left };

  float damage =
    partOne.CalculateDamage(*aggressor, *targetActorPtr, spellCastData);
  damage = damage <= 0.f ? 0.f : damage;

  const bool wardBlocked = IsWardBlocking(*aggressor, *targetActorPtr);
  // A fully blocked attack still asks the gamemode, so god mode and companions see it
  const bool blockedAttack = wardBlocked && damage > 0.f;
  const nlohmann::json spellFlags = { { "spell", true },
                                      { "blocked", wardBlocked },
                                      { "power", false },
                                      { "bash", false },
                                      { "sneak", false },
                                      { "unblockedDamage", damage } };
  if (wardBlocked) {
    damage *= kBlockedHitDamageMult;
    spdlog::info("OnSpellHit - ward of {:x} blocked spell {:x} of {:x}",
                 targetActorPtr->GetFormId(), hitData.source,
                 aggressor->GetFormId());
  }

  if (!FireHitDamageEvent("onHitDamageAttempt", aggressor, targetActorPtr,
                          hitData.source, damage, blockedAttack,
                          &spellFlags)) {
    return;
  }

  // A refused hit fires no events, a ward-blocked one reaches scripts as blocked and triggers no spell effect
  HitData firedHitData = hitData;
  firedHitData.isHitBlocked = wardBlocked;
  SendPapyrusOnHitEvent(aggressor, targetRef, firedHitData);
  if (!wardBlocked) {
    // Fires for dead targets and zero damage too (Reanimate, Banish)
    FireGamemodeEvent(
      partOne.worldState, aggressor->GetFormId(), "onSpellHit",
      nlohmann::json::array({ targetActorPtr->GetFormId(), hitData.source }));
  }

  targetActorValues.healthPercentage = CalculateCurrentHealthPercentage(
    *targetActorPtr, damage, targetActorValues.healthPercentage, nullptr);

  static const auto kHealthAvFilter =
    std::vector<espm::ActorValue>{ espm::ActorValue::Health };

  targetActorPtr->NetSetPercentages(targetActorValues, aggressor,
                                    kHealthAvFilter);

  spdlog::info("OnSpellHit - Target {0:x} is hit by {1:x} spell on {2} "
               "damage. By caster: {3:x})",
               spellCastData.target, spellCastData.spell, damage,
               spellCastData.caster);

  FireHitDamageEvent("onHitDamage", aggressor, targetActorPtr, hitData.source,
                     damage, false, &spellFlags);

  if (!wardBlocked) {
    ApplyParalysis(*aggressor, *targetActorPtr, hitData.source);
  }

  // Heal Other and the area share of self heals (Grand Healing) restore their target here, the caster heals on cast
  if (targetActorPtr == aggressor || targetActorPtr->IsDead()) {
    return;
  }
  const auto spellData =
    espm::GetSpellItemData(hitData.source, &partOne.worldState);
  if (!spellData.spellItem) {
    return;
  }
  // The beam's hit names the real target, the channel's ticks do the healing
  if (spellData.spellItem->castType == espm::SPEL::CastType::Concentration) {
    auto channelIt = restorationChannels.find(aggressor->GetFormId());
    if (channelIt == restorationChannels.end() ||
        channelIt->second.spellId != hitData.source ||
        channelIt->second.targetId == targetActorPtr->GetFormId()) {
      return;
    }
    auto& channel = channelIt->second;
    const uint32_t previousTargetId = channel.targetId;
    channel.targetId = targetActorPtr->GetFormId();
    if (!GetRestorationChannelTarget(aggressor->GetFormId(), channel)) {
      channel.targetId = previousTargetId;
      return;
    }
    spdlog::info("OnSpellHit - retargeted restoration channel of spell {:x} "
                 "from actor {:x} to actor {:x}",
                 hitData.source, previousTargetId, channel.targetId);
    return;
  }
  if (spellData.spellItem->castType != espm::SPEL::CastType::FireAndForget) {
    return;
  }
  const bool selfDelivery =
    spellData.spellItem->delivery == espm::SPEL::Delivery::Self;
  auto restoreEffects =
    GetRestorativeEffects(&partOne.worldState, hitData.source, selfDelivery);
  if (restoreEffects.empty()) {
    return;
  }
  targetActorPtr->ApplyMagicEffects(restoreEffects,
                                    HasSweetPie(partOne.worldState));
  spdlog::info("OnSpellHit - applied {} restorative effect(s) of spell {:x} "
               "to actor {:x}",
               restoreEffects.size(), hitData.source,
               targetActorPtr->GetFormId());
}

void ActionListener::OnWeaponHit(MpActor* aggressor,
                                 MpObjectReference* targetRef, HitData hitData,
                                 [[maybe_unused]] bool isUnarmed)
{
  const auto currentHitTime = std::chrono::steady_clock::now();

  auto* targetActorPtr = targetRef ? targetRef->AsActor() : nullptr;
  if (!targetActorPtr) {
    SendPapyrusOnHitEvent(aggressor, targetRef, hitData);
    return; // Not an actor, damage calculation is not needed
  }

  auto& targetActor = *targetActorPtr;

  const auto lastHitTimeAnyTarget = aggressor->GetLastHitTime(std::nullopt);
  const std::chrono::duration<float> timePassedAnyTarget =
    currentHitTime - lastHitTimeAnyTarget;

  constexpr float kSplashTimeWindow = 0.1f;
  constexpr size_t kMaxSplashTargets = 4;

  // Splash attack detection. Non-vanilla feature, fixes anticheat-vs-mod
  // issues
  const bool isSplash = timePassedAnyTarget.count() < kSplashTimeWindow;

  if (isSplash) {
    spdlog::info("Splash attack detected from aggressor {:x} to target {:x}",
                 aggressor->GetFormId(), targetActor.GetFormId());

    // Check if THIS specific target was hit recently
    auto lastHitSpecific = aggressor->GetLastHitTime(targetActor.GetFormId());
    std::chrono::duration<float> timeSinceSpecific =
      currentHitTime - lastHitSpecific;

    // If the specific target was hit faster than the splash window
    if (timeSinceSpecific.count() < kSplashTimeWindow) {
      spdlog::warn("Splash attack from {:x} to {:x} ignored, target hit "
                   "too recently",
                   aggressor->GetFormId(), targetActor.GetFormId());
      return;
    }

    if (aggressor->CountRecentHits(std::chrono::duration<float>(
          kSplashTimeWindow)) >= kMaxSplashTargets) {
      spdlog::warn("Splash attack from {:x} to {:x} ignored, too many "
                   "targets hit recently",
                   aggressor->GetFormId(), targetActor.GetFormId());
      return;
    }
  } else if (!CanHit(*aggressor, hitData, timePassedAnyTarget)) {
    WorldState* espmProvider = targetActor.GetParent();
    auto weapDNAM =
      espm::GetData<espm::WEAP>(hitData.source, espmProvider).weapDNAM;
    float expectedAttackTime = (1.1 * (1 / weapDNAM->speed)) -
      (1.1 * (1 / weapDNAM->speed) * (weapDNAM->speed <= 0.75 ? 0.45 : 0.3));
    spdlog::debug(
      "OnWeaponHit - Target {0:x} is not available for attack due to fast "
      "attack speed. Weapon: {1:x}. Elapsed time: {2}. Expected attack time: "
      "{3}",
      hitData.target, hitData.source, timePassedAnyTarget.count(),
      expectedAttackTime);
    return;
  }

  // if (IsDistanceValid(*aggressor, targetActor, hitData) == false) {
  //   float distance =
  //     std::sqrt(GetSqrDistanceToBounds(*aggressor, targetActor));

  //   // TODO: fix bounding boxes for creatures such as chicken, mudcrab, etc
  //   float reachPveHotfixMult =
  //     (aggressor->GetBaseId() <= 0x7 && targetActor.GetBaseId() <= 0x7)
  //     ? 1.f
  //     : std::numeric_limits<float>::infinity();

  //   float reach = GetReach(*aggressor, hitData.source, reachPveHotfixMult);
  //   uint32_t aggressorId = aggressor->GetFormId();
  //   uint32_t targetId = targetActor.GetFormId();
  //   spdlog::debug(
  //     fmt::format("{:x} actor can't reach {:x} target because distance {} is
  //     "
  //                 "greater then first actor attack radius {}",
  //                 aggressorId, targetId, distance, reach));
  //   return;
  // }

  ActorValues currentActorValues = targetActor.GetChangeForm().actorValues;

  float healthPercentage = currentActorValues.healthPercentage;

  // The server decides whether a hit was blocked, from the target's own block state below: the attacker's client
  // cannot claim a block it never met (review SCH-2; combat.js drains the blocker's stamina on a block)
  hitData.isHitBlocked = false;

  // A hosted NPC's block reaches the server only as its IsBlocking animation variable (its host's movement packet;
  // animationSystem skips hosted NPCs), and a player's blockStart travels unreliable: either one counts. Both come
  // from the target's side, so the attacker still cannot forge a block (review SCH2-1, SCH2-2).
  const bool targetBlocking = targetActor.IsBlockActive() ||
    targetActor.GetAnimationVariableBool("IsBlocking");
  if (targetBlocking) {
    if (ShouldBeBlocked(*aggressor, targetActor)) {
      bool isRemoteBowAttack = false;

      auto sourceLookupResult =
        targetActor.GetParent()->GetEspm().GetBrowser().LookupById(
          hitData.source);
      if (sourceLookupResult.rec &&
          sourceLookupResult.rec->GetType() == espm::WEAP::kType) {
        auto weapData =
          espm::GetData<espm::WEAP>(hitData.source, targetActor.GetParent());
        if (weapData.weapDNAM) {
          if (weapData.weapDNAM->animType == espm::WEAP::AnimType::Bow ||
              weapData.weapDNAM->animType == espm::WEAP::AnimType::Crossbow) {
            if (!hitData.isBashAttack) {
              isRemoteBowAttack = true;
            }
          }
        }
      }

      bool isBlockingByShield = false;

      auto targetActorEquipmentEntries =
        targetActor.GetEquipment().inv.entries;
      for (auto& entry : targetActorEquipmentEntries) {
        if (entry.GetWorn() != Inventory::Worn::None) {
          auto res =
            targetActor.GetParent()->GetEspm().GetBrowser().LookupById(
              entry.baseId);
          if (res.rec && res.rec->GetType() == espm::ARMO::kType) {
            auto data =
              espm::GetData<espm::ARMO>(entry.baseId, targetActor.GetParent());
            bool isShield = data.equipSlotId > 0;
            if (isShield) {
              isBlockingByShield = isShield;
            }
          }
        }
      }

      if (!isRemoteBowAttack || isBlockingByShield) {
        hitData.isHitBlocked = true;
      }
    }
  }

  // Power attacks and bashes stagger (combat.js). The flags come from the attacker's client, so one attacker gets at
  // most one such hit on one target per kForcefulHitInterval, and a modified client cannot stagger-lock anyone (SCH-2)
  if (hitData.isPowerAttack || hitData.isBashAttack) {
    const uint64_t pair =
      (static_cast<uint64_t>(aggressor->GetFormId()) << 32) |
      targetActor.GetFormId();
    auto& last = lastForcefulHit[pair];
    if (currentHitTime - last < kForcefulHitInterval) {
      spdlog::info("OnWeaponHit - {:x} power/bash on {:x} too soon after the "
                   "last one, counted as a plain hit",
                   aggressor->GetFormId(), targetActor.GetFormId());
      hitData.isPowerAttack = false;
      hitData.isBashAttack = false;
    } else {
      last = currentHitTime;
    }
    if (lastForcefulHit.size() > 4096) {
      std::erase_if(lastForcefulHit, [&](const auto& entry) {
        return currentHitTime - entry.second > std::chrono::seconds(10);
      });
    }
  }

  float damage = partOne.CalculateDamage(*aggressor, targetActor, hitData);
  damage = damage < 0.f ? 0.f : damage;
  // The target's full health and stamina, the base a hit is measured against, so the gamemode can turn points into the
  // percentages it sets (block chip, block stamina): the gamemode cannot read maxima server-side
  const BaseActorValues targetMax = targetActor.GetMaximumValues();
  // What the hit would have done unblocked, so the gamemode can let part of a blocked blow through (chip damage)
  float unblockedDamage = damage;
  if (hitData.isHitBlocked) {
    HitData unblocked = hitData;
    unblocked.isHitBlocked = false;
    unblockedDamage =
      std::max(0.f, partOne.CalculateDamage(*aggressor, targetActor, unblocked));
  }
  const nlohmann::json weaponFlags = {
    { "spell", false },
    { "blocked", static_cast<bool>(hitData.isHitBlocked) },
    { "power", static_cast<bool>(hitData.isPowerAttack) },
    { "bash", static_cast<bool>(hitData.isBashAttack) },
    { "sneak", static_cast<bool>(hitData.isSneakAttack) },
    { "unblockedDamage", unblockedDamage },
    { "targetMaxHealth", targetMax.health },
    { "targetMaxStamina", targetMax.stamina }
  };
  // A fully blocked attack still asks the gamemode, so god mode and companions see it
  if (!FireHitDamageEvent("onHitDamageAttempt", aggressor, &targetActor,
                          hitData.source, damage, hitData.isHitBlocked,
                          &weaponFlags)) {
    return;
  }
  // The gamemode may have changed the target's values inside onHitDamageAttempt (combat.js: block chip, the blocker's
  // stamina). Read them again, or NetSetPercentages below writes the earlier snapshot back over them (review SCH2-3).
  currentActorValues = targetActor.GetChangeForm().actorValues;
  healthPercentage = currentActorValues.healthPercentage;

  // A refused hit fires no events, a blocked one reaches scripts as blocked
  SendPapyrusOnHitEvent(aggressor, targetRef, hitData);

  float outBaseHealth = 0.f;
  currentActorValues.healthPercentage = CalculateCurrentHealthPercentage(
    targetActor, damage, healthPercentage, &outBaseHealth);

  currentActorValues.healthPercentage =
    currentActorValues.healthPercentage < 0.f
    ? 0.f
    : currentActorValues.healthPercentage;

  targetActor.NetSetPercentages(
    currentActorValues, aggressor,
    std::vector<espm::ActorValue>{ espm::ActorValue::Health });
  aggressor->SetLastHitTime(targetActor.GetFormId(), currentHitTime);

  spdlog::debug(
    "OnWeaponHit - Target {0:x} is hit by {1} damage. Percentage was: {3}, "
    "percentage now: {2}, base health: {4})",
    hitData.target, damage, currentActorValues.healthPercentage,
    healthPercentage, outBaseHealth);

  FireHitDamageEvent("onHitDamage", aggressor, &targetActor, hitData.source,
                     damage, false, &weaponFlags);
}

bool ActionListener::FireHitDamageEvent(const char* eventName,
                                        MpActor* aggressor, MpActor* target,
                                        uint32_t sourceId, float damage,
                                        bool fireOnZeroDamage,
                                        const nlohmann::json* hitFlags)
{
  if (!aggressor || !target || (damage <= 0.f && !fireOnZeroDamage)) {
    return true;
  }
  nlohmann::json argsJson = nlohmann::json::array();
  argsJson.push_back(target->GetFormId());
  argsJson.push_back(sourceId);
  argsJson.push_back(damage);
  if (hitFlags) {
    argsJson.push_back(*hitFlags);
  }
  CustomEvent hitEvent(aggressor->GetFormId(), eventName, argsJson.dump());
  return hitEvent.Fire(&partOne.worldState);
}

void ActionListener::SendPapyrusOnHitEvent(MpActor* aggressor,
                                           MpObjectReference* target,
                                           const HitData& hitData)
{
  auto& browser = partOne.worldState.GetEspm().GetBrowser();
  std::array<VarValue, 7> args;
  args[0] = VarValue(aggressor->ToGameObject()); // akAggressor
  args[1] = VarValue(std::make_shared<EspmGameObject>(
    browser.LookupById(hitData.source)));    // akSource
  args[2] = VarValue::None();                // akProjectile
  args[3] = VarValue(hitData.isPowerAttack); // abPowerAttack
  args[4] = VarValue(hitData.isSneakAttack); // abSneakAttack
  args[5] = VarValue(hitData.isBashAttack);  // abBashAttack
  args[6] = VarValue(hitData.isHitBlocked);  // abHitBlocked
  target->SendPapyrusEvent("OnHit", args.data(), args.size());
}

// Ward casts and keep-alives refresh the caster's ward, its stop ends it
void ActionListener::UpdateWardChannel(uint32_t casterId,
                                       const SpellCastData& spellCastData)
{
  if (spellCastData.interruptCast) {
    auto it = wardChannels.find(casterId);
    if (it != wardChannels.end() &&
        it->second.spellId == spellCastData.spell) {
      wardChannels.erase(it);
    }
    return;
  }
  if (!IsWardSpell(&partOne.worldState, spellCastData.spell)) {
    return;
  }
  const auto now = std::chrono::steady_clock::now();
  std::erase_if(wardChannels, [&](const auto& entry) {
    return now - entry.second.lastRefresh > kCastRefreshTimeout;
  });
  wardChannels[casterId] = WardChannel{ spellCastData.spell, now };
}

// A ward covers the same frontal arc as a raised shield
bool ActionListener::IsWardBlocking(const MpActor& aggressor,
                                    const MpActor& target)
{
  auto it = wardChannels.find(target.GetFormId());
  if (it == wardChannels.end()) {
    return false;
  }
  if (target.IsDead() ||
      std::chrono::steady_clock::now() - it->second.lastRefresh >
        kCastRefreshTimeout) {
    wardChannels.erase(it);
    return false;
  }
  return &aggressor != &target && ShouldBeBlocked(aggressor, target);
}

// The caster's engine paralyses only its own copy of the target, so the target's client applies the spell too
void ActionListener::ApplyParalysis(MpActor& aggressor, MpActor& target,
                                    uint32_t spellId)
{
  if (&aggressor == &target || target.IsDead() || IsParalyzed(target)) {
    return;
  }
  const uint32_t seconds = GetParalysisSeconds(&partOne.worldState, spellId);
  // God mode refuses paralysis like it refuses damage
  if (seconds == 0 ||
      !FireHitDamageEvent("onHitDamageAttempt", &aggressor, &target, spellId,
                          0.f, true)) {
    return;
  }

  const auto now = std::chrono::steady_clock::now();
  std::erase_if(paralyzedUntil,
                [&](const auto& entry) { return entry.second <= now; });
  paralyzedUntil[target.GetFormId()] = now + std::chrono::seconds(seconds);
  // Paralysis lowers a raised shield and ends a ward
  target.SetIsBlockActive(false);
  wardChannels.erase(target.GetFormId());
  spdlog::info("OnSpellHit - spell {:x} of {:x} paralyses {:x} for {} s",
               spellId, aggressor.GetFormId(), target.GetFormId(), seconds);

  // A player's own client, or the host of an NPC
  MpActor& executor = target.GetActorToSendTo();
  // The client that reported the hit already paralysed its real actor
  if (&executor == &aggressor.GetActorToSendTo()) {
    return;
  }
  // DoCombatSpellApply takes a Spell; a Scroll is another form type in Papyrus, so a scroll's paralysis is kept on the
  // server only (review SCH1-R4)
  const auto sourceLookup =
    partOne.GetEspm().GetBrowser().LookupById(spellId);
  if (!espm::Convert<espm::SPEL>(sourceLookup.rec)) {
    spdlog::info("OnSpellHit - paralysis of {:x} from {:x} is not replayed on "
                 "{:x}'s client (not a SPEL)",
                 target.GetFormId(), spellId, executor.GetFormId());
    return;
  }
  SpSnippetObjectArgument spellArg;
  spellArg.formId = spellId;
  spellArg.type = "Spell";
  SpSnippetObjectArgument targetArg;
  targetArg.formId = &executor == &target
    ? 0x14
    : SpSnippet::MakeLongFormId(&partOne.worldState, target.GetFormId());
  targetArg.type = "Actor";
  std::vector<std::optional<
    std::variant<bool, double, std::string, SpSnippetObjectArgument>>>
    args;
  args.push_back(spellArg);
  args.push_back(targetArg);
  SpSnippet("Actor", "DoCombatSpellApply", args, aggressor.GetFormId())
    .Execute(&executor, SpSnippetMode::kNoReturnResult);
}

bool ActionListener::IsParalyzed(const MpActor& actor)
{
  auto it = paralyzedUntil.find(actor.GetFormId());
  if (it == paralyzedUntil.end()) {
    return false;
  }
  if (actor.IsDead() || std::chrono::steady_clock::now() >= it->second) {
    paralyzedUntil.erase(it);
    return false;
  }
  return true;
}

// Scroll reads per caster: kept kScrollHitWindow, at most kScrollReadsPerCaster (the oldest goes first)
void ActionListener::RecordScrollRead(uint32_t casterId, uint32_t scrollId)
{
  auto& reads = scrollHits[casterId];
  ScrollRead read;
  read.scrollId = scrollId;
  read.until = std::chrono::steady_clock::now() + kScrollHitWindow;
  read.grantedHitsLeft = kScrollGrantedHitsPerRead;
  reads.push_back(std::move(read));
  if (reads.size() > kScrollReadsPerCaster) {
    reads.erase(reads.begin());
  }
}

namespace {
template <class Map>
void PruneScrollReads(Map& scrollHits)
{
  const auto now = std::chrono::steady_clock::now();
  for (auto it = scrollHits.begin(); it != scrollHits.end();) {
    std::erase_if(it->second,
                  [&](const auto& read) { return read.until <= now; });
    it = it->second.empty() ? scrollHits.erase(it) : std::next(it);
  }
}
}

// A scroll's hit counts only on a scroll the server used up for this caster lately: each actor once per read, up to
// kScrollTargetsPerRead actors (an area scroll touches several). Review SCH1-R1/R2.
bool ActionListener::TakeScrollHit(uint32_t casterId, uint32_t scrollId,
                                   uint32_t targetId)
{
  PruneScrollReads(scrollHits);
  const auto it = scrollHits.find(casterId);
  if (it == scrollHits.end()) {
    return false;
  }
  for (auto read = it->second.rbegin(); read != it->second.rend(); ++read) {
    if (read->scrollId != scrollId ||
        std::find(read->targets.begin(), read->targets.end(), targetId) !=
          read->targets.end() ||
        read->targets.size() >= kScrollTargetsPerRead) {
      continue;
    }
    read->targets.push_back(targetId);
    return true;
  }
  return false;
}

// The spell a wall or cloak scroll grants ticks on whoever stands in it, so it counts hits, not actors (SCH1-R3)
bool ActionListener::TakeScrollGrantedHit(uint32_t casterId, uint32_t spellId)
{
  PruneScrollReads(scrollHits);
  const auto it = scrollHits.find(casterId);
  if (it == scrollHits.end()) {
    return false;
  }
  for (auto read = it->second.rbegin(); read != it->second.rend(); ++read) {
    if (read->grantedHitsLeft == 0 ||
        !IsSpellGrantedBy(&partOne.worldState, read->scrollId, spellId)) {
      continue;
    }
    --read->grantedHitsLeft;
    return true;
  }
  return false;
}
