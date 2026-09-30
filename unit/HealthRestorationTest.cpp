#include "ActionListener.h"
#include "OnEquipMessage.h"
#include "SpellCastMessage.h"
#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <chrono>

PartOne& GetPartOne();

TEST_CASE("Potions restore health", "[Restoration]")
{
  using namespace std::chrono_literals;
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);

  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  auto past = std::chrono::steady_clock::now() - 10s;
  ac.SetLastAttributesPercentagesUpdate(past);
  ac.AddItem(0x3EAE3, 1);
  // 0x3EAE3 restores 100 hp
  ac.SetPercentages({ 0.1f, 0.f, 0.f });

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;

  OnEquipMessage msg;
  msg.baseId = 0x3EAE3;
  p.GetActionListener().OnEquip(rawMsgData, msg);

  std::chrono::duration<float> timeDuration =
    ac.GetLastAttributesPercentagesUpdate() - std::chrono::steady_clock::now();

  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage == 1.0f);
  REQUIRE(timeDuration.count() < 1.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("A second potion within 10 seconds is refunded", "[Restoration]")
{
  using namespace std::chrono_literals;
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);

  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  ac.SetLastAttributesPercentagesUpdate(std::chrono::steady_clock::now() -
                                        10s);
  ac.AddItem(0x3EAE3, 2);
  ac.SetPercentages({ 0.1f, 0.f, 0.f });

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;

  OnEquipMessage msg;
  msg.baseId = 0x3EAE3;
  p.GetActionListener().OnEquip(rawMsgData, msg);

  REQUIRE(ac.GetInventory().GetItemCount(0x3EAE3) == 1);
  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage == 1.0f);

  ac.SetPercentages({ 0.1f, 0.f, 0.f });
  p.GetActionListener().OnEquip(rawMsgData, msg);

  REQUIRE(ac.GetInventory().GetItemCount(0x3EAE3) == 1);
  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage == 0.1f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

// A cast packet healed on arrival with no rate, so a modified client healed to
// full mid-fight (combat review, 2026-09-29)
TEST_CASE("A restorative self cast heals once per 0.7 s", "[Restoration]")
{
  using namespace std::chrono_literals;
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  // FastHealing: fire and forget, self, 0.5 s charge
  constexpr uint32_t kFastHealing = 0x2F3B8;
  Equipment eq;
  eq.rightSpell = kFastHealing;
  ac.SetEquipment(eq);

  ActorValues low;
  low.healthPercentage = 0.1f;
  low.magickaPercentage = 1.f;
  low.staminaPercentage = 1.f;

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  SpellCastMessage msg;
  msg.data.caster = 0x14;
  msg.data.target = 0x14;
  msg.data.spell = kFastHealing;

  ac.SetPercentages(low);
  p.GetActionListener().OnSpellCast(rawMsgData, msg);
  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage > 0.1f);

  ac.SetPercentages(low);
  p.GetActionListener().OnSpellCast(rawMsgData, msg);
  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage == 0.1f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}
