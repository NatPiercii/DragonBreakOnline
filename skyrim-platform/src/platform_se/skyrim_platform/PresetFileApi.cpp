#include "PresetFileApi.h"
#include "InvalidArgumentException.h"
#include "PresetFiles.h"

namespace PresetFileApi {

namespace {
std::string ExtractName(const Napi::CallbackInfo& info)
{
  auto name = NapiHelper::ExtractString(info[0], "name");
  if (!PresetFiles::ValidateName(name)) {
    throw InvalidArgumentException("name", name);
  }
  return name;
}
}

Napi::Value ReadPresetFile(const Napi::CallbackInfo& info)
{
  auto text = PresetFiles::Read(ExtractName(info));
  if (!text) {
    return info.Env().Undefined();
  }
  return Napi::String::New(info.Env(), *text);
}

Napi::Value WritePresetFile(const Napi::CallbackInfo& info)
{
  auto name = ExtractName(info);
  auto text = NapiHelper::ExtractString(info[1], "text");
  PresetFiles::Write(name, text);
  return info.Env().Undefined();
}

Napi::Value RemovePresetFile(const Napi::CallbackInfo& info)
{
  return Napi::Boolean::New(info.Env(),
                            PresetFiles::Remove(ExtractName(info)));
}

// skee writes sculpt offsets unchecked, so the client bounds them by this
Napi::Value GetTriVertexCount(const Napi::CallbackInfo& info)
{
  auto triPath = NapiHelper::ExtractString(info[0], "triPath");
  if (!PresetFiles::ValidateTriPath(triPath)) {
    throw InvalidArgumentException("triPath", triPath);
  }

  RE::BSResourceNiBinaryStream file(PresetFiles::TriResourcePath(triPath));
  if (!file.good()) {
    return Napi::Number::New(info.Env(), -1);
  }

  unsigned char header[12] = { 0 };
  if (!file.read(header, static_cast<std::uint32_t>(sizeof(header)))) {
    return Napi::Number::New(info.Env(), -1);
  }

  auto count = PresetFiles::ParseTriVertexCount(header, sizeof(header));
  return Napi::Number::New(info.Env(), static_cast<double>(count));
}

}
