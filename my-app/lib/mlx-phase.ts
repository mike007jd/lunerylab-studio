/**
 * Shared MLX first-start phase vocabulary. The Rust side (`parse_mlx_line`)
 * is the producer; `/mlx-status` and `/status` surface it; the settings UIs
 * consume it. Kept in one place so a rename can't silently break a UI branch.
 */
// Five phases: "starting" (async bind ack), "downloading", "loading", "ready",
// and a terminal "error" (bind/download failure). Consumers must handle all five.
export type MlxPhase = "starting" | "downloading" | "loading" | "ready" | "error";

/** `<label> 42%` while a percent is known, `<label>…` otherwise. */
export function formatMlxPhase(label: string, percent: number | null | undefined): string {
  return percent !== null && percent !== undefined ? `${label} ${percent}%` : `${label}…`;
}
