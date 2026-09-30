#pragma once
#include <cstdint>

// Speed ceilings for MovementValidation, from server-settings.json
// "movementValidation". Units per second, measured server side between
// accepted movement packets.
struct MovementLimits
{
  bool enabled = true;
  // Each ceiling can refuse on its own, or only log what it would refuse and
  // accept it anyway, for live tuning. server-settings "enforce" sets all three;
  // enforceHorizontal / enforceUp / enforceDown override it one by one
  bool enforceHorizontal = true;
  bool enforceUp = true;
  bool enforceDown = true;
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
  // After a player's first packet of a session every move is accepted for this
  // long: the first moves after a login are the landing and arrival (2026-09-22,
  // 2868 u in the first second, the only refusal of that login)
  uint32_t loginGraceMs = 30000;
  // Staff (console rights) are logged but never refused: GMs fly and noclip
  // (2026-09-24, a senior GM at 3000-4500 u/s for two minutes, 450 refusals)
  bool exemptStaff = true;
  // No movement packet at all for stallMs while at least two players were
  // moving means the server stalled, and the backlog arrives at once: nothing is
  // refused for stallGraceMs after (2026-09-27, an 8.8 s npcGround tick, then
  // refusals of 48-71 u)
  uint32_t stallMs = 1500;
  uint32_t stallGraceMs = 5000;
  uint32_t snapBackIntervalMs = 250;
  uint32_t logIntervalMs = 5000;
  // Logs a peak line once per logIntervalMs above this share of the ceiling
  float peakLogFraction = 0.75f;
};
