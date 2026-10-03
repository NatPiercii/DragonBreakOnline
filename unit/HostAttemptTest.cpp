#include "TestUtils.hpp"

PartOne& GetPartOne();

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

// An index is reused about 10 s after its form goes, while a client with a ghost copy can keep asking for tens of
// minutes. By then a live NPC may hold that index, and that client may have been sent it, so a drop by index would
// take the live NPC off its screen instead (review, Worker D). With the index in use again, nothing is sent.
TEST_CASE("A host attempt for a gone NPC whose index is in use again is told nothing",
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

  // The index is held for 10 s before it may be taken again; a ghost client asks for far longer than that
  p.worldState.ReleaseHeldFormIdx(true);
  p.CreateActor(0xff000002, { 200.f, 0.f, 0.f }, 0.f, 0x3c);
  // The test means nothing unless the new NPC really took the dead one's index
  REQUIRE(p.worldState.GetFormAt<MpActor>(0xff000002).GetIdx() == goneIdx);
  p.Messages().clear();

  REQUIRE_NOTHROW(DoMessage(p, 0, HostAttempt(0xff000001)));
  REQUIRE(p.worldState.hosters.find(0xff000001) == p.worldState.hosters.end());
  // No DestroyActor: it would have removed the live NPC at that index
  REQUIRE(p.Messages().empty());
}
