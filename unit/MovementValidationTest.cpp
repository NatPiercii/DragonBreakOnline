#include <catch2/catch_all.hpp>

#include "MovementValidation.h"
#include "MsgType.h"
#include "NiPoint3.h"
#include "TestUtils.hpp"
#include <vector>

extern PartOne& GetPartOne();

TEST_CASE("Returns true and sends nothing for normal movement",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000000);

  partOne.Messages().clear();
  bool res = MovementValidation::Validate(
    partOne, { 0, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 1, 1, 1 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" });
  REQUIRE(res);
  REQUIRE(partOne.Messages().empty());
}

TEST_CASE("Returns false and sends teleport packet when moving too fast",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000000);

  partOne.Messages().clear();
  float maxLegalMove = 4096.f;
  bool res = MovementValidation::Validate(
    partOne, { 1, -1, 1 }, { 123, 111, 123 }, FormDesc::Tamriel(),
    NiPoint3{ 1, -1, 1 } + NiPoint3{ maxLegalMove + 1.f, 0, 0 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" });
  REQUIRE(!res);
  REQUIRE(partOne.Messages().size() == 1);
  REQUIRE(partOne.Messages()[0].j ==
          nlohmann::json{ { "t", static_cast<int>(MsgType::Teleport2) },
                          { "pos", { 1, -1, 1 } },
                          { "rot", { 123, 111, 123 } },
                          { "worldOrCell", 0x3c } });
  REQUIRE(partOne.Messages()[0].userId == 0);
}

TEST_CASE("Refuses a jump that is under the single packet cap but too fast",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000000);
  MovementValidation::Tracker tracker;

  partOne.Messages().clear();
  bool seeding = MovementValidation::Validate(
    partOne, { 0, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 100, 0, 0 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" }, &tracker);
  REQUIRE(seeding);
  REQUIRE(partOne.Messages().empty());

  bool res = MovementValidation::Validate(
    partOne, { 100, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 3000, 0, 0 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" }, &tracker);
  REQUIRE(!res);
  REQUIRE(partOne.Messages().size() == 1);
  REQUIRE(partOne.Messages()[0].j["t"] ==
          static_cast<int>(MsgType::Teleport2));
}

TEST_CASE("Accepts walking speed steps in a row", "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000000);
  MovementValidation::Tracker tracker;

  partOne.Messages().clear();
  for (int i = 0; i < 8; ++i) {
    NiPoint3 from = { static_cast<float>(i * 60), 0, 0 };
    NiPoint3 to = { static_cast<float>((i + 1) * 60), 0, 0 };
    REQUIRE(MovementValidation::Validate(partOne, from, { 0, 0, 0 },
                                         FormDesc::Tamriel(), to,
                                         FormDesc::Tamriel(), 0, &actor,
                                         { "Skyrim.esm" }, &tracker));
  }
  REQUIRE(partOne.Messages().empty());
}

TEST_CASE("Drops a stale packet after a server teleport without snapping back",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000000);
  MovementValidation::Tracker tracker;

  partOne.Messages().clear();
  REQUIRE(MovementValidation::Validate(
    partOne, { 0, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 100, 0, 0 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" }, &tracker));

  // The server moved the actor to 2000, the client is still sending from 100
  bool stale = MovementValidation::Validate(
    partOne, { 2000, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 150, 0, 0 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" }, &tracker);
  REQUIRE(!stale);
  REQUIRE(partOne.Messages().empty());

  // The client has arrived and reports from the destination
  REQUIRE(MovementValidation::Validate(
    partOne, { 2000, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 2050, 0, 0 },
    FormDesc::Tamriel(), 0, &actor, { "Skyrim.esm" }, &tracker));
  REQUIRE(partOne.Messages().empty());
}

TEST_CASE("Leaves hosted NPC movement to the existing checks",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);
  partOne.CreateActor(0xff000001, { 0, 0, 0 }, 0, 0x3c);

  auto& npc = partOne.worldState.GetFormAt<MpActor>(0xff000001);
  MovementValidation::Tracker tracker;

  partOne.Messages().clear();
  REQUIRE(MovementValidation::Validate(
    partOne, { 0, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 3000, 0, 0 },
    FormDesc::Tamriel(), 0, &npc, { "Skyrim.esm" }, &tracker));
  REQUIRE(partOne.Messages().empty());
}

TEST_CASE(
  "Returns false and sends teleport packet when moving between locations",
  "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(0, 0xff000000);

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000000);

  partOne.Messages().clear();
  bool res = MovementValidation::Validate(
    partOne, { 1, -1, 1 }, { 123, 111, 123 }, FormDesc::Tamriel(),
    { 1, -1, 1 }, FormDesc::FromString("ffffff:Skyrim.esm"), 0, &actor,
    { "Skyrim.esm" });
  REQUIRE(!res);
  REQUIRE(partOne.Messages().size() == 1);
  REQUIRE(partOne.Messages()[0].j ==
          nlohmann::json{ { "t", static_cast<int>(MsgType::Teleport2) },
                          { "pos", { 1, -1, 1 } },
                          { "rot", { 123, 111, 123 } },
                          { "worldOrCell", 0x3c } });
  REQUIRE(partOne.Messages()[0].userId == 0);
}
