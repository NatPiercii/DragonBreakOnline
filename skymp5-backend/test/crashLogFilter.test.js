'use strict'
// The crash log of a manual problem report keeps what staff need and nothing Crash Logger read from memory
// (docs/auto-report-v1.md §2.4 and §2.10; the privacy review of 30 Sep on launcher 2.1.36's crashLog)
const test = require('node:test')
const assert = require('node:assert')
const { filterCrashLog, filterNames } = require('../sources/crashLogFilter')
const { SECTION_FILTERS } = require('../sources/autoSchema')
const { crashLog, SECRETS } = require('./helpers/crashLogFixture')

const section = (text, name) => {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith(`${name}:`))
  if (at === -1) return null
  const end = lines.findIndex((l, i) => i > at && l === '')
  return lines.slice(at, end === -1 ? undefined : end).join('\n')
}

test('a Crash Logger log keeps its header, call stack, modules and plugins, and nothing it read from memory', () => {
  const { text, redactions } = filterCrashLog(crashLog())
  for (const [label, value] of Object.entries(SECRETS)) {
    if (label === 'account') continue // a path's account name is scrubLog's S3, after this filter
    assert.ok(!text.includes(value), `${label} left in the crash log`)
  }
  assert.doesNotMatch(text, /\r|char\*\) "[^"]/)
  assert.match(text, /^\[crash-2026-10-01-14-22-07\.log, 214 KB, written 2 min before this report, from Documents\]\nCRASH TIME: /)
  assert.match(text, /\nUnhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE\.exe\+06B2C3\tmov rax, \[rcx\+0x10\]\n/)
  assert.match(text, /\nAccess Violation: Tried to read memory at 0x000000000010\n/)
  assert.match(section(text, 'ACCESS VIOLATION ANALYSIS'), /Instruction: mov rax, \[rcx\+0x10\]/)
  assert.strictEqual(section(text, 'PROBABLE CALL STACK'), [
    'PROBABLE CALL STACK:',
    '\t[ 0] 0x7FF6D2A1B2C3      SkyrimSE.exe+06B2C3 -> 19354+0x23\tmov rax, [rcx+0x10]',
    '\t[ 1] 0x7FF6D2C4D5E6      SkyrimSE.exe+28D5E6 -> 50179+0x116\tcall [rax+0x08]',
    '\t[ 2] 0x7FFA1B2C3D4E SkyrimPlatformImpl.dll+0123D4E',
    '\t[ 3] 0x7FFA1B2C4F00 SkyrimPlatformImpl.dll+0124F00',
    '\t[57 more line(s) cut]',
  ].join('\n'))
  assert.match(section(text, 'SYSTEM SPECS'), /\tGPU #1: Nvidia AD104 \[GeForce RTX 4070\]/)
  assert.match(section(text, 'MODULES'), /^MODULES:\n\tSkyrimSE\.exe +0x7FF6D2A00000\n\tSkyrimPlatformImpl\.dll +0x7FFA1B200000\n/)
  assert.match(section(text, 'MODULES'), /\tmodule0005\.dll +0x7FF810050000$/)
  assert.strictEqual(section(text, 'SKSE PLUGINS'),
    'SKSE PLUGINS:\n\tCommunityShaders.dll v1.9.1\n\tCrashLoggerSSE.dll v1.20.0\n\tSkyrimPlatform.dll v2.9.0')
  assert.strictEqual(section(text, 'PLUGINS'), 'PLUGINS:\n\tLight: 1\tRegular: 3\tTotal: 4\n\t[00]     Skyrim.esm\n'
    + '\t[01]     Update.esm\n\t[02]     DragonBreak.esp\n\t[FE:000] ccBGSSSE001-Fish.esm')
  // One MODULES section: the one faked inside a STACK string is not taken for a header
  assert.strictEqual(text.split('\n').filter(l => l === 'MODULES:').length, 1)
  assert.ok(redactions >= 20, `${redactions} redactions`)
})

