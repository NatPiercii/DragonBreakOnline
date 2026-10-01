#pragma once
#include "RecordHeader.h"
#include "SPEL.h"

#pragma pack(push, 1)

namespace espm {

class SCRL final : public RecordHeader
{
public:
  static constexpr auto kType = "SCRL";

private:
  struct DATA
  {
    float weight;
  };

public:
  // A scroll carries the same SPIT and EFID/EFIT pairs as a spell (checked on Skyrim.esm, Dawnguard, Dragonborn and
  // BSHeartland: SPIT is 36 bytes on every SCRL)
  struct Data
  {
    DATA data;
    const SPEL::SPITData* spellItem = nullptr;
    std::vector<SPEL::Effect> effects{};
  };

  Data GetData(CompressedFieldsCache& compressedFieldsCache) const;
};

static_assert(sizeof(SCRL) == sizeof(RecordHeader));

}

#pragma pack(pop)
