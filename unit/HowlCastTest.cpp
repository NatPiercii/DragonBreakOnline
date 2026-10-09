#include "MpActor.h"
#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>

PartOne& GetPartOne();
bool CanCastSpell(const MpActor& actor, uint32_t spellId);

namespace {
constexpr uint32_t kActor = 0xff000000;
// Skyrim.esm: HowlWerewolfFear1 (word spell of SHOU cf790), HowlWerewolfDetectLife (word spell of SHOU ce218), Flames
constexpr uint32_t kHowlOfTerror = 0x0CF791;
constexpr uint32_t kHowlDetectLife = 0x0CE217;
constexpr uint32_t kFlames = 0x012FCD;
}

// A werewolf's howl was refused at every cast ("spell cf791 not found in equipment", 70 times on 9 Oct): the client
// equips the shout, which never reaches the server. A howl the server taught for the form may now be cast.
TEST_CASE("A player may cast a shout word the server taught, and no other", "[SpellCast]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(kActor, { 0, 0, 0 }, 0, 0x3c, 7);
  p.SetUserActor(0, kActor);
  auto& ac = p.worldState.GetFormAt<MpActor>(kActor);

  REQUIRE_FALSE(CanCastSpell(ac, kHowlOfTerror));
  ac.AddSpell(kHowlOfTerror);
  REQUIRE(CanCastSpell(ac, kHowlOfTerror));
  REQUIRE_FALSE(CanCastSpell(ac, kHowlDetectLife));

  ac.AddSpell(kFlames);
  REQUIRE_FALSE(CanCastSpell(ac, kFlames));
  Equipment eq;
  eq.rightSpell = kFlames;
  ac.SetEquipment(eq);
  REQUIRE(CanCastSpell(ac, kFlames));

  p.DestroyActor(kActor);
  DoDisconnect(p, 0);
}

TEST_CASE("An NPC's casts are judged as before", "[SpellCast]")
{
  PartOne& p = GetPartOne();
  p.CreateActor(kActor, { 0, 0, 0 }, 0, 0x3c);
  auto& ac = p.worldState.GetFormAt<MpActor>(kActor);
  ac.AddSpell(kHowlDetectLife);
  REQUIRE(CanCastSpell(ac, kHowlDetectLife));
  REQUIRE_FALSE(CanCastSpell(ac, kHowlOfTerror));
  p.DestroyActor(kActor);
}
