'use strict'
/**
 * Skyrim writes ControlMap_Custom.txt into the game's root folder (beside SkyrimSE.exe) when a player remaps a control
 * in the game's own menu, and that file overrides controlmap.txt. One written before 1.6.1130 lacks the input contexts
 * that update added (the Creations Menu, whose PurchaseCredits event every 1.6.1130+ map has), and such maps are known
 * to break controls on the current game. A stale one is moved aside before launch; a current one is the player's and
 * stays. Our own controlmap.txt override and the Settings tab keep the server's bindings either way.
 */
const fs = require('fs')
const path = require('path')

const NAME = 'ControlMap_Custom.txt'

function isStaleCustomControlmap(text) {
  return !/^PurchaseCredits[ \t]/m.test(text)
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

// Returns the lines to log (none when there is no file or it is current)
function moveStaleCustomControlmap(gameDir, now = new Date()) {
  if (!gameDir) return []
  const file = path.join(gameDir, NAME)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  if (!isStaleCustomControlmap(text)) return []
  let aside = `${file}.stale-${stamp(now)}`
  for (let n = 2; fs.existsSync(aside); n++) aside = `${file}.stale-${stamp(now)}-${n}`
  fs.renameSync(file, aside)
  return [`moved a ${NAME} from before the 1.6.1130 controls (no PurchaseCredits) aside to ${path.basename(aside)}`]
}

module.exports = { moveStaleCustomControlmap, isStaleCustomControlmap }
