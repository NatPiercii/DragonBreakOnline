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

// Item-flow review, 2026-09-29: a drop of count 0 fell through to DropItem with nothing removed and came back as one
// item on pick-up; an unknown record crashed DropItem; neither must place anything
TEST_CASE("A drop of nothing, of no record or of a non-item places nothing",
          "[DropItemTest]")
{
  auto& partOne = GetPartOne();
  constexpr uint32_t ironDagger = 0x0001397E;
  constexpr uint32_t playerNpc = 0x00000007;     // NPC_ record, not an item
  constexpr uint32_t noRecord = 0x00FFFFF0;
  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 1, 2, 3 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);
  MpActor& ac = partOne.worldState.GetFormAt<MpActor>(0xff000000);
  ac.RemoveAllItems();

  for (const auto& [baseId, count] :
       std::vector<std::pair<uint32_t, uint32_t>>{
         { ironDagger, 0 }, { noRecord, 1 }, { playerNpc, 1 } }) {
    partOne.Messages().clear();
    DoMessage(partOne, 0,
              nlohmann::json{ { "t", MsgType::DropItem },
                              { "baseId", baseId },
                              { "count", count } });
    partOne.Tick();
    REQUIRE(partOne.Messages().size() == 0);
  }
  REQUIRE(ac.GetInventory().GetTotalItemCount() == 0);

  partOne.DestroyActor(0xff000000);
  DoDisconnect(partOne, 0);
}
