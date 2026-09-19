#pragma once
#include <cstdint>

// Speed ceilings for MovementValidation, from server-settings.json
// "movementValidation". Units per second, measured server side between
// accepted movement packets.
struct MovementLimits
{
  bool enabled = true;
  // false logs what would be refused and accepts it anyway, for live tuning
  bool enforce = true;
  // The player's own movement types cap at 500 u/s sprinting and a horse at
  // 600 (MOVT NPC_Sprinting_MT, Horse_Sprint_MT), so these leave a wide margin
  float maxHorizontalSpeed = 1000.f;
  float maxUpSpeed = 2000.f;
  float maxDownSpeed = 4000.f;
  // Seconds of movement an idle actor may bank, so a lag burst arriving at
  // once still passes. Keep rate times burst under the 4096 per packet cap
  float burstSeconds = 3.f;
  // After a server teleport the actor's own in-flight packets are dropped
  // without a snap back for this long
  uint32_t teleportGraceMs = 5000;
  uint32_t snapBackIntervalMs = 250;
  uint32_t logIntervalMs = 5000;
  // Logs a peak line once per logIntervalMs above this share of the ceiling
  float peakLogFraction = 0.75f;
};
