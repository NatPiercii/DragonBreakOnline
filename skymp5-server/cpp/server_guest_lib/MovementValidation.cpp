#include "MovementValidation.h"
#include "FormDesc.h"
#include "MpActor.h"
#include "NiPoint3.h"
#include "PartOne.h"
#include "TeleportMessage2.h"
#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <string>

namespace {

float HorizontalDistance(const NiPoint3& a, const NiPoint3& b)
{
  const float dx = a.x - b.x, dy = a.y - b.y;
  return std::sqrt(dx * dx + dy * dy);
}

// A seeded actor gets one second of budget, not the full burst, so that a
// server teleport cannot be used as a free jump of up to the single packet cap
void Seed(MovementValidation::ActorState& st, const NiPoint3& pos,
          const FormDesc& cellOrWorld,
          std::chrono::steady_clock::time_point now,
          const MovementLimits& limits)
{
  const float seconds = std::min(1.f, limits.burstSeconds);
  st.lastPos = pos;
  st.lastCellOrWorld = cellOrWorld;
  st.lastTime = now;
  st.allowanceXy = limits.maxHorizontalSpeed * seconds;
  st.allowanceUp = limits.maxUpSpeed * seconds;
  st.allowanceDown = limits.maxDownSpeed * seconds;
  st.refusedSinceLog = 0;
  st.peakSpeed = st.peakUp = st.peakDown = 0.f;
  st.seeded = true;
}

float Refill(float allowance, float rate, float dtSec, float burstSeconds)
{
  return std::min(rate * burstSeconds, allowance + rate * dtSec);
}

// Only player characters get an entry, so this matters after a long uptime
void Prune(MovementValidation::Tracker& tracker,
           std::chrono::steady_clock::time_point now)
{
  constexpr size_t kPruneAbove = 256;
  if (tracker.states.size() < kPruneAbove ||
      now - tracker.lastPrune < std::chrono::seconds(30)) {
    return;
  }
  tracker.lastPrune = now;
  std::erase_if(tracker.states, [&](const auto& pair) {
    return now - pair.second.lastTime > std::chrono::minutes(10);
  });
}

} // namespace

