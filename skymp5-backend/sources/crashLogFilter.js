'use strict'
// The Crash Logger crash-*.log of a manual problem report, cut down to what staff need before it reaches Discord
// (docs/auto-report-v1.md §2.4 and §2.10). Launcher 2.1.36 condenses the log by line counts only
// (report.js condenseCrashLog), so what it sends still has REGISTERS and STACK, with the objects and the strings Crash
// Logger read from memory: the player's character name, other players' FF-range NPC names, chat, /pm text, emails,
// mentions and tokens. Section by section:
// - REGISTERS keeps `<REG> (<type>)` only (autoSchema SECTION_FILTERS.registers);
// - STACK is left out whole, with a one-line marker;
// - POSSIBLE RELEVANT OBJECTS: every Name value becomes <name> and every quoted string but File: "<plugin>" is dropped
//   (SECTION_FILTERS.relevantObjects);
// - the header, the exception analysis, the call stacks, SYSTEM SPECS, MODULES, SKSE PLUGINS and PLUGINS are kept under
//   the same name and string rules (the quoted exception name stays); a C++ exception's message is left out;
// - any other section (PROCESS INFO, THREAD CONTEXT, or one a later Crash Logger adds) is left out with a marker.
// What is left then loses emails, mentions, player tags and OneDrive organisations (S12-S15), and scrubLog.scrub's JWT,
// S3-S10 and IP rules run after this.

const { SECTION_FILTERS, QUOTED } = require('./autoSchema')
const { clean, RULES } = require('./autoScrub')

// Email, Discord mention, player tag and OneDrive organisation (scrub-rules.json), which scrubLog's S3-S10 do not cover
const CRASH_RULES = RULES.filter(rule => ['S12', 'S13', 'S14', 'S15'].includes(rule.id))
const CS_RULES = RULES.filter(rule => rule.id === 'S15')

// autoSchema's NAME_VALUE plus Crash Logger's own GetFullName label (Introspection.cpp TESFullName)
const NAME_VALUE = /\b((?:GetFull|Full )?Name[ \t]*:[ \t]*)[^\n]*/gi

// 'REGISTERS:', 'POSSIBLE RELEVANT OBJECTS (12):', 'CALL STACK (HYBRID):', 'CALL STACK ([P]robable / [S]tack scan):',
// 'C++ EXCEPTION:'. Crash Logger writes its headers at the start of a line, so an indented line is never one.
const SECTION = /^([A-Z][A-Z0-9 +]*[A-Z0-9+])(?: \((?:\d+|[A-Za-z0-9 /[\]]{1,40})\))?:[ \t]*$/
// Kept under the name and string rules. Every name is one CrashLoggerSSE writes (CrashHandler.cpp, Analysis.cpp).
const KEPT = new Set([
  'C++ EXCEPTION', 'ACCESS VIOLATION ANALYSIS', 'SYSTEM SPECS', 'VR SPECS',
  'PROBABLE CALL STACK', 'CALL STACK', 'RAW CALL STACK', 'RECONSTRUCTED CALL STACK',
  'MODULES', 'SKSE PLUGINS', 'PLUGINS',
])
const OBJECTS = 'POSSIBLE RELEVANT OBJECTS'
const REGISTERS = 'REGISTERS'
const STACK = 'STACK'
const shown = section => !section || KEPT.has(section) || section === OBJECTS || section === REGISTERS
// The quoted exception name of 'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at ...' is Crash Logger's own text
const EXCEPTION_NAME = /^"(?:EXCEPTION_[A-Z_]{3,40}|C\+\+ Exception)"$/
// A C++ exception's what() is text from memory (a SkyrimPlatform error can quote a packet or a chat line) and can run
// over several lines, so everything from 'Info:' to the next line Crash Logger writes itself is left out
const CPP_MESSAGE = /^[ \t]*Info:[ \t]*\S/
const CPP_RESUME = /^(?:\t(?:Throw Location|Module): |Nested Exception \(depth \d+\):|Unhandled exception )/
// condenseCrashLog's mark for the lines it cut from a section: a string still open there was cut with them
const LAUNCHER_CUT = /^\t\[\d+ more line\(s\) cut\]$/
// Crash Logger reads at most 999 characters of a string (Introspection.cpp analyze_string), newlines and tabs included
const STRING_MAX = 1000

const quotes = line => line.split('"').length - 1

// Quotes Crash Logger writes around its own text: a plugin file name and the exception name
const PROTECTED = /\bFile:[ \t]*"[^"\n]*"|"(?:EXCEPTION_[A-Z_]{3,40}|C\+\+ Exception)"/g

