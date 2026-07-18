import { describe, expect, it } from "vitest";
import { LOCAL_SD_ERROR_CODES, mapLocalSdErrorCode } from "./local-sd-errors";

describe("mapLocalSdErrorCode", () => {
  it.each([
    ["CUDA error: out of memory", LOCAL_SD_ERROR_CODES.outOfMemory],
    ["ggml_backend_alloc_buffer: failed to allocate buffer", LOCAL_SD_ERROR_CODES.outOfMemory],
    ["std::bad_alloc", LOCAL_SD_ERROR_CODES.outOfMemory],
    ["failed to load model from dream.safetensors", LOCAL_SD_ERROR_CODES.modelLoadFailed],
    ["GGUF model has an invalid header", LOCAL_SD_ERROR_CODES.modelLoadFailed],
    ["sd-cli process exited unexpectedly", LOCAL_SD_ERROR_CODES.engineUnavailable],
    ["connection refused while starting engine", LOCAL_SD_ERROR_CODES.engineUnavailable],
    ["an unfamiliar sampler error", LOCAL_SD_ERROR_CODES.unknown],
  ])("maps %s", (stderr, expected) => {
    expect(mapLocalSdErrorCode(stderr)).toBe(expected);
  });
});
