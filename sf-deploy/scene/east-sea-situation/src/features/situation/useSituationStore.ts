import { create } from "zustand";
import { targets } from "./data/mockSituation";
import type { TargetKind } from "./types";

interface SituationState {
  activeKinds: TargetKind[];
  query: string;
  selectedTargetId: string;
  playbackIndex: number;
  setQuery: (query: string) => void;
  setSelectedTargetId: (targetId: string) => void;
  toggleKind: (kind: TargetKind) => void;
  advancePlayback: () => void;
}

export const useSituationStore = create<SituationState>((set) => ({
  activeKinds: ["air", "surface", "facility"],
  query: "",
  selectedTargetId: "T-B12",
  playbackIndex: 0,
  setQuery: (query) => set({ query }),
  setSelectedTargetId: (targetId) => set({ selectedTargetId: targetId }),
  toggleKind: (kind) =>
    set((state) => {
      const exists = state.activeKinds.includes(kind);
      const nextKinds = exists
        ? state.activeKinds.filter((item) => item !== kind)
        : [...state.activeKinds, kind];

      return { activeKinds: nextKinds.length > 0 ? nextKinds : state.activeKinds };
    }),
  advancePlayback: () =>
    set((state) => ({ playbackIndex: (state.playbackIndex + 1) % 4 })),
}));

export function getVisibleTargets(activeKinds: TargetKind[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  return targets.filter((target) => {
    const matchesKind = activeKinds.includes(target.kind);
    const matchesQuery =
      normalizedQuery.length === 0 ||
      target.name.toLowerCase().includes(normalizedQuery) ||
      target.code.toLowerCase().includes(normalizedQuery);

    return matchesKind && matchesQuery;
  });
}

