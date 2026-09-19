#pragma once
#include "FormDesc.h"
#include "MovementLimits.h"
#include "NiPoint3.h"
#include "PartOne.h"
#include <chrono>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

class MpActor;

namespace MovementValidation {

struct ActorState
{
  NiPoint3 lastPos;
  FormDesc lastCellOrWorld;
  std::chrono::steady_clock::time_point lastTime;
  std::chrono::steady_clock::time_point graceUntil;
  std::chrono::steady_clock::time_point lastSnapBack;
  std::chrono::steady_clock::time_point lastLog;
  std::chrono::steady_clock::time_point lastPeakLog;
  float allowanceXy = 0.f;
  float allowanceUp = 0.f;
  float allowanceDown = 0.f;
  float peakSpeed = 0.f;
  float peakUp = 0.f;
  float peakDown = 0.f;
  uint32_t refusedSinceLog = 0;
  uint32_t serverMovesSinceLog = 0;
  bool seeded = false;
};

// Last accepted position and speed budget per actor, owned by ActionListener
struct Tracker
{
  std::unordered_map<uint32_t, ActorState> states;
  std::chrono::steady_clock::time_point lastPrune;
};

bool Validate(PartOne& partOne, const NiPoint3& currentPos,
              const NiPoint3& currentRot, const FormDesc& currentCellOrWorld,
              const NiPoint3& newPos, const FormDesc& newCellOrWorld,
              Networking::UserId userId, MpActor* actor,
              const EspmFileTable& espmFiles, Tracker* tracker = nullptr);
}
