// Checks platform_lib/PresetFiles off Windows; build and run it in a scratch
// folder: g++ -std=c++20 -I<repo>/skyrim-platform/src/platform_lib
// PresetFilesTest.cpp <repo>/skyrim-platform/src/platform_lib/PresetFiles.cpp
#include "PresetFiles.h"
#include <cassert>
#include <cstdio>
#include <filesystem>
#include <fstream>
using namespace PresetFiles;
static int fails = 0;
#define CHECK(x)                                                              \
  do {                                                                        \
    if (!(x)) {                                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #x);                 \
      fails++;                                                                \
    }                                                                         \
  } while (0)
template <class F>
bool throws(F f)
{
  try {
    f();
  } catch (...) {
    return true;
  }
  return false;
}
int main()
{
  CHECK(ValidateName("c_ff00012a"));
  CHECK(ValidateName("A-b_9"));
  CHECK(!ValidateName(""));
  CHECK(!ValidateName(std::string(65, 'a')));
  CHECK(ValidateName(std::string(64, 'a')));
  for (auto bad :
       { "..", "a.b", "a/b", "a\\b", "a:b", "C:", "a b", "a\x01", "\xc3\xa9" })
    CHECK(!ValidateName(bad));
  for (auto dev :
       { "CON", "con", "Prn", "aux", "NUL", "COM1", "com9", "LPT1", "lpt9" }) {
    CHECK(!ValidateName(dev));
  }
  for (auto ok : { "COM0", "COM10", "LPT", "CONX", "NULL", "xCON", "COMA" }) {
    CHECK(ValidateName(ok));
  }
  CHECK(throws([] { Write("nul", "x"); }));
  CHECK(PathFor("x").generic_string() ==
        "Data/SKSE/Plugins/CharGen/Presets/DBO/x.jslot");
  CHECK(throws([] { PathFor("../x"); }));
  CHECK(throws([] { Write("a/b", "x"); }));
  CHECK(throws([] { Read(".."); }));
  CHECK(throws([] { Remove("a\\b"); }));
  CHECK(!Read("missing").has_value());
  Write("one", "{\"a\":1}");
  CHECK(Read("one").value() == "{\"a\":1}");
  Write("one", "");
  CHECK(Read("one").value().empty());
  std::string big(kMaxFileBytes + 1, 'x');
  CHECK(throws([&] { Write("big", big); }));
  CHECK(!std::filesystem::exists(PathFor("big")));
  std::string cap(kMaxFileBytes, 'y');
  Write("cap", cap);
  CHECK(Read("cap").value().size() == kMaxFileBytes);
  {
    std::ofstream f(PathFor("over"), std::ios::binary);
    f << big;
  }
  CHECK(throws([] { Read("over"); }));
  std::string bin("a\0b\r\n", 5);
  Write("bin", bin);
  CHECK(Read("bin").value() == bin);
  CHECK(Remove("one"));
  CHECK(!Remove("one"));
  CHECK(ValidateTriPath(
    "Actors\\Character\\Character Assets\\MaleHeadChargen.tri"));
  CHECK(ValidateTriPath("actors/character/FemaleHead.TRI"));
  for (auto bad : { "", "\\x.tri", "/x.tri", " x.tri", "a\\..\\..\\b.tri",
                    "C:\\x.tri", "x.nif", "x.tri\x01", "x.tri ", "tri" })
    CHECK(!ValidateTriPath(bad));
  CHECK(!ValidateTriPath(std::string(197, 'a') + ".tri"));
  CHECK(ValidateTriPath(std::string(196, 'a') + ".tri"));
  CHECK(TriResourcePath("a/b\\c.tri") == "Meshes\\a\\b\\c.tri");
  unsigned char h[12] = { 'F', 'R', 'T',  'R',  'I', '0',
                          '0', '3', 0x10, 0x27, 0,   0 };
  CHECK(ParseTriVertexCount(h, 12) == 10000);
  CHECK(ParseTriVertexCount(h, 11) == -1);
  CHECK(ParseTriVertexCount(nullptr, 12) == -1);
  unsigned char h2[12] = {
    'F', 'R', 'T', 'R', 'I', '0', '0', '2', 1, 0, 0, 0
  };
  CHECK(ParseTriVertexCount(h2, 12) == -1);
  unsigned char h3[12] = { 'F', 'R', 'T',  'R',  'I',  '0',
                           '0', '3', 0xff, 0xff, 0xff, 0xff };
  CHECK(ParseTriVertexCount(h3, 12) == 4294967295LL);
  std::printf(fails ? "%d FAILED\n" : "all passed\n", fails);
  return fails ? 1 : 0;
}
