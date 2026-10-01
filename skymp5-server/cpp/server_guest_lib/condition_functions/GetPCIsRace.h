#pragma once
#include "ConditionFunction.h"
#include "MpActor.h"

namespace ConditionFunctions {
// GetPCIsRace (130): whether the player character is of a race. The
// condition runs on the actor it is given; for a recipe that is the player
// crafting (More Craftable Equipment's vampire armor, for vampires only).
// Inline so no new source file needs a CMake reconfigure
class GetPCIsRace : public ConditionFunction
{
public:
  const char* GetName() const override { return "GetPCIsRace"; }

  uint16_t GetFunctionIndex() const override { return 130; }

  // parameter1 is the RACE's global form id
  float Execute(MpActor& actor, uint32_t parameter1,
                [[maybe_unused]] uint32_t parameter2,
                const ConditionEvaluatorContext&) override
  {
    return actor.GetRaceId() == parameter1 ? 1.f : 0.f;
  }
};
}
