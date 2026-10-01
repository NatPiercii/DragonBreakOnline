#include "ActionListener.h"
#include "ActiveMagicEffectsMap.h"
#include "SpellCastMessage.h"
#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>

PartOne& GetPartOne();

namespace {
constexpr uint32_t kActor = 0xff000000;

// The player's own cast of spellId, held in the power slot as the server
// requires (CanCastSpell)
void CastOwn(PartOne& p, uint32_t spellId)
{
  auto& ac = p.worldState.GetFormAt<MpActor>(kActor);
  Equipment eq;
  eq.voiceSpell = spellId;
  ac.SetEquipment(eq);

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  SpellCastMessage msg;
  msg.data.caster = 0x14;
  msg.data.target = 0x14;
  msg.data.spell = spellId;
  p.GetActionListener().OnSpellCast(rawMsgData, msg);
}

MpActor& Connect(PartOne& p)
{
  DoConnect(p, 0);
  p.CreateActor(kActor, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, kActor);
  return p.worldState.GetFormAt<MpActor>(kActor);
}

void Disconnect(PartOne& p)
{
  p.DestroyActor(kActor);
  DoDisconnect(p, 0);
}
}

// Highborn sped regeneration up on the client and the server's crop pulled it
// back on every update (2026-09-29): the server now holds the boost too
TEST_CASE("Highborn raises the server's magicka rate while it lasts",
          "[Restoration]")
{
  PartOne& p = GetPartOne();
  auto& ac = Connect(p);
  const float before = ac.GetActorValues().magickaRate;

  // PowerHighElfMagickaRegen: RaceHighElfFortifyMagickaRate, peak value
  // modifier on MagickaRate, 25 for 60 s
  CastOwn(p, 0x0E40C8);

  REQUIRE(
    ac.GetChangeForm().activeMagicEffects.Has(espm::ActorValue::MagickaRate));
  REQUIRE(ac.GetActorValues().magickaRate == Catch::Approx(25.f));
  REQUIRE(ac.GetActorValues().magickaRate > before);

  Disconnect(p);
}

TEST_CASE("A self-cast magicka rate multiplier boost reaches the server",
          "[Restoration]")
{
  PartOne& p = GetPartOne();
  auto& ac = Connect(p);
  const float before = ac.GetActorValues().magickaRateMult;

  // AltarAkatoshSpell (Blessing of Akatosh): FortifyMagickaRateFFSelf, peak
  // value modifier on MagickaRateMult, fire and forget, self
  CastOwn(p, 0x0FB988);

  REQUIRE(ac.GetChangeForm().activeMagicEffects.Has(
    espm::ActorValue::MagickaRateMult_or_CombatHealthRegenMultPowerMod));
  REQUIRE(ac.GetActorValues().magickaRateMult > before);

  Disconnect(p);
}

TEST_CASE("A disease's regeneration damage never reaches the server's rate",
          "[Restoration]")
{
  PartOne& p = GetPartOne();
  auto& ac = Connect(p);
  const float before = ac.GetActorValues().magickaRate;

  // DiseaseWitbane: DisDamageMagickaRegen, flagged detrimental, delivered by
  // contact rather than as a self cast
  CastOwn(p, 0x0B8783);

  REQUIRE_FALSE(
    ac.GetChangeForm().activeMagicEffects.Has(espm::ActorValue::MagickaRate));
  REQUIRE(ac.GetActorValues().magickaRate == Catch::Approx(before));

  Disconnect(p);
}
