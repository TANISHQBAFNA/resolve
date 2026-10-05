import { ImportButton } from "@/ui/panels/ImportButton";

export type WorkspaceKind = "empty" | "loading" | "error";

export function WorkspaceState({
  kind,
  error,
  onIngest,
}: {
  kind: WorkspaceKind;
  error?: string;
  onIngest: () => void;
}) {
  switch (kind) {
    case "loading":
      return (
        <div className="workspace-state" role="status">
          <div className="workspace-state__card">
            <div className="workspace-state__pulse" aria-hidden="true" />
            <h2>Building graph…</h2>
            <p>Indexing frames, components, and usage so Overview can show health at a glance.</p>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="workspace-state" role="alert">
          <div className="workspace-state__card">
            <p className="workspace-state__kicker workspace-state__kicker--danger">Could not load</p>
            <h2>Library did not ingest</h2>
            <p className="workspace-state__error">{error ?? "Unknown error"}</p>
            <div className="workspace-state__actions">
              <button type="button" className="button--primary" onClick={onIngest}>
                Load Figma
              </button>
              <ImportButton />
            </div>
          </div>
        </div>
      );
    case "empty":
      return (
        <div className="workspace-state">
          <div className="workspace-state__card">
            <span className="workspace-state__mark" aria-hidden="true">
              ◈
            </span>
            <p className="workspace-state__kicker">Resolve</p>
            <h2>No library loaded</h2>
            <p>
              Ingest a Figma file to see health and counts. Then agents follow recipe →
              recommend → verify_frame — they never read graph.json.
            </p>
            <div className="workspace-state__actions">
              <button type="button" className="button--primary" onClick={onIngest}>
                Load Figma
              </button>
              <ImportButton />
            </div>
            <p className="workspace-state__cli">
              CLI: <code>npm run resolve -- ingest '&lt;figma-url&gt;'</code>
            </p>
          </div>
        </div>
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
