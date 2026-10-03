import { useState } from "react";
import { FigmaRestIngestionSource } from "@/core/ingestion/adapters/figmaRestSource";
import { useGraphStore } from "@/state/graphStore";

const TOKEN_KEY = "figma-resolve.pat";
const FILE_KEY = "figma-resolve.file";

const readStored = (key: string) => {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

const writeStored = (key: string, value: string) => {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Private mode — form still works for this session.
  }
};

/**
 * Human path for live ingest. Agents use the CLI:
 * `FIGMA_ACCESS_TOKEN=… npm run resolve -- ingest <figma-url>`
 *
 * Token stays in sessionStorage, never in the graph JSON.
 */
export function FigmaRestButton({
  open: openControlled,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const loadSource = useGraphStore((state) => state.loadSource);
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = openControlled !== undefined;
  const open = controlled ? openControlled : internalOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [fileInput, setFileInput] = useState(() => readStored(FILE_KEY));
  const [token, setToken] = useState(() => readStored(TOKEN_KEY));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    writeStored(FILE_KEY, fileInput.trim());
    writeStored(TOKEN_KEY, token.trim());
    setBusy(true);
    try {
      await loadSource(new FigmaRestIngestionSource(fileInput, token.trim()));
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Load Figma
      </button>
      {open && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Load Figma file">
          <form
            className="modal__panel modal__panel--narrow"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <header className="modal__header">
              <h2>Load from Figma REST</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </header>
            <p className="modal__hint">
              Paste a screen, frame, or section link. Whole-file URLs map each top-level
              screen separately.
            </p>
            <div className="modal__controls modal__controls--stack">
              <label>
                File URL or key
                <input
                  value={fileInput}
                  onChange={(event) => setFileInput(event.target.value)}
                  placeholder="https://www.figma.com/design/…?node-id=…"
                  autoComplete="off"
                  required
                />
              </label>
              <label>
                Personal access token
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="figd_…"
                  autoComplete="off"
                  required
                />
              </label>
            </div>
            <p className="modal__hint">
              Token stays in this tab (sessionStorage). Proxied to api.figma.com — not written into
              the graph.
            </p>
            {error && <p className="modal__hint modal__hint--error">{error}</p>}
            <footer className="modal__footer">
              <button type="submit" disabled={busy || !fileInput.trim() || !token.trim()}>
                {busy ? "Ingesting…" : "Ingest"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
