#pragma once
#include "PropertyBinding.h"

// Read only: whether a plant or other harvestable has been picked (the gameplay layer's harvest roll must not pay a
// picked plant again, combat and economy review 2026-09-29)
class IsHarvestedBinding : public PropertyBinding
{
public:
  std::string GetPropertyName() const override { return "isHarvested"; }
  Napi::Value Get(Napi::Env env, ScampServer& scampServer,
                  uint32_t formId) override;
};
