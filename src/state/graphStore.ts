import { create } from "zustand";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import type { IngestionSource } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import {
  computeAnalytics,
  defaultFilterState,
  indexGraph,
  type FilterState,
  type GraphAnalytics,
  type GraphIndex,
  type GraphLevel,
  type ViewMode,
} from "@/core/query";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** `explorer` is the focused, level-based view. `atlas` is the whole file. `rules` is the bind-rule / why page. */
export type ViewSurface = "explorer" | "atlas" | "rules";

export interface AtlasSettings {
  /** Fold instances onto their main component so each component is one node. */
  collapseInstances: boolean;
  /** Louvain resolution. Higher = more, smaller communities. */
  resolution: number;
  /** Keep god nodes out of the partitioning pass. */
  excludeHubs: boolean;
  /** Community ids the user has switched off. */
  hiddenCommunities: number[];
  /** Drop leaf nodes below this degree. */
  minDegree: number;
}

interface GraphState {
  status: LoadStatus;
  error?: string;
  sourceLabel?: string;
  graph?: DesignGraph;
  index?: GraphIndex;
  analytics?: GraphAnalytics;

  focusId?: string;
  selectedIds: string[];
  expandedIds: string[];
  viewMode: ViewMode;
  /** "auto" derives the level from the focus node's type. */
  level: GraphLevel | "auto";
  filters: FilterState;
  query: string;
  past: string[];
  future: string[];
  mode: ViewSurface;
  atlas: AtlasSettings;

  loadSource: (source: IngestionSource) => Promise<void>;
  focusNode: (id: string, options?: { select?: boolean }) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  toggleExpanded: (id: string) => void;
  collapseAll: () => void;
  setViewMode: (viewMode: ViewMode) => void;
  setLevel: (level: GraphLevel | "auto") => void;
  setQuery: (query: string) => void;
  setFilters: (patch: Partial<FilterState>) => void;
  toggleNodeTypeFilter: (type: NodeType) => void;
  resetFilters: () => void;
  goBack: () => void;
  goForward: () => void;
  setMode: (mode: ViewSurface) => void;
  setAtlas: (patch: Partial<AtlasSettings>) => void;
  toggleCommunity: (id: number) => void;
  setAllCommunities: (ids: number[], visible: boolean) => void;
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  status: "idle",
  selectedIds: [],
  expandedIds: [],
  viewMode: "hierarchy",
  level: "auto",
  filters: defaultFilterState(),
  query: "",
  past: [],
  future: [],
  mode: "atlas",
  atlas: {
    collapseInstances: true,
    resolution: 1,
    excludeHubs: false,
    hiddenCommunities: [],
    minDegree: 0,
  },

  async loadSource(source) {
    set({ status: "loading", error: undefined, sourceLabel: source.label });
    try {
      const document = await source.load();
      const graph = buildGraph(document);
      const index = indexGraph(graph);
      const analytics = computeAnalytics(index);
      const fileNode = index.getFileNode();
      set({
        status: "ready",
        graph,
        index,
        analytics,
        focusId: fileNode?.id,
        selectedIds: fileNode ? [fileNode.id] : [],
        expandedIds: [],
        past: [],
        future: [],
        query: "",
        filters: defaultFilterState(),
        level: "auto",
        atlas: { ...get().atlas, hiddenCommunities: [] },
      });
    } catch (error) {
      set({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  },

  focusNode(id, options) {
    const { focusId, past } = get();
    if (focusId === id) {
      if (options?.select !== false) set({ selectedIds: [id] });
      return;
    }
    set({
      focusId: id,
      past: focusId ? [...past, focusId].slice(-50) : past,
      future: [],
      selectedIds: options?.select === false ? get().selectedIds : [id],
      level: "auto",
    });
  },

  toggleSelected(id) {
    const { selectedIds } = get();
    set({
      selectedIds: selectedIds.includes(id)
        ? selectedIds.filter((candidate) => candidate !== id)
        : [...selectedIds, id],
    });
  },

  clearSelection() {
    const { focusId } = get();
    set({ selectedIds: focusId ? [focusId] : [] });
  },

  toggleExpanded(id) {
    const { expandedIds } = get();
    set({
      expandedIds: expandedIds.includes(id)
        ? expandedIds.filter((candidate) => candidate !== id)
        : [...expandedIds, id],
    });
  },

  collapseAll() {
    set({ expandedIds: [] });
  },

  setViewMode(viewMode) {
    set({ viewMode });
  },
  setLevel(level) {
    set({ level });
  },
  setQuery(query) {
    set({ query });
  },
  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },
  toggleNodeTypeFilter(type) {
    const { filters } = get();
    const nodeTypes = filters.nodeTypes.includes(type)
      ? filters.nodeTypes.filter((candidate) => candidate !== type)
      : [...filters.nodeTypes, type];
    set({ filters: { ...filters, nodeTypes } });
  },
  resetFilters() {
    set({ filters: defaultFilterState(), query: "" });
  },

  goBack() {
    const { past, future, focusId } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({
      focusId: previous,
      selectedIds: [previous],
      past: past.slice(0, -1),
      future: focusId ? [focusId, ...future] : future,
      level: "auto",
    });
  },

  goForward() {
    const { past, future, focusId } = get();
    const next = future[0];
    if (!next) return;
    set({
      focusId: next,
      selectedIds: [next],
      past: focusId ? [...past, focusId] : past,
      future: future.slice(1),
      level: "auto",
    });
  },

  setMode(mode) {
    set({ mode });
  },

  setAtlas(patch) {
    const atlas = { ...get().atlas, ...patch };
    // Community ids are only stable for a given partition, so any setting that
    // changes the partition clears the visibility selection.
    if (patch.resolution !== undefined || patch.excludeHubs !== undefined || patch.collapseInstances !== undefined) {
      atlas.hiddenCommunities = [];
    }
    set({ atlas });
  },

  toggleCommunity(id) {
    const { atlas } = get();
    const hiddenCommunities = atlas.hiddenCommunities.includes(id)
      ? atlas.hiddenCommunities.filter((candidate) => candidate !== id)
      : [...atlas.hiddenCommunities, id];
    set({ atlas: { ...atlas, hiddenCommunities } });
  },

  setAllCommunities(ids, visible) {
    const { atlas } = get();
    set({ atlas: { ...atlas, hiddenCommunities: visible ? [] : [...ids] } });
  },
}));

/** Convenience selector: the currently focused node, if any. */
export function useFocusNode(): GraphNode | undefined {
  return useGraphStore((state) => (state.focusId ? state.index?.getNode(state.focusId) : undefined));
}
