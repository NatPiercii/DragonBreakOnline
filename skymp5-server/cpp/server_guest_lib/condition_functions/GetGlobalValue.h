#pragma once
#include "ConditionFunction.h"
#include "MpActor.h"
#include "WorldState.h"
#include "libespm/Loader.h"

namespace ConditionFunctions {
// Inline so no new source file needs a CMake reconfigure
class GetGlobalValue : public ConditionFunction
{
public:
  const char* GetName() const override { return "GetGlobalValue"; }

  uint16_t GetFunctionIndex() const override { return 74; }

  // parameter1 is the GLOB's global form id
  float Execute(MpActor& actor, uint32_t parameter1,
                [[maybe_unused]] uint32_t parameter2,
                const ConditionEvaluatorContext&) override
  {
    WorldState* worldState = actor.GetParent();
    if (!worldState || !parameter1) {
      return 0.f;
    }
    try {
      return espm::GetData<espm::GLOB>(parameter1, worldState).value;
    } catch (std::exception&) {
      return 0.f;
    }
  }
};
}
