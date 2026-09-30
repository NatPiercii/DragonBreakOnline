// Scripted test for skyrim_platform/EventHandler.cpp's two event-time rules (2026-09-30):
//   1. TESSpellCastEvent: the cast gate (which hand, voice, power, held scroll or shout word) is decided in
//      ProcessEvent, while a consumed last scroll is still held, and passed by value to the update task.
//   2. SKSE::ActionEvent: type and slot are copied before the update task; SKSE's event is gone by then.
// It checks both in the source, then compiles the gate helper (CastingSourceOf, cut out of the file) with clang++
// against small stand-ins for the CommonLib types it touches and runs it. The real build is the Flatrim MSVC run.
// Run it from the repo root:
//
//   node skyrim-platform/tests/event-time-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const file = path.resolve(__dirname, '..', 'src', 'platform_se', 'skyrim_platform', 'EventHandler.cpp');
const src = fs.readFileSync(file, 'utf8');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- the source ----
const handler = (sig) => { const a = src.indexOf(sig); const b = src.indexOf('\nEventResult EventHandler::ProcessEvent(', a + 1); return a < 0 ? '' : src.slice(a, b < 0 ? undefined : b); };
const spellCast = handler('const RE::TESSpellCastEvent* event');
const action = handler('const SKSE::ActionEvent* event');
check('both handlers are found', spellCast.length > 0 && action.length > 0);
const taskAt = spellCast.indexOf('AddUpdateTask(');
const spellTask = spellCast.slice(taskAt);
check('the cast gate is decided before the update task', spellCast.indexOf('CastingSourceOf(') > 0 && spellCast.indexOf('CastingSourceOf(') < taskAt);
check('...and passed to it by value', /AddUpdateTask\(\[casterId, spellId,\s*isCastValid, castingSource\]/.test(spellCast), spellCast.slice(taskAt, taskAt + 120));
check('nothing in the task reads what a hand holds or has selected', !/selectedSpells|GetEquippedObject|selectedPower/.test(spellTask));
check('the task refuses an invalid cast before sending spellCast', spellTask.indexOf('if (!isCastValid)') > 0 && spellTask.indexOf('if (!isCastValid)') < spellTask.indexOf('SendEvent("spellCast"'));
const actionTask = action.slice(action.indexOf('AddUpdateTask('));
check('the action event task captures no pointer to the event', !/\[[^\]]*\bevent\b[^\]]*\]\s*\(Napi::Env/.test(action), action.slice(action.indexOf('AddUpdateTask('), action.indexOf('AddUpdateTask(') + 90));
check('...and reads nothing through it', !/event->/.test(actionTask));
check('type and slot are copied before the task', /const auto type = event->type\.get\(\);\s*const auto slot = event->slot\.get\(\);/.test(action));
check('no update or tick task in the file captures a raw event pointer', !/Add(Update|Tick)Task\(\s*\[[^\]]*\bevent\b[^\]]*\]/.test(src));

