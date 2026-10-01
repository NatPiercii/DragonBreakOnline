#include "TestUtils.hpp"

PartOne& GetPartOne();

namespace {
nlohmann::json HostAttempt(uint32_t remoteId)
{
  return nlohmann::json{ { "t", MsgType::Host }, { "remoteId", remoteId } };
}
}

// A client can still ask to host an NPC the server has removed, such as a corpse cleared after its 300 s
TEST_CASE("A host attempt for an NPC that is gone is ignored quietly",
          "[PartOne][Host]")
{
  PartOne p;
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0.f, 0.f, 0.f }, 0.f, 0x3c);
  p.SetUserActor(0, 0xff000000);

  p.CreateActor(0xff000001, { 100.f, 0.f, 0.f }, 0.f, 0x3c);
  p.DestroyActor(0xff000001);
  p.Messages().clear();

  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff000001)));
  REQUIRE(p.worldState.hosters.find(0xff000001) == p.worldState.hosters.end());
  REQUIRE(p.Messages().empty());

  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff00beef)));
  REQUIRE(p.worldState.hosters.find(0xff00beef) == p.worldState.hosters.end());
}

TEST_CASE("A host attempt for an NPC that is there still hosts it",
          "[PartOne][Host]")
{
  // GetPartOne() rather than a bare PartOne: hosting an NPC that EXISTS reaches code that reads the espm, and a bare
  // instance has none attached, so this threw "No espm attached" rather than testing the host. The sibling test above
  // passes with a bare instance only because its NPC is already destroyed and the path stops before it needs espm.
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0.f, 0.f, 0.f }, 0.f, 0x3c);
  p.SetUserActor(0, 0xff000000);
  p.CreateActor(0xff000001, { 100.f, 0.f, 0.f }, 0.f, 0x3c);

  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff000001)));
  auto it = p.worldState.hosters.find(0xff000001);
  REQUIRE(it != p.worldState.hosters.end());
  REQUIRE(it->second == 0xff000000);
}
