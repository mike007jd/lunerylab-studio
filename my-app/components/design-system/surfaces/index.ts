export const lunaSurfaces = {
  studio: {
    owner: "components/studio",
    route: "/studio",
    role: "primary creative production surface",
  },
  canvas: {
    owner: "components/canvas",
    route: "/canvas/[sessionId]",
    role: "artifact editing and visual context surface",
  },
  settings: {
    owner: "components/settings",
    route: "/settings",
    role: "local runtime, provider, and model management surface",
  },
  library: {
    owner: "components/library",
    route: "/library",
    role: "generated asset browsing surface",
  },
} as const;

export type LunaSurfaceId = keyof typeof lunaSurfaces;
