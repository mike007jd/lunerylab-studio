# Library And Projects Surface Contract

| Owner | Routes | Job |
| --- | --- | --- |
| `my-app/components/library` | `/library`, `/projects`, `/projects/[id]` | Find, group, preview, and reopen work. |

Required states: loading, empty, no search results, asset preview, project
workspace, and unavailable or deleted asset.

- Keep thumbnails dominant and metadata compact.
- Add filters only when data volume needs them.
- Make Studio and Canvas handoff direct.
- Do not turn this surface into an analytics dashboard.
