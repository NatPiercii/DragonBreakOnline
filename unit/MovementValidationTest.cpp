#include <catch2/catch_all.hpp>

#include "MovementValidation.h"
#include "MsgType.h"
#include "NiPoint3.h"
#include "TestUtils.hpp"
#include <chrono>
#include <thread>
#include <vector>

extern PartOne& GetPartOne();

namespace {
// The limits live in the shared PartOne: a test that changes them puts them back
struct LimitsGuard
{
  explicit LimitsGuard(PartOne& p)
    : partOne(p)
    , saved(p.worldState.movementLimits)
  {
  }
  ~LimitsGuard() { partOne.worldState.movementLimits = saved; }
  PartOne& partOne;
  MovementLimits saved;
};
}

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
  LimitsGuard guard(partOne);
  partOne.worldState.movementLimits.loginGraceMs = 0;

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

namespace {
// A fresh player with a tracker, seeded at the origin
MpActor& SeededPlayer(PartOne& partOne, Networking::UserId user, uint32_t id,
                      MovementValidation::Tracker& tracker)
{
  DoConnect(partOne, user);
  partOne.CreateActor(id, { 0, 0, 0 }, 0, 0x3c);
  partOne.SetUserActor(user, id);
  auto& actor = partOne.worldState.GetFormAt<MpActor>(id);
  REQUIRE(MovementValidation::Validate(
    partOne, { 0, 0, 0 }, { 0, 0, 0 }, FormDesc::Tamriel(), { 10, 0, 0 },
    FormDesc::Tamriel(), user, &actor, { "Skyrim.esm" }, &tracker));
  return actor;
}
bool Jump(PartOne& partOne, MpActor& actor, Networking::UserId user,
          MovementValidation::Tracker& tracker, NiPoint3 from, NiPoint3 to)
{
  return MovementValidation::Validate(partOne, from, { 0, 0, 0 },
                                      FormDesc::Tamriel(), to,
                                      FormDesc::Tamriel(), user, &actor,
                                      { "Skyrim.esm" }, &tracker);
}
}

TEST_CASE("A ceiling that is not enforced logs and accepts",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();
  LimitsGuard guard(partOne);
  partOne.worldState.movementLimits.loginGraceMs = 0;
  partOne.worldState.movementLimits.enforceHorizontal = false;
  MovementValidation::Tracker tracker;
  auto& actor = SeededPlayer(partOne, 0, 0xff000000, tracker);

  partOne.Messages().clear();
  REQUIRE(Jump(partOne, actor, 0, tracker, { 10, 0, 0 }, { 2900, 0, 0 }));
  REQUIRE(partOne.Messages().empty());
}

TEST_CASE("Up alone enforced refuses a climb, not a dash",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();
  LimitsGuard guard(partOne);
  auto& limits = partOne.worldState.movementLimits;
  limits.loginGraceMs = 0;
  limits.enforceHorizontal = limits.enforceDown = false;
  limits.enforceUp = true;
  MovementValidation::Tracker tracker;
  auto& actor = SeededPlayer(partOne, 0, 0xff000000, tracker);

  partOne.Messages().clear();
  REQUIRE(Jump(partOne, actor, 0, tracker, { 10, 0, 0 }, { 2900, 0, 0 }));
  REQUIRE(partOne.Messages().empty());
  REQUIRE(!Jump(partOne, actor, 0, tracker, { 2900, 0, 0 }, { 2900, 0, 3900 }));
  REQUIRE(partOne.Messages().size() == 1);
  REQUIRE(partOne.Messages()[0].j["t"] ==
          static_cast<int>(MsgType::Teleport2));
}

TEST_CASE("The first seconds after a login are accepted",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();
  LimitsGuard guard(partOne);
  MovementValidation::Tracker tracker;
  auto& actor = SeededPlayer(partOne, 0, 0xff000000, tracker);

  partOne.Messages().clear();
  REQUIRE(Jump(partOne, actor, 0, tracker, { 10, 0, 0 }, { 2900, 0, 0 }));
  REQUIRE(partOne.Messages().empty());
}

TEST_CASE("Staff are never refused", "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();
  LimitsGuard guard(partOne);
  partOne.worldState.movementLimits.loginGraceMs = 0;
  MovementValidation::Tracker tracker;
  auto& actor = SeededPlayer(partOne, 0, 0xff000000, tracker);
  actor.SetConsoleCommandsAllowedFlag(true);

  partOne.Messages().clear();
  REQUIRE(Jump(partOne, actor, 0, tracker, { 10, 0, 0 }, { 2900, 0, 0 }));
  REQUIRE(partOne.Messages().empty());
  actor.SetConsoleCommandsAllowedFlag(false);
}

TEST_CASE("A server stall pauses refusals, a lone player's pause does not",
          "[MovementValidation]")
{
  PartOne& partOne = GetPartOne();
  LimitsGuard guard(partOne);
  auto& limits = partOne.worldState.movementLimits;
  limits.loginGraceMs = 0;
  limits.stallMs = 300;

  {
    MovementValidation::Tracker tracker;
    auto& a = SeededPlayer(partOne, 0, 0xff000000, tracker);
    auto& b = SeededPlayer(partOne, 1, 0xff000001, tracker);
    REQUIRE(Jump(partOne, b, 1, tracker, { 10, 0, 0 }, { 20, 0, 0 }));
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    partOne.Messages().clear();
    REQUIRE(Jump(partOne, a, 0, tracker, { 10, 0, 0 }, { 2900, 0, 0 }));
    REQUIRE(partOne.Messages().empty());
  }
  {
    MovementValidation::Tracker tracker;
    auto& a = SeededPlayer(partOne, 2, 0xff000002, tracker);
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    partOne.Messages().clear();
    REQUIRE(!Jump(partOne, a, 2, tracker, { 10, 0, 0 }, { 3900, 0, 0 }));
    REQUIRE(partOne.Messages().size() == 1);
  }
}
