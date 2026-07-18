export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

export interface GenerateImageInput {
  /** Correlates one Studio request with native sd-cli progress and cancel. */
  runId?: string;
  prompt: string;
  modelId?: string;
  count: number;
  aspectRatio?: string;
  references?: Buffer[];
  isEdit?: boolean;
  /**
   * Caller cancel signal (user "Stop" / request abort). Threaded into the
   * provider request so a stop actually interrupts the in-flight call instead of
   * leaving it running (and billing) until the provider timeout.
   */
  abortSignal?: AbortSignal;
}

export interface GenerateImageResult {
  provider: string;
  model: string;
  /**
   * Concrete runtime endpoint actually used (e.g. a local ComfyUI URL), when the
   * backend has one. Persisted as job provenance so we can prove which backend
   * served a request. Undefined for embedded/BYOK backends without a URL.
   */
  endpoint?: string;
  images: GeneratedImage[];
  warnings: string[];
}
