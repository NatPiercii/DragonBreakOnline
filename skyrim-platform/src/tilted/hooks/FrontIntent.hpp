#pragma once

// Whether another window got in front of the game by the player's own doing
// (alt-tab, the Win key, a click on it) or took it while they were using the
// game (2026-09-29, claude-jake: GetLastInputInfo counts input anywhere, so a
// player still moving the mouse at a stuck menu looked like one who had
// switched away). ForegroundGuard samples every tick on its own thread.

#include <string>

namespace CEFUtils::FrontIntent {
// Every ForegroundGuard tick: remembers Alt/Win presses and where mouse
// buttons went down
void Sample(void* gameWindow);

// True when the player switched to front themselves: Alt or Win within the
// last 700 ms (seen by the game's keyboard or by Windows), a click outside the
// game window in that time, the cursor over front now, or no input to the game
// in that time. why names the evidence either way.
bool PlayerSwitched(void* gameWindow, void* front, std::string& why);

// A click that landed on the game window while another window held the
// front, in the last half second; each click counts once
bool TakeClickOnGameInBackground();
}
