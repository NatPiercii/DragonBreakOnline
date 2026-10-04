#include "MpChangeForms.h"
#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>

#include "MpObjectReference.h"
#include "PartOne.h"

PartOne& GetPartOne();

TEST_CASE("Dropping an item", "[DropItemTest]")
{
  auto& partOne = GetPartOne();
  // an iron dagger
  constexpr uint32_t ironDagger = 0x0001397E;
  constexpr uint32_t ironSword = 0x00012EB7;
  DoConnect(partOne, 0);

  partOne.CreateActor(0xff000000, { 1, 2, 3 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  MpActor& ac = partOne.worldState.GetFormAt<MpActor>(0xff000000);

  ac.RemoveAllItems();
  REQUIRE(ac.GetInventory().GetTotalItemCount() == 0);
  ac.AddItem(ironDagger, 1);
  REQUIRE(ac.GetInventory().GetTotalItemCount() == 1);
  partOne.Messages().clear();
  REQUIRE(partOne.Messages().size() == 0);
  DoMessage(partOne, 0,
            nlohmann::json{ { "t", MsgType::DropItem },
                            { "baseId", ironDagger },
                            { "count", 1 } });
  // 1 message from here and another 1 is comming from actionListener
  partOne.Tick();
  REQUIRE(partOne.Messages().size() == 2);
  REQUIRE(ac.GetInventory().GetItemCount(ironDagger) == 0);
  MpObjectReference& refr =
    partOne.worldState.GetFormAt<MpObjectReference>(0xff000001);
  REQUIRE(refr.GetBaseId() == ironDagger);
  REQUIRE(refr.GetPos().x == 1.f);
  REQUIRE(refr.GetPos().y == 2.f);
  REQUIRE(refr.GetPos().z == 3.f);
  ac.AddItem(ironSword, 5);
  partOne.Messages().clear();
  REQUIRE(partOne.Messages().size() == 0);
  DoMessage(partOne, 0,
            nlohmann::json{ { "t", MsgType::DropItem },
                            { "baseId", ironSword },
                            { "count", 5 } });
  partOne.Tick();
  REQUIRE(partOne.Messages().size() == 2);
  REQUIRE(ac.GetInventory().GetItemCount(ironSword) == 0);
}

TEST_CASE("A dropped enchanted weapon keeps the charge it was dropped with",
          "[DropItemTest]")
{
  auto& partOne = GetPartOne();
  constexpr uint32_t ironSword = 0x00012EB7;
  constexpr uint32_t anyEnchantment = 0x0004605A;
  DoConnect(partOne, 5);
  partOne.CreateActor(0xff0a0000, { 1, 2, 3 }, 0, 0x3c);
  partOne.SetUserActor(5, 0xff0a0000);
  MpActor& ac = partOne.worldState.GetFormAt<MpActor>(0xff0a0000);

  auto charged = [&](float charge) {
    Inventory::ExtraData extras;
    extras.enchantmentId = anyEnchantment;
    extras.maxCharge = 500.f;
    extras.chargePercent = charge;
    return Inventory::Entry(ironSword, 1, extras);
  };
  auto dropAndPickUp = [&](float reported) {
    ac.RemoveAllItems();
    ac.AddItems({ charged(300.f) });
    DoMessage(partOne, 5,
              nlohmann::json{ { "t", MsgType::DropItem },
                              { "baseId", ironSword },
                              { "count", 1 },
                              { "enchantmentId", anyEnchantment },
                              { "maxCharge", 500.f },
                              { "chargePercent", reported } });
    partOne.Tick();
    REQUIRE(ac.GetInventory().GetItemCount(ironSword) == 0);
    MpObjectReference* dropped = nullptr;
    for (uint32_t id = 0xff000000; id < 0xff100000; ++id) {
      auto& form = partOne.worldState.LookupFormById(id);
      auto refr = form ? form->AsObjectReference() : nullptr;
      if (refr && !refr->AsActor() && refr->GetBaseId() == ironSword &&
          !refr->IsDeleted() && !refr->IsHarvested()) {
        dropped = refr;
      }
    }
    REQUIRE(dropped != nullptr);
    dropped->Activate(ac);
    REQUIRE(ac.GetInventory().entries.size() == 1);
    return ac.GetInventory().entries[0].chargePercent.value_or(-1.f);
  };

  REQUIRE(dropAndPickUp(120.f) == 120.f);
  REQUIRE(dropAndPickUp(450.f) == 300.f);

  DoDisconnect(partOne, 5);
  partOne.DestroyActor(0xff0a0000);
}
