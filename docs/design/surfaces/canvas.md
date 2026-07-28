# Canvas Surface Contract

| Owner | Route | Job |
| --- | --- | --- |
| `my-app/components/canvas` | `/canvas/[sessionId]` | Inspect, arrange, mask, and refine assets. |

Required states: empty session, selected asset, pending edit, missing capability,
ready result, and recoverable error.

- Keep toolbars and panels geometrically stable.
- Isolate justified Konva drawing values inside the Canvas surface.
- Offer assistant handoff only when it advances the edit; model management stays
  in Settings.