// Crash Logger leaves quotes inside a string unescaped (a JSON packet), so a line with more than two is cut at its first
function cutQuotedText(line, counted) {
  const bare = line.replace(PROTECTED, m => ' '.repeat(m.length))
  if (quotes(bare) <= 2) return line
  counted.n++
  return `${line.slice(0, bare.indexOf('"'))}""`
}

function applyRules(text, rules, counted) {
  for (const rule of rules) {
    const found = text.match(rule.re)
    if (found) counted.n += found.length
    text = text.replace(rule.re, rule.replacement)
  }
  return text
}

function keptLine(line, counted) {
  return cutQuotedText(line, counted)
    .replace(NAME_VALUE, (_m, label) => { counted.n++; return `${label}<name>` })
    .replace(QUOTED, (m, file) => {
      if (file || EXCEPTION_NAME.test(m)) return m
      counted.n++
      return '""'
    })
}

// Returns the filtered log and how many names, strings, register values and sections were left out
function filterCrashLog(input) {
  const out = []
  const counted = { n: 0 }
  let section = ''
  let open = -1          // characters so far of a quoted string opened on an earlier line, or -1
  let cppMessage = false // inside a C++ exception's message
  let leftOut = 0        // lines of a section that is left out
  let blanks = 0         // blank lines at the end of it, kept so the next section stays apart

  const endSection = () => {
    if (!shown(section)) {
      out.push(`${section}: [${leftOut} line(s) left out by the server${section === STACK ? ', values read from memory' : ''}]`)
      for (; blanks > 0; blanks--) out.push('')
      counted.n++
    }
    leftOut = 0
    blanks = 0
    cppMessage = false
  }

  for (let line of clean(input).split('\n')) {
    let resumed = false
    if (open >= 0) {
      const close = line.indexOf('"')
      // Inside the string: no section starts here, whatever the line looks like
      if (close === -1 && !LAUNCHER_CUT.test(line) && open + line.length < STRING_MAX) {
        open += line.length + 1
        leftOut++
        continue
      }
      open = -1
      if (close !== -1) {
        line = line.slice(close + 1)
        resumed = true
        leftOut++
        if (!line.trim()) continue
      }
    }
    const header = !resumed && SECTION.exec(line)
    if (header) {
      endSection()
      section = header[1]
      if (shown(section)) out.push(line)
      continue
    }

    // A C++ exception's message is not a quoted string, so its quotes open nothing
    if (section === 'C++ EXCEPTION' && !CPP_RESUME.test(line) && (cppMessage || CPP_MESSAGE.test(line))) {
      if (!cppMessage) {
        out.push(line.replace(/^([ \t]*Info:).*$/, '$1 <left out by the server>'))
        counted.n++
        cppMessage = true
      }
      continue
    }
    cppMessage = false

    // An odd number of quotes leaves a string open into the next lines
    if (quotes(line) % 2) open = line.length - line.lastIndexOf('"')

    if (!shown(section)) {
      if (line.trim()) { leftOut++; blanks = 0 } else blanks++
    } else if (section === OBJECTS) {
      const kept = SECTION_FILTERS.relevantObjects(cutQuotedText(line, counted).replace(NAME_VALUE, '$1<name>'))
      if (kept !== line) counted.n++
      out.push(kept)
    } else if (section === REGISTERS) {
      // A register line keeps its tab; anything else in the section (nested object lines, strings) goes
      const kept = SECTION_FILTERS.registers(line)
      if (kept) out.push(`\t${kept}`)
      else if (!line.trim()) out.push(line)
      if (line.trim() && `\t${kept}` !== line) counted.n++
    } else out.push(keptLine(line, counted))
  }
  endSection()
  return { text: applyRules(out.join('\n'), CRASH_RULES, counted), redactions: counted.n }
}

// CommunityShaders.log holds only Community Shaders' own messages (spdlog, '[%Y-%m-%d %H:%M:%S.%e] [%l] [%t] [%s:%#] %v'):
// no memory dumps and no game text. Its one 'Name:' label is a light's node name in a debug line
// (InverseSquareLighting.cpp), which goes the way of every Name value. Its quoted values are its own paths, setting keys
// and weather editor ids, which staff need, so the string rule does not apply to it.
function filterNames(input) {
  const counted = { n: 0 }
  const text = clean(input).replace(NAME_VALUE, (_m, label) => { counted.n++; return `${label}<name>` })
  return { text: applyRules(text, CS_RULES, counted), redactions: counted.n }
}

module.exports = { filterCrashLog, filterNames, SECTION, KEPT }