// ---- the gate helper, compiled against stand-ins and run ----
const a = src.indexOf('bool CastingSourceOf(');
const b = src.indexOf('\n}\n', a) + 3;
const helper = src.slice(a, b);
const cpp = `
#include <cstdio>
#include <vector>
namespace RE {
enum class FormType { Spell, Scroll };
struct TESForm { virtual ~TESForm() {} };
struct TESShout;
namespace MagicSystem { enum class CastingSource { kLeftHand, kRightHand, kOther, kInstant }; enum class SpellType { kSpell, kVoicePower, kScroll }; }
struct SpellItem : TESForm { FormType ft = FormType::Spell; MagicSystem::SpellType st = MagicSystem::SpellType::kSpell;
  FormType GetFormType() const { return ft; } MagicSystem::SpellType GetSpellType() const { return st; } };
struct Variation { SpellItem* spell; };
struct TESShout : TESForm { std::vector<Variation> variations; };
struct Power : TESForm { TESShout* shout = nullptr; template <class T> T* As() { return shout; } };
struct Actor {
  struct SlotTypes { enum { kLeftHand, kRightHand, kUnknown, kPowerOrShout, kTotal }; };
  struct Runtime { SpellItem* selectedSpells[4] = {}; Power* selectedPower = nullptr; } rt;
  TESForm* left = nullptr; TESForm* right = nullptr;
  Runtime& GetActorRuntimeData() { return rt; }
  TESForm* GetEquippedObject(bool leftHand) const { return leftHand ? left : right; }
};
}
namespace {
${helper}
}
using CS = RE::MagicSystem::CastingSource;
static int fails = 0;
static void expect(const char* name, bool ok) { std::printf("%s %s\\n", ok ? "ok  " : "FAIL", name); if (!ok) fails++; }
int main() {
  CS out;
  { RE::Actor a; RE::SpellItem s; a.rt.selectedSpells[RE::Actor::SlotTypes::kLeftHand] = &s;
    expect("a spell selected in the left hand casts from the left", CastingSourceOf(&a, &s, out) && out == CS::kLeftHand); }
  { RE::Actor a; RE::SpellItem s; a.rt.selectedSpells[RE::Actor::SlotTypes::kRightHand] = &s;
    expect("...in the right hand from the right", CastingSourceOf(&a, &s, out) && out == CS::kRightHand); }
  { RE::Actor a; RE::SpellItem s; a.rt.selectedSpells[RE::Actor::SlotTypes::kPowerOrShout] = &s;
    expect("a selected power is an instant cast", CastingSourceOf(&a, &s, out) && out == CS::kInstant); }
  { RE::Actor a; RE::SpellItem s; a.rt.selectedSpells[RE::Actor::SlotTypes::kUnknown] = &s;
    expect("the voice slot casts as other", CastingSourceOf(&a, &s, out) && out == CS::kOther); }
  { RE::Actor a; RE::SpellItem s; s.ft = RE::FormType::Scroll; a.right = &s;
    expect("a scroll held in the right hand casts from the right", CastingSourceOf(&a, &s, out) && out == CS::kRightHand); }
  { RE::Actor a; RE::SpellItem s; s.ft = RE::FormType::Scroll; a.left = &s;
    expect("...in the left hand from the left", CastingSourceOf(&a, &s, out) && out == CS::kLeftHand); }
  { RE::Actor a; RE::SpellItem s; s.ft = RE::FormType::Scroll;
    expect("a scroll no longer held is not a cast (why the gate must run at event time)", !CastingSourceOf(&a, &s, out)); }
  { RE::Actor a; RE::SpellItem s; RE::SpellItem other; other.ft = RE::FormType::Scroll; a.right = &other; s.ft = RE::FormType::Scroll;
    expect("a different scroll in hand does not count", !CastingSourceOf(&a, &s, out)); }
  { RE::Actor a; RE::SpellItem word; word.st = RE::MagicSystem::SpellType::kVoicePower; RE::TESShout sh; sh.variations = { { &word } }; RE::Power p; p.shout = &sh; a.rt.selectedPower = &p;
    expect("a shout's word spell casts as other", CastingSourceOf(&a, &word, out) && out == CS::kOther); }
  { RE::Actor a; RE::SpellItem s;
    expect("a spell nothing selected is refused", !CastingSourceOf(&a, &s, out)); }
  return fails ? 1 : 0;
}
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-evtime-'));
try {
  fs.writeFileSync(path.join(dir, 'gate.cpp'), cpp);
  execFileSync('clang++-15', ['-std=c++20', '-Wall', '-Werror', '-o', path.join(dir, 'gate'), path.join(dir, 'gate.cpp')], { stdio: 'pipe' });
  check('the gate helper compiles against the stand-ins', true);
  let outText = '';
  try { outText = execFileSync(path.join(dir, 'gate'), { encoding: 'utf8' }); } catch (e) { outText = String(e.stdout || ''); failures++; }
  process.stdout.write(outText);
  failures += (outText.match(/^FAIL/gm) || []).length;
} catch (e) {
  check('the gate helper compiles against the stand-ins', false, String(e.stderr || e.message).slice(0, 800));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
