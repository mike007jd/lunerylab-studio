# Documentation

Repository-authored engineering and design documentation is concise English.
Code, lockfiles, and workflows remain the authority for executable details.
`pnpm docs:check` rejects CJK text, broken local links, broken agent imports, or
files over 180 lines / 1,000 words; legal notices are exempt from the size cap.

| Need | Document |
| --- | --- |
| Fresh setup and verification | [DEV_SETUP.md](DEV_SETUP.md) |
| Manual desktop QA | [QA_MANUAL.md](QA_MANUAL.md) |
| System and path map | [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) |
| Implemented features | [features/README.md](features/README.md) |
| Release and cleanup | [OPERATIONS.md](OPERATIONS.md) |
| Dependency overrides | [PNPM_OVERRIDES.md](PNPM_OVERRIDES.md) |
| Surface contracts | [design/surfaces](design/surfaces) |
| Architecture decisions | [adr](adr) |
| Hygiene and SDK boundaries | [hygiene](hygiene) |
| Product and engineering rules | [`../spec`](../spec) |

Rules belong in `/spec`, durable decisions in `/docs/adr`, and execution
guidance in `/docs`. Link to the owner instead of copying it.
