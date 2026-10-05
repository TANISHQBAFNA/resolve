import { useEffect, useState } from "react";
import { DEFAULT_SOURCE, SOURCE_OPTIONS, resolveSource } from "@/state/sources";
import { useGraphStore, type LoadStatus } from "@/state/graphStore";
import packagedRecipes from "@/data/recipes.json";
import { ImportButton } from "@/ui/panels/ImportButton";
import { FigmaRestButton } from "@/ui/panels/FigmaRestButton";
import { LibraryOverview } from "@/ui/overview/LibraryOverview";
import { WorkspaceState } from "@/ui/overview/WorkspaceState";
import { HealthChip, Stat } from "@/ui/overview/Stat";
import { libraryHealth } from "@/ui/overview/health";
import { RulesPage } from "@/ui/governance/RulesPage";
import { ScoreboardSection } from "@/ui/governance/ScoreboardSection";
import type { ViewSurface } from "@/state/graphStore";

const RECIPE_COUNT = Array.isArray(packagedRecipes.recipes) ? packagedRecipes.recipes.length : 0;

export function App() {
  const status = useGraphStore((state) => state.status);
  const error = useGraphStore((state) => state.error);
  const graph = useGraphStore((state) => state.graph);
  const analytics = useGraphStore((state) => state.analytics);
  const loadSource = useGraphStore((state) => state.loadSource);
  const mode = useGraphStore((state) => state.mode);
  const setMode = useGraphStore((state) => state.setMode);
  const [showWarnings, setShowWarnings] = useState(false);
  const [sourceId, setSourceId] = useState(DEFAULT_SOURCE.id);
  const [loadFigmaOpen, setLoadFigmaOpen] = useState(false);

  useEffect(() => {
    void loadSource(DEFAULT_SOURCE);
  }, [loadSource]);

  const health = analytics ? libraryHealth(analytics) : undefined;

  return (
    <div className="app">
      <header className="app__bar">
        <div className="app__brand">
          <span className="app__logo" aria-hidden="true">
            ◈
          </span>
          <div>
            <h1>Resolve</h1>
            <p>{graph ? graph.fileName : "Figma rules. Agents resolve."}</p>
          </div>
        </div>

        <div className="app__modes" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "library"}
            className={mode === "library" ? "is-active" : ""}
            onClick={() => setMode("library")}
          >
            Library
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "rules"}
            className={mode === "rules" ? "is-active" : ""}
            onClick={() => setMode("rules")}
          >
            Rules
          </button>
        </div>

        <label className="app__source-picker">
          <span className="visually-hidden">Data source</span>
          <select
            value={sourceId}
            onChange={(event) => {
              const id = event.target.value;
              setSourceId(id);
              void resolveSource(id).then(loadSource);
            }}
          >
            {SOURCE_OPTIONS.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </label>

        {graph && analytics && health && (
          <div className="app__stats" aria-label="Library counts">
            <Stat value={analytics.totals.frames} label="Frames" />
            <Stat value={analytics.totals.componentDefinitions} label="Components" />
            <Stat value={analytics.totals.instances} label="Instances" />
            <Stat value={RECIPE_COUNT} label="Recipes" />
            <HealthChip tone={health.tone} label={health.label} />
            <span className="app__source">source: {graph.source.kind}</span>
          </div>
        )}

        <div className="app__bar-right">
          <FigmaRestButton open={loadFigmaOpen} onOpenChange={setLoadFigmaOpen} />
          <ImportButton />
          {graph && graph.warnings.length > 0 && (
            <button
              type="button"
              className="app__warnings"
              onClick={() => setShowWarnings((value) => !value)}
            >
              {graph.warnings.length} data warnings
            </button>
          )}
        </div>
      </header>

      {showWarnings && graph && (
        <div className="app__warning-list">
          <ul>
            {graph.warnings.map((warning, i) => (
              <li key={`${warning.code}-${i}`}>
                <code>{warning.code}</code> {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {renderWorkspace(status, error, () => setLoadFigmaOpen(true), mode)}
    </div>
  );
}

function renderWorkspace(
  status: LoadStatus,
  error: string | undefined,
  onIngest: () => void,
  mode: ViewSurface,
) {
  if (mode === "rules") {
    return <RulesPage />;
  }
  switch (status) {
    case "idle":
      return <WorkspaceState kind="empty" onIngest={onIngest} />;
    case "loading":
      return <WorkspaceState kind="loading" onIngest={onIngest} />;
    case "error":
      return <WorkspaceState kind="error" error={error} onIngest={onIngest} />;
    case "ready":
      return (
        <div className="app__body">
          <main className="app__center">
            <LibraryOverview />
            <ScoreboardSection compact />
          </main>
        </div>
      );
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
