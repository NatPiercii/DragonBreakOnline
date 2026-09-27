#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <chrono>

#include "GetBaseActorValues.h"
#include "HitMessage.h"
#include "PacketParser.h"
#include "formulas/TES5DamageFormula.h"
#include "libespm/Loader.h"
#include "PartOneListener.h"
#include "gamemode_events/GameModeEvent.h"
#include <nlohmann/json.hpp>

PartOne& GetPartOne();
extern espm::Loader l;
using namespace std::chrono_literals;

namespace {
const auto kExtraWornTrue = [] {
  Inventory::ExtraData extra;
  extra.worn_ = true;
  return extra;
}();
}

TEST_CASE("OnHit damages target actor based on damage formula", "[Hit]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.target = 0x14;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E; // iron dagger 4 damage, id = 80254
  ac.AddItem(hitMsg.data.source, 1);

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(80254, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  auto past = std::chrono::steady_clock::now() - 10s;
  ac.SetLastHitTime(0xff000000, past);
  p.Messages().clear();
  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  REQUIRE(p.Messages().size() == 1);
  auto changeForm = ac.GetChangeForm();
  REQUIRE(changeForm.actorValues.healthPercentage == 0.75f);
  REQUIRE(changeForm.actorValues.magickaPercentage == 1.f);
  REQUIRE(changeForm.actorValues.staminaPercentage == 1.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("OnHit function sends ChangeValues message with coorect percentages",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  ac.SetEquipment(Equipment());

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.target = 0x14;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E; // iron dagger 4 damage
  ac.AddItem(hitMsg.data.source, 1);

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(80254, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  p.Messages().clear();
  auto past = std::chrono::steady_clock::now() - 4s;
  ac.SetLastHitTime(0xff000000, past);
  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  REQUIRE(p.Messages().size() == 1);
  nlohmann::json message = p.Messages()[0].j;

  REQUIRE(message["data"]["health"] == 0.75f);
  REQUIRE(message["data"]["magicka"] == nlohmann::json{});
  REQUIRE(message["data"]["stamina"] == nlohmann::json{});

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("OnHit doesn't damage character if it is out of range", "[Hit]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  RawMessageData rawMsgData;
  rawMsgData.userId = 0;

  const uint32_t aggressor = 0xff000000;
  const uint32_t target = 0xff000001;

  p.CreateActor(aggressor, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, aggressor);
  auto& acAggressor = p.worldState.GetFormAt<MpActor>(aggressor);

  p.CreateActor(target, { 0, 0, 0 }, 0, 0x3c);
  auto& acTarget = p.worldState.GetFormAt<MpActor>(target);

  HitMessage hitMsg;
  hitMsg.data.target = target;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E;

  int16_t face =
    espm::GetData<espm::NPC_>(acAggressor.GetBaseId(), &p.worldState)
      .objectBounds.pos2[1];
  int16_t targetSide =
    espm::GetData<espm::NPC_>(acTarget.GetBaseId(), &p.worldState)
      .objectBounds.pos2[1];

  // fCombatDistance global value * reach
  const float awaitedRange = 141.f * 0.7f + face + targetSide;
  acTarget.SetPos({ awaitedRange * 1.001f, 0, 0 });
  acTarget.SetAngle({ 0.f, 0.f, 180.f });
  ActorValues actorValues;
  actorValues.healthPercentage = 0.1f;
  actorValues.magickaPercentage = 1.f;
  actorValues.staminaPercentage = 1.f;
  acTarget.SetPercentages(actorValues);

  auto past = std::chrono::steady_clock::now() - 2s;
  acTarget.SetLastHitTime(target, past);
  acAggressor.SetLastHitTime(target, past);
  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  auto changeForm = acTarget.GetChangeForm();
  REQUIRE(changeForm.actorValues.healthPercentage == 0.1f);

  p.DestroyActor(aggressor);
  p.DestroyActor(target);
  DoDisconnect(p, 0);
}

TEST_CASE("Dead actors can't attack", "[Hit]")
{
  PartOne& p = GetPartOne();
  RawMessageData rawMsgData;

  const uint32_t aggressor = 0xff000000;
  const uint32_t target = 0xff000001;

  p.CreateActor(aggressor, { 0, 0, 0 }, 0, 0x3c);
  p.CreateActor(target, { 0, 0, 0 }, 0, 0x3c);

  DoConnect(p, 0);
  p.SetUserActor(0, aggressor);
  rawMsgData.userId = 0;

  HitMessage hitMsg;
  hitMsg.data.target = target;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E;

  auto& acTarget = p.worldState.GetFormAt<MpActor>(target);
  ActorValues actorValues;
  actorValues.healthPercentage = 0.2f;
  actorValues.magickaPercentage = 1.f;
  actorValues.staminaPercentage = 1.f;
  acTarget.SetPercentages(actorValues);

  auto& acAggressor = p.worldState.GetFormAt<MpActor>(aggressor);
  acAggressor.Kill();
  REQUIRE(acAggressor.IsDead() == true);

  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  REQUIRE(acTarget.GetChangeForm().actorValues.healthPercentage == 0.2f);

  p.DestroyActor(aggressor);
  p.DestroyActor(target);
  DoDisconnect(p, 0);
}

TEST_CASE("checking weapon cooldown", "[Hit]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);

  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  ActorValues actorValues;
  actorValues.healthPercentage = 1.f;
  actorValues.magickaPercentage = 1.f;
  actorValues.staminaPercentage = 1.f;
  ac.SetPercentages(actorValues);

  RawMessageData msgData;
  msgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.target = 0x14;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E;
  ac.AddItem(hitMsg.data.source, 1);

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(80254, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  auto past = std::chrono::steady_clock::now() - 300ms;

  ac.SetLastHitTime(0xff000000, past);
  p.Messages().clear();
  p.GetActionListener().OnHit(msgData, hitMsg);

  auto current = ac.GetLastHitTime(0xff000000);
  std::chrono::duration<float> duration = current - past;
  float passedTime = duration.count();
  float daggerSpeed = 1.3f;

  REQUIRE(passedTime <= 1.1 * (1 / daggerSpeed));
  REQUIRE(p.Messages().size() == 0);

  past = std::chrono::steady_clock::now() - 3s;
  ac.SetLastHitTime(0xff000000, past);
  p.Messages().clear();
  p.GetActionListener().OnHit(msgData, hitMsg);
  current = ac.GetLastHitTime(0xff000000);
  duration = current - past;
  passedTime = duration.count();

  REQUIRE(passedTime >= 1.1 * (1 / daggerSpeed));
  REQUIRE(p.Messages().size() == 1);
  nlohmann::json message = p.Messages()[0].j;
  uint64_t msgType = 16; // OnHit sends ChangeValues message type
  REQUIRE(message["t"] == msgType);
  REQUIRE(message["data"]["health"] == 0.75f);
  REQUIRE(message["data"]["magicka"] == nlohmann::json{});
  REQUIRE(message["data"]["stamina"] == nlohmann::json{});

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

namespace {
nlohmann::json MakeSpellCastMessage(uint32_t spell, bool interruptCast)
{
  return nlohmann::json{
    { "t", MsgType::SpellCast },
    { "data",
      { { "caster", 0x14 },
        { "target", 0x14 },
        { "spell", spell },
        { "isDualCasting", false },
        { "interruptCast", interruptCast },
        { "castingSource", 0 },
        { "aimAngle", 0.f },
        { "aimHeading", 0.f },
        { "actorAnimationVariables",
          { { "booleans", nlohmann::json::array() },
            { "floats", nlohmann::json::array() },
            { "integers", nlohmann::json::array() } } },
        { "keepAlive", false } } }
  };
}
}

TEST_CASE("An active ward blocks a frontal spell hit like a shield", "[Hit]")
{
  PartOne& p = GetPartOne();
  constexpr uint32_t kAggressor = 0xff000000;
  constexpr uint32_t kTarget = 0xff000001;
  constexpr uint32_t kFlames = 0x00012fcd;
  constexpr uint32_t kGreaterWard = 0x000211f0;

  DoConnect(p, 0);
  DoConnect(p, 1);
  p.CreateActor(kAggressor, { 30, 100, 0 }, 0, 0x3c);
  p.CreateActor(kTarget, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, kAggressor);
  p.SetUserActor(1, kTarget);
  auto& aggressor = p.worldState.GetFormAt<MpActor>(kAggressor);
  auto& target = p.worldState.GetFormAt<MpActor>(kTarget);

  Equipment aggressorEquipment;
  aggressorEquipment.leftSpell = kFlames;
  aggressor.SetEquipment(aggressorEquipment);
  Equipment targetEquipment;
  targetEquipment.leftSpell = kGreaterWard;
  target.SetEquipment(targetEquipment);

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.target = kTarget;
  hitMsg.data.source = kFlames;

  auto healthLostToHit = [&] {
    target.SetPercentages({ 1.f, 1.f, 1.f });
    p.GetActionListener().OnHit(rawMsgData, hitMsg);
    return 1.f - target.GetChangeForm().actorValues.healthPercentage;
  };

  // Angle 0 faces +y, towards the aggressor
  target.SetAngle({ 0.f, 0.f, 0.f });
  const float unwarded = healthLostToHit();
  REQUIRE(unwarded > 0.f);

  DoMessage(p, 1, MakeSpellCastMessage(kGreaterWard, false));
  REQUIRE(healthLostToHit() ==
          Catch::Approx(unwarded * kBlockedHitDamageMult).margin(1e-6));

  target.SetAngle({ 0.f, 0.f, 180.f });
  REQUIRE(healthLostToHit() == Catch::Approx(unwarded));

  target.SetAngle({ 0.f, 0.f, 0.f });
  DoMessage(p, 1, MakeSpellCastMessage(kGreaterWard, true));
  REQUIRE(healthLostToHit() == Catch::Approx(unwarded));

  p.DestroyActor(kAggressor);
  p.DestroyActor(kTarget);
  DoDisconnect(p, 0);
  DoDisconnect(p, 1);
}

TEST_CASE("A paralysed actor cannot attack or move", "[Hit]")
{
  PartOne& p = GetPartOne();
  constexpr uint32_t kCaster = 0xff000000;
  constexpr uint32_t kVictim = 0xff000001;
  constexpr uint32_t kParalyze = 0x0005ad5f;
  constexpr uint32_t kIronDagger = 0x0001397e;

  DoConnect(p, 0);
  DoConnect(p, 1);
  p.CreateActor(kCaster, { 0, 100, 0 }, 0, 0x3c);
  p.CreateActor(kVictim, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, kCaster);
  p.SetUserActor(1, kVictim);
  auto& caster = p.worldState.GetFormAt<MpActor>(kCaster);
  auto& victim = p.worldState.GetFormAt<MpActor>(kVictim);

  Equipment casterEquipment;
  casterEquipment.leftSpell = kParalyze;
  caster.SetEquipment(casterEquipment);
  victim.AddItem(kIronDagger, 1);
  Equipment victimEquipment;
  victimEquipment.inv.entries.push_back(
    Inventory::Entry(kIronDagger, 1, kExtraWornTrue));
  victim.SetEquipment(victimEquipment);

  RawMessageData victimMsgData;
  victimMsgData.userId = 1;
  HitMessage stab;
  stab.data.aggressor = 0x14;
  stab.data.target = kCaster;
  stab.data.source = kIronDagger;

  auto casterHealthAfterStab = [&] {
    caster.SetPercentages({ 1.f, 1.f, 1.f });
    victim.SetLastHitTime(kCaster, std::chrono::steady_clock::now() - 10s);
    p.GetActionListener().OnHit(victimMsgData, stab);
    return caster.GetChangeForm().actorValues.healthPercentage;
  };

  REQUIRE(casterHealthAfterStab() < 1.f);

  RawMessageData casterMsgData;
  casterMsgData.userId = 0;
  HitMessage paralyze;
  paralyze.data.aggressor = 0x14;
  paralyze.data.target = kVictim;
  paralyze.data.source = kParalyze;
  p.GetActionListener().OnHit(casterMsgData, paralyze);

  REQUIRE(casterHealthAfterStab() == 1.f);

  auto movement = jMovement;
  movement["idx"] = victim.GetIdx();
  movement["data"]["pos"] = { 300.f, 0.f, 0.f };
  DoMessage(p, 1, movement);
  REQUIRE(victim.GetPos() == NiPoint3{ 0.f, 0.f, 0.f });

  p.DestroyActor(kCaster);
  p.DestroyActor(kVictim);
  DoDisconnect(p, 0);
  DoDisconnect(p, 1);
}

namespace {
// Answers onHitDamageAttempt the way combat.js's block chip does: it takes the target's health down inside the hook
// and keeps the hit flags it was handed. GetPartOne() builds a new PartOne for each test, so the listener goes with it.
class HitAttemptListener : public PartOneListener
{
public:
  explicit HitAttemptListener(PartOne& partOne_)
    : partOne(partOne_)
  {
  }
  void OnConnect(Networking::UserId) override {}
  void OnDisconnect(Networking::UserId) override {}
  void OnCustomPacket(Networking::UserId,
                      const simdjson::dom::element&) override
  {
  }
  bool OnMpApiEvent(const GameModeEvent& event) override
  {
    if (!active || event.GetName() != std::string("onHitDamageAttempt")) {
      return true;
    }
    // [aggressor, target, source, damage, flags]: the gamemode's handler gets the same five arguments
    auto args = nlohmann::json::parse(event.GetArgumentsJsonArray());
    if (args.size() >= 5) {
      lastFlags = args[4];
    }
    if (chipTo >= 0.f && args.size() >= 2) {
      auto& target = partOne.worldState.GetFormAt<MpActor>(
        args[1].get<uint32_t>());
      ActorValues values = target.GetChangeForm().actorValues;
      values.healthPercentage = chipTo;
      target.SetPercentages(values);
    }
    return true;
  }

  PartOne& partOne;
  bool active = true;
  float chipTo = -1.f;
  nlohmann::json lastFlags;
};

struct BlockScene
{
  static constexpr uint32_t kAggressor = 0xff000000;
  static constexpr uint32_t kTarget = 0xff000001;
  static constexpr uint32_t kIronDagger = 0x0001397E;

  explicit BlockScene(PartOne& p_)
    : p(p_)
  {
    DoConnect(p, 0);
    p.CreateActor(kAggressor, { 0, 0, 0 }, 0, 0x3c);
    p.SetUserActor(0, kAggressor);
    // In front of the aggressor and facing it (angle 180 faces -y)
    p.CreateActor(kTarget, { 0, 50, 0 }, 180, 0x3c);
    auto& aggressor = p.worldState.GetFormAt<MpActor>(kAggressor);
    aggressor.AddItem(kIronDagger, 1);
    Equipment eq;
    eq.inv.entries.push_back(Inventory::Entry(kIronDagger, 1, kExtraWornTrue));
    aggressor.SetEquipment(eq);
    target().SetAngle({ 0.f, 0.f, 180.f });
  }
  ~BlockScene()
  {
    p.DestroyActor(kAggressor);
    p.DestroyActor(kTarget);
    DoDisconnect(p, 0);
  }
  MpActor& target() { return p.worldState.GetFormAt<MpActor>(kTarget); }
  // One dagger hit from full health; returns the health left
  float Hit(bool attackerClaimsBlock)
  {
    target().SetPercentages({ 1.f, 1.f, 1.f });
    auto past = std::chrono::steady_clock::now() - 10s;
    p.worldState.GetFormAt<MpActor>(kAggressor).SetLastHitTime(kTarget, past);
    RawMessageData rawMsgData;
    rawMsgData.userId = 0;
    HitMessage hitMsg;
    hitMsg.data.aggressor = 0x14;
    hitMsg.data.target = kTarget;
    hitMsg.data.source = kIronDagger;
    hitMsg.data.isHitBlocked = attackerClaimsBlock;
    p.GetActionListener().OnHit(rawMsgData, hitMsg);
    return target().GetChangeForm().actorValues.healthPercentage;
  }
  PartOne& p;
};
}

TEST_CASE("A block is decided from the target: IsBlocking alone blocks, the "
          "attacker cannot claim one",
          "[Hit]")
{
  // The unit PartOne runs a fake damage formula (25 whatever happens), so the server's block decision is read where
  // the gamemode gets it: the blocked flag of onHitDamageAttempt
  PartOne& p = GetPartOne();
  auto listener = std::make_shared<HitAttemptListener>(p);
  p.AddListener(listener);
  BlockScene scene(p);
  auto blocked = [&] { return listener->lastFlags.value("blocked", true); };

  // Nobody blocking: the attacker's claim of a block is ignored
  scene.Hit(true);
  REQUIRE_FALSE(blocked());

  // A hosted NPC's block reaches the server only as its IsBlocking animation variable (the host's movement packet);
  // IsBlockActive stays false for it, and that is enough to block
  scene.target().SetAnimationVariableBool(
    AnimationVariableBool::kVariable_IsBlocking, true);
  REQUIRE_FALSE(scene.target().IsBlockActive());
  scene.Hit(false);
  REQUIRE(blocked());

  // Blocking, but facing away: not blocked
  scene.target().SetAngle({ 0.f, 0.f, 0.f });
  scene.Hit(false);
  REQUIRE_FALSE(blocked());

  // A player's block from the animation system alone (IsBlockActive, IsBlocking unset) blocks too
  scene.target().SetAngle({ 0.f, 0.f, 180.f });
  scene.target().SetAnimationVariableBool(
    AnimationVariableBool::kVariable_IsBlocking, false);
  scene.target().SetIsBlockActive(true);
  scene.Hit(false);
  REQUIRE(blocked());
  scene.target().SetIsBlockActive(false);

  listener->active = false;
}

TEST_CASE("Health the gamemode takes in onHitDamageAttempt is kept (block "
          "chip), and the flags carry the target's maxima",
          "[Hit]")
{
  PartOne& p = GetPartOne();
  auto listener = std::make_shared<HitAttemptListener>(p);
  p.AddListener(listener);
  BlockScene scene(p);
  // What one hit takes with the unit's fake formula
  const float loss = 1.f - scene.Hit(false);
  REQUIRE(loss > 0.f);

  scene.target().SetAnimationVariableBool(
    AnimationVariableBool::kVariable_IsBlocking, true);
  // A blocked blow: the hook chips the blocker to 0.9. The server must go on from 0.9, not write its pre-hook
  // snapshot (1.0) back: 0.9 - loss, where it used to be 1.0 - loss
  listener->chipTo = 0.9f;
  REQUIRE(scene.Hit(false) == Catch::Approx(0.9f - loss));
  REQUIRE(listener->lastFlags.value("blocked", false) == true);
  REQUIRE(listener->lastFlags.value("spell", true) == false);
  const auto maxima = scene.target().GetMaximumValues();
  REQUIRE(listener->lastFlags.value("targetMaxHealth", 0.f) ==
          Catch::Approx(maxima.health));
  REQUIRE(listener->lastFlags.value("targetMaxStamina", 0.f) ==
          Catch::Approx(maxima.stamina));

  listener->active = false;
  scene.target().SetAnimationVariableBool(
    AnimationVariableBool::kVariable_IsBlocking, false);
}

TEST_CASE("A scroll's hits land only after the server used one up: each actor "
          "once per read, and a later read keeps an earlier read's hits",
          "[Hit]")
{
  PartOne& p = GetPartOne();
  constexpr uint32_t kCaster = 0xff000000;
  constexpr uint32_t kFirst = 0xff000001;
  constexpr uint32_t kSecond = 0xff000002;
  constexpr uint32_t kThird = 0xff000003;
  constexpr uint32_t kFireballScroll = 0x000a44ae;
  constexpr uint32_t kHysteriaScroll = 0x000a44bd;

  DoConnect(p, 0);
  p.CreateActor(kCaster, { 0, 0, 0 }, 0, 0x3c, 1);
  p.SetUserActor(0, kCaster);
  p.CreateActor(kFirst, { 0, 100, 0 }, 0, 0x3c);
  p.CreateActor(kSecond, { 100, 0, 0 }, 0, 0x3c);
  p.CreateActor(kThird, { -100, 0, 0 }, 0, 0x3c);
  auto& caster = p.worldState.GetFormAt<MpActor>(kCaster);
  caster.AddItem(kFireballScroll, 2);
  caster.AddItem(kHysteriaScroll, 1);

  auto hold = [&](uint32_t scroll) {
    Equipment eq;
    eq.inv.entries.push_back(Inventory::Entry(scroll, 1, kExtraWornTrue));
    caster.SetEquipment(eq);
  };
  // Health one scroll hit takes (the unit PartOne's fake formula), 0 when refused
  auto hit = [&](uint32_t target, uint32_t scroll) {
    auto& actor = p.worldState.GetFormAt<MpActor>(target);
    actor.SetPercentages({ 1.f, 1.f, 1.f });
    RawMessageData rawMsgData;
    rawMsgData.userId = 0;
    HitMessage hitMsg;
    hitMsg.data.aggressor = 0x14;
    hitMsg.data.target = target;
    hitMsg.data.source = scroll;
    p.GetActionListener().OnHit(rawMsgData, hitMsg);
    return 1.f - actor.GetChangeForm().actorValues.healthPercentage;
  };

  // Nothing read yet: a scroll hit is refused
  REQUIRE(hit(kFirst, kFireballScroll) == Catch::Approx(0.f));

  hold(kFireballScroll);
  DoMessage(p, 0, MakeSpellCastMessage(kFireballScroll, false));
  REQUIRE(caster.GetInventory().GetItemCount(kFireballScroll) == 1);

  // R1: one hit per actor per read, several actors per read
  REQUIRE(hit(kFirst, kFireballScroll) > 0.f);
  REQUIRE(hit(kFirst, kFireballScroll) == Catch::Approx(0.f));
  REQUIRE(hit(kSecond, kFireballScroll) > 0.f);

  // R2: reading another scroll keeps the first read's hits
  hold(kHysteriaScroll);
  DoMessage(p, 0, MakeSpellCastMessage(kHysteriaScroll, false));
  REQUIRE(caster.GetInventory().GetItemCount(kHysteriaScroll) == 0);
  REQUIRE(hit(kThird, kFireballScroll) > 0.f);
  REQUIRE(hit(kFirst, kHysteriaScroll) > 0.f);

  p.DestroyActor(kCaster);
  p.DestroyActor(kFirst);
  p.DestroyActor(kSecond);
  p.DestroyActor(kThird);
  DoDisconnect(p, 0);
}
