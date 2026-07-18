/**
 * Single source of truth for the console content frame — the max-width + the
 * horizontal/vertical rhythm that wraps every routed page under the AppShell.
 *
 * Both the live shell (app-shell.tsx) and the route-level loading skeleton
 * (app/(console)/loading.tsx) consume these so the loaded and loading states
 * line up to the pixel and the width can never silently drift between the two.
 */

/** Outer scroll scope: owns the horizontal/vertical padding around the frame.
 *  A flex column so the inner frame can grow to fill the console height, which
 *  lets short pages own the full canvas instead of a thin top band + void. */
export const CONSOLE_CONTENT_SCOPE_CLASS =
  "flex min-w-0 flex-1 flex-col overflow-x-hidden px-4 py-4 lg:px-6 lg:py-5";

/** Inner frame: centers content horizontally, caps it at the shared reading
 *  width, and grows to fill the scope height (flex-1) so routed pages get the
 *  full vertical canvas. Width comes from the `--content-max-w` token
 *  (globals.css) so the cap is a semantic value, not an arbitrary bracket
 *  utility (framework files allow no raw visual values). */
export const CONSOLE_CONTENT_FRAME_CLASS =
  "mx-auto flex min-w-0 w-full max-w-(--content-max-w) flex-1 flex-col";
