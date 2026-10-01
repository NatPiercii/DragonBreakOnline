'use strict'
// Loaded by `npm run build:win-on-linux` (node -r) to build the Windows installer on Linux without wine.
// electron-builder 26.8.1 runs the NSIS uninstaller generator under wine except on macOS, where it reads the
// uninstaller out of the generator with its own UninstallerReader. This takes that macOS path. The only other caller
// of isMacOsCatalina is macosVersion itself.
const path = require('path')
const lib = path.join(process.cwd(), 'node_modules', 'app-builder-lib', 'out', 'util', 'macosVersion.js')
require(lib).isMacOsCatalina = () => true
