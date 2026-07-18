import type { ContentOrigin } from "@/lib/types/api";

export interface LibrarySearchCounts {
  all: number;
  generated: number;
  reference: number;
  template: number;
  output: number;
  trash: number;
}

export const EMPTY_LIBRARY_SEARCH_COUNTS: LibrarySearchCounts = {
  all: 0,
  generated: 0,
  reference: 0,
  template: 0,
  output: 0,
  trash: 0,
};

interface LibraryAssetCountGroup {
  kind: "REFERENCE" | "GENERATED";
  modality: "IMAGE" | "VIDEO" | "MODEL_3D";
  origin: ContentOrigin;
  _count: { _all: number };
}

export function summarizeLibraryAssetCountGroups(
  groups: readonly LibraryAssetCountGroup[],
  trash = 0,
): LibrarySearchCounts {
  let generated = 0;
  let reference = 0;
  let template = 0;
  let output = 0;

  for (const group of groups) {
    if (group.origin === "TEMPLATE") {
      template += group._count._all;
      continue;
    }
    if (group.kind === "GENERATED") generated += group._count._all;
    if (group.kind === "REFERENCE") reference += group._count._all;
    if (group.modality === "VIDEO") output += group._count._all;
  }

  return {
    all: generated + reference + template,
    generated,
    reference,
    template,
    output,
    trash,
  };
}
