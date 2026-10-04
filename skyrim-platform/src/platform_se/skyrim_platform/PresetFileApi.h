#pragma once

#include "NapiHelper.h"

// The DBO RaceMenu preset folder and .tri vertex counts (PresetFiles.h)
namespace PresetFileApi {

Napi::Value ReadPresetFile(const Napi::CallbackInfo& info);
Napi::Value WritePresetFile(const Napi::CallbackInfo& info);
Napi::Value RemovePresetFile(const Napi::CallbackInfo& info);
Napi::Value GetTriVertexCount(const Napi::CallbackInfo& info);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set(
    "readPresetFile",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(ReadPresetFile)));
  exports.Set(
    "writePresetFile",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(WritePresetFile)));
  exports.Set(
    "removePresetFile",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(RemovePresetFile)));
  exports.Set("getTriVertexCount",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(GetTriVertexCount)));
}

}
