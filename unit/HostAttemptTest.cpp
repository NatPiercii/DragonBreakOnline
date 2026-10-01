#include "TestUtils.hpp"

namespace {
nlohmann::json HostAttempt(uint32_t remoteId)
{
  return nlohmann::json{ { "t", MsgType::Host }, { "remoteId", remoteId } };
}
}

// A client can still ask to host an NPC the server has removed, such as a corpse cleared after its 300 s: it is not
// hosted, and that client is told again to drop its copy, by the index it knows
TEST_CASE("A host attempt for an NPC that is gone is ignored quietly",
          "[PartOne][Host]")
{
  PartOne p;
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0.f, 0.f, 0.f }, 0.f, 0x3c);
  p.SetUserActor(0, 0xff000000);

  p.CreateActor(0xff000001, { 100.f, 0.f, 0.f }, 0.f, 0x3c);
  const uint32_t goneIdx =
    p.worldState.GetFormAt<MpActor>(0xff000001).GetIdx();
  p.DestroyActor(0xff000001);
  p.Messages().clear();

  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff000001)));
  REQUIRE(p.worldState.hosters.find(0xff000001) == p.worldState.hosters.end());
  REQUIRE(p.Messages().size() == 1);
  REQUIRE(p.Messages()[0].userId == 0);
  REQUIRE(p.Messages()[0].j["t"] == MsgType::DestroyActor);
  REQUIRE(p.Messages()[0].j["idx"] == goneIdx);
  p.Messages().clear();

  // An id the server never had: nothing to tell
  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff00beef)));
  REQUIRE(p.worldState.hosters.find(0xff00beef) == p.worldState.hosters.end());
  REQUIRE(p.Messages().empty());
}

TEST_CASE("A host attempt for an NPC that is there still hosts it",
          "[PartOne][Host]")
{
  PartOne p;
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0.f, 0.f, 0.f }, 0.f, 0x3c);
  p.SetUserActor(0, 0xff000000);
  p.CreateActor(0xff000001, { 100.f, 0.f, 0.f }, 0.f, 0x3c);

  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff000001)));
  auto it = p.worldState.hosters.find(0xff000001);
  REQUIRE(it != p.worldState.hosters.end());
  REQUIRE(it->second == 0xff000000);
}
