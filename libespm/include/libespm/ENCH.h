#pragma once
#include "Effects.h"
#include "RecordHeader.h"
#include "SPEL.h"

#pragma pack(push, 1)

namespace espm {

class ENCH final : public RecordHeader
{
public:
  static constexpr auto kType = "ENCH";

  enum class EnchantType : uint32_t
  {
    Enchantment = 0x06,
    StaffEnchantment = 0x0C,
  };

  // Checked on Skyrim.esm: 600 of 604 ENIT are 36 bytes, 4 are 32 (no worn restrictions)
  struct ENIT
  {
    uint32_t enchantmentCost = 0;
    uint32_t flags = 0;
    SPEL::CastType castType = SPEL::CastType::ConstantEffect;
    int32_t enchantmentAmount = 0;
    SPEL::Delivery delivery = SPEL::Delivery::Self;
    EnchantType enchantType = EnchantType::Enchantment;
    float chargeTime = 0.f;
    uint32_t baseEnchantment = 0;
  };
  static_assert(sizeof(ENIT) == 32);

  struct Data
  {
    std::vector<Effects::Effect> effects;
  };

  // ENIT and the same EFID/EFIT pairs a spell has, for the spell hit path
  struct SpellData
  {
    const ENIT* enchantedItem = nullptr;
    std::vector<SPEL::Effect> effects;
  };

  Data GetData(CompressedFieldsCache& compressedFieldsCache) const noexcept;
  SpellData GetSpellData(CompressedFieldsCache& compressedFieldsCache) const;
};
static_assert(sizeof(ENCH) == sizeof(RecordHeader));

}

#pragma pack(pop)