test('REGISTERS keeps each register and its type, without values, strings or nested object lines', () => {
  assert.strictEqual(section(filterCrashLog(crashLog()).text, 'REGISTERS'), [
    'REGISTERS:', '\tRAX (size_t)', '\tRCX (PlayerCharacter*)', '\tRDX (char*)', '\tRBX (char*)', '\tRSP (void*)',
    '\tRBP (char*)', '\tRSI (void* -> SkyrimSE.exe+06B2C3\tmov rax, [rcx+0x10])', '\tRDI (char*)', '\tR8 (size_t)',
  ].join('\n'))
})

test('STACK, PROCESS INFO and THREAD CONTEXT are left out, each as one line', () => {
  const { text } = filterCrashLog(crashLog())
  assert.match(text, /\n\nSTACK: \[11 line\(s\) left out by the server, values read from memory\]\n\nMODULES:\n/)
  assert.match(text, /\n\nPROCESS INFO: \[4 line\(s\) left out by the server\]\n\nTHREAD CONTEXT: \[2 line\(s\) left out by the server\]\n\nSYSTEM SPECS:\n/)
  assert.doesNotMatch(text, /RSP\+0 |\[RSP\+|Working Directory|Command Line|Likely Role/)
})

test('POSSIBLE RELEVANT OBJECTS goes through the auto report filter: every name, every quoted string but File', () => {
  const objects = [
    `\tRBX: (PlayerCharacter*) "${SECRETS.playerName}" [0x00000014] (Skyrim.esm)`,
    '\tRSP+70: (TESNPC*)',
    `\t\tName: "${SECRETS.nestedName}"`,
    `\t\tFull Name: ${SECRETS.unquotedName}`,
    `\t\tDisplay Name: ${SECRETS.otherPlayer}`,
    '\t\tFile: "DragonBreak.esp"',
  ].join('\n')
  const { text } = filterCrashLog(`POSSIBLE RELEVANT OBJECTS:\n${objects}`)
  assert.strictEqual(text, `POSSIBLE RELEVANT OBJECTS:\n${SECTION_FILTERS.relevantObjects(objects)}`)
  assert.strictEqual(text, ['POSSIBLE RELEVANT OBJECTS:', '\tRBX: (PlayerCharacter*) "" [0x00000014] (Skyrim.esm)',
    '\tRSP+70: (TESNPC*)', '\t\tName: <name>', '\t\tFull Name: <name>', '\t\tDisplay Name: <name>',
    '\t\tFile: "DragonBreak.esp"'].join('\n'))
})

test('every section header CrashLoggerSSE writes is one, an indented look-alike is not, and an unknown one is left out', () => {
  const log = [
    'Unhandled exception "EXCEPTION_STACK_OVERFLOW" at 0x7FF6D2A1B2C3',
    '',
    'CALL STACK ([P]robable / [S]tack scan):',
    '\t[0][P] 0x7FF6D2A1B2C3 SkyrimSE.exe+06B2C3',
    '\tREGISTERS:',
    '',
    'RECONSTRUCTED CALL STACK (STACK SCAN):',
    '\t[0] 0x7FFA1B2C3D4E SkyrimPlatformImpl.dll+0123D4E',
    '',
    'CALL STACK (HYBRID):',
    '\tFAILED TO READ TIB',
    '',
    'FUTURE SECTION (2):',
    `\t(char*) ${SECRETS.chat}`,
    `\t${SECRETS.otherPlayer}`,
    '',
    'POSSIBLE RELEVANT OBJECTS (1):',
    `\tRSI: (Character*) "${SECRETS.otherPlayer}" [0xFF000D2E]`,
  ].join('\n')
  const { text } = filterCrashLog(log)
  assert.strictEqual(text, [
    'Unhandled exception "EXCEPTION_STACK_OVERFLOW" at 0x7FF6D2A1B2C3',
    '',
    'CALL STACK ([P]robable / [S]tack scan):',
    '\t[0][P] 0x7FF6D2A1B2C3 SkyrimSE.exe+06B2C3',
    '\tREGISTERS:',
    '',
    'RECONSTRUCTED CALL STACK (STACK SCAN):',
    '\t[0] 0x7FFA1B2C3D4E SkyrimPlatformImpl.dll+0123D4E',
    '',
    'CALL STACK (HYBRID):',
    '\tFAILED TO READ TIB',
    '',
    'FUTURE SECTION: [2 line(s) left out by the server]',
    '',
    'POSSIBLE RELEVANT OBJECTS (1):',
    '\tRSI: (Character*) "" [0xFF000D2E]',
  ].join('\n'))
})

test('a C++ exception keeps its type, throw location and module, not its message', () => {
  const log = [
    'Unhandled exception "C++ Exception" at 0x7FFA10001234 KERNELBASE.dll+0001234',
    '',
    'C++ EXCEPTION:',
    '\tType: (std::runtime_error*)',
    `\tInfo: ${SECRETS.cppMessage} "${SECRETS.chat}`,
    `${SECRETS.otherPlayer} said ${SECRETS.pm}`,
    `\tfrom <@${SECRETS.mention}>`,
    '\tThrow Location: SkyrimPlatformImpl.dll+0123D4E',
    '\tModule: SkyrimPlatformImpl.dll',
    '',
    'PROBABLE CALL STACK:',
    '\t[ 0] 0x7FFA10001234 KERNELBASE.dll+0001234',
  ].join('\n')
  const { text } = filterCrashLog(log)
  assert.strictEqual(text, [
    'Unhandled exception "C++ Exception" at 0x7FFA10001234 KERNELBASE.dll+0001234',
    '',
    'C++ EXCEPTION:',
    '\tType: (std::runtime_error*)',
    '\tInfo: <left out by the server>',
    '\tThrow Location: SkyrimPlatformImpl.dll+0123D4E',
    '\tModule: SkyrimPlatformImpl.dll',
    '',
    'PROBABLE CALL STACK:',
    '\t[ 0] 0x7FFA10001234 KERNELBASE.dll+0001234',
  ].join('\n'))
})

test("a string read from memory over several lines is left out to its closing quote, the launcher's cut, or 1000 characters", () => {
  // Crash Logger keeps newlines in a string it reads (Introspection.cpp analyze_string)
  const parameter = [
    'Exception Information Parameters:',
    `\tParameter[0]: 0x01D3A5B0C400 (char*) "${SECRETS.chat}`,
    `${SECRETS.otherPlayer}`,
    'MODULES:',
    `\t${SECRETS.pm}" and after`,
    '\tParameter[1]: 0x000000000001 (size_t) [1]',
  ].join('\n')
  assert.strictEqual(filterCrashLog(parameter).text, [
    'Exception Information Parameters:',
    '\tParameter[0]: 0x01D3A5B0C400 (char*) ""',
    ' and after',
    '\tParameter[1]: 0x000000000001 (size_t) [1]',
  ].join('\n'))

  // condenseCrashLog cut the section inside the string: its mark closes it, and the next section is read as one
  const cut = [
    'PROBABLE CALL STACK:',
    `\t[ 0] 0x7FFA1B2C3D4E SkyrimPlatformImpl.dll+0123D4E (char*) "${SECRETS.chat}`,
    `${SECRETS.letterLine}`,
    '\t[40 more line(s) cut]',
    '',
    'MODULES:',
    '\tSkyrimSE.exe 0x7FF6D2A00000',
  ].join('\n')
  assert.strictEqual(filterCrashLog(cut).text, [
    'PROBABLE CALL STACK:',
    '\t[ 0] 0x7FFA1B2C3D4E SkyrimPlatformImpl.dll+0123D4E (char*) ""',
    '\t[40 more line(s) cut]',
    '',
    'MODULES:',
    '\tSkyrimSE.exe 0x7FF6D2A00000',
  ].join('\n'))

  // No string Crash Logger reads is longer than 999 characters, so a quote left open by mistake costs no more
  const long = ['MODULES:', '\tweird"module.dll 0x1', ...Array.from({ length: 30 }, (_, i) => `\tm${i}.dll ${'0'.repeat(40)}`), '\tlast.dll 0x2']
  const out = filterCrashLog(long.join('\n')).text.split('\n')
  assert.deepStrictEqual(out.slice(0, 2), ['MODULES:', '\tweird""'])
  assert.ok(out.length > 4 && out.length < 31, `${out.length} lines`)
  assert.strictEqual(out[out.length - 1], '\tlast.dll 0x2')
})

test('CommunityShaders.log loses Name values and keeps its own quoted paths and keys', () => {
  const stamp = '[2026-09-28 21:15:00.000] [debug] [4120]'
  const log = [
    `${stamp} [InverseSquareLighting.cpp:45] [InverseSquareLighting] FormID: 0x00012345 | Light*: 0x1F2E | Name: ${SECRETS.otherPlayer} - light uninitialised`,
    `${stamp} [PrecipitationWidget.cpp:204] Precipitation SkyrimStormRain: saved texture path 'textures\\rain.dds' not found on disk`,
    `${stamp} [State.cpp:390] Loading "Data\\SKSE\\Plugins\\CommunityShaders\\Features\\GrassLighting.ini"`,
  ].join('\r\n')
  const { text, redactions } = filterNames(log)
  assert.strictEqual(redactions, 1)
  assert.ok(!text.includes(SECRETS.otherPlayer))
  assert.match(text, /\| Name: <name>\n/)
  assert.match(text, /'textures\\rain\.dds' not found on disk\n/)
  assert.match(text, /Loading "Data\\SKSE\\Plugins\\CommunityShaders\\Features\\GrassLighting\.ini"$/)
})

test("Crash Logger's own GetFullName label goes the way of every Name value", () => {
  const log = [
    'Exception Information Parameters:',
    `\tParameter[1]: 0x1D3A5B0C800 (TESNPC*)\n\t\tGetFullName: ${SECRETS.nestedName}`,
    '',
    'POSSIBLE RELEVANT OBJECTS:',
    `\tRSP+70: (TESNPC*) GetFullName: ${SECRETS.unquotedName}`,
  ].join('\n')
  const { text } = filterCrashLog(log)
  assert.ok(!text.includes(SECRETS.nestedName) && !text.includes(SECRETS.unquotedName), text)
  assert.match(text, /\t\tGetFullName: <name>\n/)
  assert.match(text, /\tRSP\+70: \(TESNPC\*\) GetFullName: <name>$/)
  assert.strictEqual(filterNames(`x GetFullName: ${SECRETS.otherPlayer}`).text, 'x GetFullName: <name>')
})

test('a kept line whose string holds quotes of its own is cut at its first quote', () => {
  // Crash Logger's quoted() does not escape, so a JSON packet's text would sit between the quote pairs
  const packet = `{"t":"chat","msg":"${SECRETS.chat} ${SECRETS.email} <@${SECRETS.mention}>"}`
  const log = [
    'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE.exe+06B2C3',
    'Exception Information Parameters:',
    `\tParameter[1]: 0x1D3A5B0C400 (char*) "${packet}"`,
    '',
    'C++ EXCEPTION:',
    `\tType: (char*) "${packet}"`,
    '',
    'POSSIBLE RELEVANT OBJECTS:',
    `\tRSI: (Character*) "Bob "${SECRETS.otherPlayer}" Smith" [0xFF000D2E] (DragonBreak.esp)`,
    '\tRBX: (PlayerCharacter*) "Kept" [0x00000014] (Skyrim.esm)',
    '\t\tFile: "DragonBreak.esp"',
  ].join('\n')
  const { text } = filterCrashLog(log)
  for (const value of [SECRETS.chat, SECRETS.email, SECRETS.mention, SECRETS.otherPlayer]) assert.ok(!text.includes(value), text)
  assert.strictEqual(text, [
    'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF6D2A1B2C3 SkyrimSE.exe+06B2C3',
    'Exception Information Parameters:',
    '\tParameter[1]: 0x1D3A5B0C400 (char*) ""',
    '',
    'C++ EXCEPTION:',
    '\tType: (char*) ""',
    '',
    'POSSIBLE RELEVANT OBJECTS:',
    '\tRSI: (Character*) ""',
    '\tRBX: (PlayerCharacter*) "" [0x00000014] (Skyrim.esm)',
    '\t\tFile: "DragonBreak.esp"',
  ].join('\n'))
})

test('a crash log loses emails, mentions, player tags and OneDrive organisations; CommunityShaders.log its organisation', () => {
  const org = 'OneDrive - Contoso Secret Org'
  const log = [
    `Minidump written to: C:\\Users\\Arvel\\${org}\\Documents\\My Games\\Skyrim Special Edition\\SKSE\\crash.dmp`,
    `\tParameter[1]: 0x1D3A5B0C400 note ${SECRETS.email} <@${SECRETS.mention}> Brelyna #Q7K2`,
  ].join('\n')
  const { text } = filterCrashLog(log)
  for (const value of ['Contoso', SECRETS.email, SECRETS.mention, '#Q7K2']) assert.ok(!text.includes(value), text)
  assert.match(text, /\\OneDrive - <org>\\Documents\\/)
  assert.match(text, /note <email> <discord> <player>$/)
  const cs = filterNames(`[2026-09-28 21:15:00.000] [info] [4120] [State.cpp:390] Loading "C:\\Users\\Arvel\\${org}\\Documents\\x.ini"`)
  assert.strictEqual(cs.redactions, 1)
  assert.match(cs.text, /\\OneDrive - <org>\\Documents\\x\.ini"$/)
})

test("inside REGISTERS or STACK a header-like line counts only for a later section and as that header's last line", () => {
  // condenseCrashLog keeps 30 STACK lines, then a memory string's own 'MODULES:' line looks like a header to it
  const log = [
    'REGISTERS:',
    '\tRAX 0x0                (size_t) [0]',
    '\t[20 more line(s) cut]',
    'STACK:',
    `\t${SECRETS.letterLine}`,
    'SYSTEM SPECS:',
    `\t${SECRETS.pm}`,
    '',
    'STACK:',
    '\t[RSP+0  ] 0x0                (size_t) [0]',
    '\t[370 more line(s) cut]',
    'MODULES:',
    `${SECRETS.fakeSection}`,
    '\t[RSP+1A8] 0x1D3A5B0CB00      (TESNPC*)',
    `\t\tSelf: [Actor <${SECRETS.unquotedName} (FF000123)>]`,
    '',
    'MODULES:',
    '\tSkyrimSE.exe                  0x7FF6D2A00000',
    '',
    'SKSE PLUGINS:',
    '\tCrashLoggerSSE.dll v1.20.0',
  ].join('\n')
  const { text } = filterCrashLog(log)
  for (const value of [SECRETS.letterLine, SECRETS.pm, SECRETS.fakeSection, SECRETS.unquotedName]) assert.ok(!text.includes(value), text)
  assert.strictEqual(text, [
    'REGISTERS:',
    '\tRAX (size_t)',
    '',
    'STACK: [6 line(s) left out by the server, values read from memory]',
    '',
    'MODULES:',
    '\tSkyrimSE.exe                  0x7FF6D2A00000',
    '',
    'SKSE PLUGINS:',
    '\tCrashLoggerSSE.dll v1.20.0',
  ].join('\n'))
})
