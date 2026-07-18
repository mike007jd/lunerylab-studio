export const LOCAL_SD_ERROR_CODES = {
  outOfMemory: "local_sd_out_of_memory",
  modelLoadFailed: "local_sd_model_load_failed",
  engineUnavailable: "local_sd_engine_unavailable",
  unknown: "local_sd_unknown",
} as const;

export type LocalSdErrorCode = (typeof LOCAL_SD_ERROR_CODES)[keyof typeof LOCAL_SD_ERROR_CODES];

const ERROR_PATTERNS: ReadonlyArray<{ code: LocalSdErrorCode; patterns: RegExp[] }> = [
  {
    code: LOCAL_SD_ERROR_CODES.outOfMemory,
    patterns: [
      /\bout of (?:memory|vram)\b/i,
      /\b(?:cannot|failed to) allocate (?:memory|buffer|tensor)\b/i,
      /\b(?:std::)?bad_alloc\b/i,
      /\bggml(?:_[a-z]+)*_alloc\b.*\b(?:failed|null|error)\b/i,
      /\b(?:cuda|metal|mps)\b.*\b(?:out of memory|allocation failed)\b/i,
    ],
  },
  {
    code: LOCAL_SD_ERROR_CODES.modelLoadFailed,
    patterns: [
      /\b(?:failed|unable) to (?:load|read|open)\b.*\b(?:model|checkpoint|tensor|gguf|safetensors)\b/i,
      /\b(?:model|checkpoint|gguf|safetensors)\b.*\b(?:corrupt|invalid|truncated|unexpected eof)\b/i,
      /\binvalid (?:magic|header)\b/i,
      /\btensor\b.*\b(?:shape mismatch|invalid|corrupt)\b/i,
      /\b(?:enoent|no such file)\b/i,
    ],
  },
  {
    code: LOCAL_SD_ERROR_CODES.engineUnavailable,
    patterns: [
      /\b(?:engine|sd-cli|process)\b.*\b(?:not running|unavailable|crash(?:ed)?|terminated|exited|not found)\b/i,
      /\b(?:connection refused|failed to connect|unreachable|broken pipe)\b/i,
      /\b(?:segmentation fault|abort trap)\b/i,
      /\b(?:killed|terminated) by signal\b/i,
    ],
  },
];

export function mapLocalSdErrorCode(rawError: string): LocalSdErrorCode {
  for (const entry of ERROR_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(rawError))) return entry.code;
  }
  return LOCAL_SD_ERROR_CODES.unknown;
}
