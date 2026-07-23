/** One consolidated feedback line — tone drives the text colour. */
export interface ProviderFeedback {
  text: string;
  tone: "success" | "error" | "muted";
}

export interface ProviderConnectionStatus {
  id: string;
  label: string;
  auth: string;
  configured: boolean;
  source: "environment" | "system-keychain" | "none";
  secret_store: string;
  keychain_status: "present" | "missing" | "unavailable";
}

export interface LocalRuntimeStatus {
  id: string;
  label: string;
  endpoint: string;
  status: string;
}

export interface ModelStoreStatus {
  id: string;
  label: string;
  path: string;
  available: boolean;
}

export interface StorageDirs {
  config: string;
  data: string;
  pglite: string;
  media: string;
  models: string;
  logs: string;
  runtime: string;
}

export interface DesktopRuntimeStatus {
  app: string;
  mode: string;
  local_first: boolean;
  platform: string;
  arch: string;
  version: string;
  profile_root: string;
  storage_dirs: StorageDirs;
  providers: ProviderConnectionStatus[];
  local_runtimes: LocalRuntimeStatus[];
  model_stores: ModelStoreStatus[];
}

export interface SavedProviderConnection {
  endpoint: string;
  /** Per-capability model ids — a provider can hold several at once. */
  models?: import("@/lib/byok-providers").ByokConnectionModels;
  capabilities?: string[];
  hasSecret: boolean;
  updatedAt: string;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type DesktopInvoke = TauriInvoke;

export type DesktopBridgePhase = "loading" | "ready" | "unavailable";

export interface ProviderView {
  id: string;
  label: string;
  auth: string;
  configured: boolean;
  meta: import("@/lib/byok-providers").ByokProviderMeta;
  source: string;
}
