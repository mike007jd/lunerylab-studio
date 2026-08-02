# Manual QA Guide

Human desktop QA cases. Run in Tauri.

## Select the run

| Change | Run |
| --- | --- |
| Any UI or behavior | QA-001–003 + affected conditionals |
| Image / provider | QA-001–005 + C-REF + C-IMG |
| Video | QA-001–004 + C-VID |
| Local models | QA-001–003 + C-LOC |
| Library / Projects | QA-001–003 + C-LIB |
| Canvas / Assistant | QA-001–003 + C-CAN (+ C-AST if affected) |
| Data / recovery | QA-001–003 + C-BAK + C-RST |
| Layout / i18n / a11y | QA-001–003 + C-UX |
| Package / release | QA-001–005 + C-PKG or C-REL + affected cases |

macOS Apple Silicon is the supported release target. Paid/BYOK calls need owner
approval.

## Prepare safely

Follow [Developer Setup](DEV_SETUP.md). From `my-app/`: install, create missing
`.env.local`, run `pnpm prisma:generate`, then `pnpm desktop:dev`. Close stale apps.

Use an isolated profile:

```bash
QA_PROFILE="$HOME/.lunerylab/studio-qa-<run-id>"
LUNERY_HOME="$QA_PROFILE" pnpm desktop:dev
```

For C-BAK, run once with `-source`, then `-target`; close App before switching.

Expected: `config/`, `data/pglite/`, `data/media/`, `models/`, `logs/`,
`runtime/`. Packaged apps use `~/.lunerylab/studio`; test only in a disposable
OS account. Use synthetic content/keys; remove test connections.

## Evidence and decisions

Record case/result, build, OS, window, profile, evidence. Pre, Act, Pass, Ev mean
precondition, action, result, evidence.

| Severity | Meaning |
| --- | --- |
| P0 | Launch/data loss, wrong model, corrupt restore, blocked primary flow |
| P1 | Broken feature/persistence or missing destructive confirmation |
| P2 | Non-blocking visual, copy, focus, or motion defect |

`N/A` needs owner/prerequisite and cannot replace a selected case. Smoke requires
all selected cases. Release requires no open P0/P1; accepted P2 needs an owner.

## Base and generation smoke

**QA-001 Launch/profile (P0)** — Pre: current process. Act: launch; open
Studio and Settings runtime; inspect profile.
Pass: surfaces load and all expected dirs share one root. Ev: window, path, PID.

**QA-002 Project lifecycle (P0)** — Pre: isolated profile. Act: in Projects,
create, rename, open, return. Pass: states differ; name persists. Ev: list
before/after and opened workspace.

**QA-003 No-model safety (P0)** — Pre: no runtime/BYOK. Act: try Generate and
refinement. Pass: disabled or setup guidance; no model appears selected.
Ev: blocked control and message.

**QA-004 Ready generation capability (P0)** — Pre: approved BYOK or C-LOC model.
Act: BYOK: enter endpoint/key/exact model, choose **Save locally**, Test, reload.
Local: start/select it. Pass: Ready, exact model visible, key masked.
Ev: status and post-reload selection.

**QA-005 Image/session/Library (P0)** — Pre: image Ready, unique project prompt.
Act: generate; preview; visit Library/return; quit/relaunch; reopen Library.
Pass: card survives route navigation; asset survives relaunch; Recent results
resets after relaunch by design. Ev: pre-quit card and post-relaunch asset.

## Conditional regression

**C-REF Reference image (P1)** — Pre: image Ready/project. Act: attach a
synthetic reference; generate; visit Library/return. Pass: accepted, card
shows reference count, assets remain in session. Ev: composer, card, Library.

**C-IMG Image cancel/retry (P1)** — Pre: slow run showing Cancel. Act:
generate; Cancel; check Library; Regenerate that card. Pass: Canceled, no canceled
asset, retry is new attempt. Ev: canceled card, Library, retry result.

**C-VID Video polling/continuity (P1)** — Pre: approved model/job.
Act: submit; confirm Running/no Cancel; visit Library and return; wait terminal.
Pass: same card continues and one result/failure appears. If Interrupted occurs
naturally, restore connectivity and Retry that card. Restart/resubmit is not
rejoin. No supported human action forces Interrupted. Ev: states/card count.

**C-LOC Local model lifecycle (P1)** — Pre: runtime/disk. Act: download a
small model or Advanced-import a file; watch queued/downloading/ready;
start/select, reload, remove with confirmation. Pass: states/readiness update;
managed download is deleted, external import only unregistered. Ev: row/messages.

**C-LIB Library/Trash (P1)** — Pre: unique-prompt asset. Act: search;
preview; Trash; Restore; Trash again; open Permanent delete, Cancel, then confirm.
Pass: search finds it; restore returns it; cancel preserves; confirm removes.
Ev: search and each Trash state.

**C-CAN Canvas lifecycle (P0)** — Pre: Library image in Canvas. Act: move/resize;
wait Saved; lock and try move/Delete; unlock; export Original and verify Library
and download; delete layer; reload. Pass: geometry/lock/export/delete persist.
Ev: Saved, lock attempt, outputs, reloaded Canvas.

**C-AST Assistant stop/edit/retry (P1)** — Pre: text Ready, unlocked layer. Act:
ask “Describe this canvas; do not edit” and Stop; ask “Move the image layer 20
pixels right” and wait Saved. For BYOK, disable network for a new description,
restore, Retry. Pass: Stop changes nothing; move persists; Retry
keeps thread/edit. Local retry may be approved `N/A`. Ev: thread and Canvas.

**C-BAK Backup/restore (P0)** — Pre: source/target paths; source project
`QA-BACKUP-<run-id>` with asset; invalid `.json` made in TextEdit. Act: back up;
close source; switch `QA_PROFILE`; launch target; select valid backup and Cancel;
select invalid; restore valid; restart. Pass: cancel no-ops; error appears; marker
returns. Ev: all target states.

**C-UX Locale/layout/a11y (P1)** — Act: at `1180×760` and `1440×980`, switch
all language options (`en`, `zh-CN`, `zh-TW`); keyboard-use primary controls;
enable OS Reduce Motion; relaunch. Pass: no clipping/overflow;
focus, translations, locale persistence, reduced motion. Ev: images/recording.

**C-RST Quit recovery (P0)** — Pre: isolated project/asset/Canvas. Act:
edit, wait Saved, quit/relaunch; edit, wait Saved, force-quit only QA process;
relaunch. Pass: project, asset, last Saved Canvas persist; Recent results may reset.
Ev: markers after both relaunches.

**C-PKG Unsigned local artifact (P0)** — Pre: disposable OS user; artifact
from `pnpm desktop:build:local` per [Operations](OPERATIONS.md). Act: open new
bundle; record path/version; QA-001–005. Pass: smoke passes; unsigned status is
not release proof. Ev: identity, build evidence, smoke.

**C-REL Published artifact (P0)** — Pre: disposable OS user; download/checksum
verified per Operations. Act: install/launch normally; QA-001–005.
Pass: version/checksum match and macOS Gatekeeper/notarization passes. Ev:
trust/smoke.

## Maintainer gates

From `my-app/`: `pnpm verify`, `pnpm build`, then `git diff --check`. Add
`pnpm desktop:check` for Tauri/bridge and `cargo test` in `src-tauri` for Rust.
These gates never replace selected human cases.

## Failure record

```text
Case | Result | Severity | Build/artifact | OS/window/profile
Steps | Expected | Actual | Evidence | Repro frequency
N/A owner and reason (only when allowed)
```