namespace MovementValidation {

bool Validate(PartOne& partOne, const NiPoint3& currentPos,
              const NiPoint3& currentRot, const FormDesc& currentCellOrWorld,
              const NiPoint3& newPos, const FormDesc& newCellOrWorld,
              Networking::UserId userId, MpActor* actor,
              const EspmFileTable& espmFiles, Tracker* tracker)
{
  constexpr float kSqrMaxDistance = 4096.f * 4096.f;

  PartOneSendTargetWrapper& sendTarget = partOne.GetSendTarget();

  // Not doing this to any NPCs at this moment, yet we might consider to
  const bool isMe = actor && partOne.serverState.ActorByUser(userId) == actor;

  auto sendSnapBack = [&] {
    TeleportMessage2 msg;
    msg.pos = { currentPos[0], currentPos[1], currentPos[2] };
    msg.rot = { currentRot[0], currentRot[1], currentRot[2] };
    msg.worldOrCell = currentCellOrWorld.ToFormId(espmFiles);
    sendTarget.Send(userId, msg, true);
  };

  if (currentCellOrWorld != newCellOrWorld ||
      (currentPos - newPos).SqrLength() >= kSqrMaxDistance) {
    if (isMe) {
      sendSnapBack();
    }
    return false;
  }

  const auto& limits = partOne.worldState.movementLimits;

  // Refusing an NPC's move with no correction path freezes the server's copy
  // of it, so the rate check is for player characters only
  if (!tracker || !isMe || !limits.enabled) {
    return true;
  }

  const auto now = std::chrono::steady_clock::now();
  Prune(*tracker, now);
  auto& st = tracker->states[actor->GetFormId()];

  // The server's own position having moved since the last accepted packet
  // means the server teleported this actor: door, respawn, locationalData
  const bool serverMoved = st.seeded &&
    (st.lastPos != currentPos || st.lastCellOrWorld != currentCellOrWorld);
  if (!st.seeded) {
    Seed(st, currentPos, currentCellOrWorld, now, limits);
  } else if (serverMoved) {
    Seed(st, currentPos, currentCellOrWorld, now, limits);
    st.serverMovesSinceLog++;
    st.graceUntil = now + std::chrono::milliseconds(limits.teleportGraceMs);
  }

  const float dtSec =
    std::min(limits.burstSeconds,
             std::chrono::duration<float>(now - st.lastTime).count());
  st.lastTime = now;
  st.allowanceXy = Refill(st.allowanceXy, limits.maxHorizontalSpeed, dtSec,
                          limits.burstSeconds);
  st.allowanceUp =
    Refill(st.allowanceUp, limits.maxUpSpeed, dtSec, limits.burstSeconds);
  st.allowanceDown =
    Refill(st.allowanceDown, limits.maxDownSpeed, dtSec, limits.burstSeconds);

  const float dxy = HorizontalDistance(newPos, currentPos);
  const float dz = newPos.z - currentPos.z;
  const float up = dz > 0.f ? dz : 0.f;
  const float down = dz < 0.f ? -dz : 0.f;
  const bool withinBudget = dxy <= st.allowanceXy && up <= st.allowanceUp &&
    down <= st.allowanceDown;

  auto accept = [&] {
    st.allowanceXy -= dxy;
    st.allowanceUp -= up;
    st.allowanceDown -= down;
    st.lastPos = newPos;
    st.lastCellOrWorld = newCellOrWorld;
  };

  const auto logInterval = std::chrono::milliseconds(limits.logIntervalMs);
  const float speedXy = dtSec > 0.f ? dxy / dtSec : 0.f;

  if (withinBudget) {
    accept();
    // A peak line per interval keeps the ceiling honest against real play
    if (dtSec >= 0.05f) {
      st.peakSpeed = std::max(st.peakSpeed, speedXy);
      st.peakUp = std::max(st.peakUp, up / dtSec);
      st.peakDown = std::max(st.peakDown, down / dtSec);
      const bool worthALine =
        st.peakSpeed >= limits.peakLogFraction * limits.maxHorizontalSpeed ||
        st.serverMovesSinceLog >= 20;
      if (worthALine && now - st.lastPeakLog >= logInterval) {
        spdlog::info("MovementValidation: actor {:x} peaked at {:.0f} u/s "
                     "horizontal, {:.0f} up, {:.0f} down, server moved {} "
                     "time(s) (ceilings {:.0f} {:.0f} {:.0f})",
                     actor->GetFormId(), st.peakSpeed, st.peakUp, st.peakDown,
                     st.serverMovesSinceLog, limits.maxHorizontalSpeed,
                     limits.maxUpSpeed, limits.maxDownSpeed);
        st.lastPeakLog = now;
        st.peakSpeed = st.peakUp = st.peakDown = 0.f;
        st.serverMovesSinceLog = 0;
      }
    }
    return true;
  }

  st.refusedSinceLog++;
  const bool inGrace = now < st.graceUntil;

  if (!inGrace && now - st.lastLog >= logInterval) {
    spdlog::warn("MovementValidation: {} actor {:x} (user {}) moved {:.0f} u "
                 "horizontally and {:+.0f} u vertically in {:.0f} ms ({:.0f} "
                 "u/s, budget {:.0f}), {} refusal(s) since the last line",
                 limits.enforce ? "refused" : "would refuse",
                 actor->GetFormId(), userId, dxy, dz, dtSec * 1000.f, speedXy,
                 st.allowanceXy, st.refusedSinceLog);
    st.lastLog = now;
    st.refusedSinceLog = 0;
  }

  // Logging only: take the position the way the old server did, change nothing
  if (!limits.enforce) {
    accept();
    st.allowanceXy = std::max(0.f, st.allowanceXy);
    st.allowanceUp = std::max(0.f, st.allowanceUp);
    st.allowanceDown = std::max(0.f, st.allowanceDown);
    return true;
  }

  // In-flight packets from before a server teleport, dropped with no snap back
  if (inGrace) {
    return false;
  }

  if (now - st.lastSnapBack >=
      std::chrono::milliseconds(limits.snapBackIntervalMs)) {
    st.lastSnapBack = now;
    sendSnapBack();
  }
  return false;
}

} // namespace MovementValidation
