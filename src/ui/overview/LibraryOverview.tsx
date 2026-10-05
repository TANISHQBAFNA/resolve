import { useState } from "react";
import { useGraphStore } from "@/state/graphStore";
import { HealthChip } from "./Stat";
import { libraryHealth } from "./health";

export const AGENT_HAPPY_PATH =
  'recipe "<job>" → recommend unbound slots → Figma on those figmaNodeIds → verify_frame. Do not Read graph.json.';

function copyButtonLabel(copied: boolean): string {
  return copied ? "Copied path" : "Copy agent path";
}
function copyText(value: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    if (ok) return true;
  } catch {
    // Fall through to clipboard API.
  }
  void navigator.clipboard?.writeText(value);
  return typeof navigator.clipboard?.writeText === "function";
}

export function LibraryOverview() {
  const graph = useGraphStore((state) => state.graph);
  const analytics = useGraphStore((state) => state.analytics);
  const [copied, setCopied] = useState(false);

  if (!graph || !analytics) return null;

  const health = libraryHealth(analytics);

  const copyHint = () => {
    copyText(AGENT_HAPPY_PATH);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const copyLabel = copyButtonLabel(copied);

  return (
    <section className="overview" aria-label="Library overview">
      <div className="overview__identity">
        <p className="overview__kicker">Loaded library</p>
        <h2 className="overview__title">{graph.fileName}</h2>
        <p className="overview__meta">{graph.source.kind}</p>
      </div>

      <div className="overview__health">
        <HealthChip tone={health.tone} label={health.label} />
        <p>{health.detail}</p>
      </div>

      <div className="overview__actions">
        <button type="button" className="button--ghost" onClick={copyHint}>
          {copyLabel}
        </button>
        <p className="overview__hint" role="status">
          {copied ? "Copied. " : ""}
          {AGENT_HAPPY_PATH}
        </p>
      </div>
    </section>
  );
}
