import type { GraphAnalytics } from "@/core/query/analytics";

export type HealthTone = "ok" | "watch" | "risk";

export interface LibraryHealth {
  tone: HealthTone;
  label: string;
  detail: string;
  unusedComponents: number;
  unresolvedInstances: number;
  framesWithoutComponents: number;
}

export function libraryHealth(analytics: GraphAnalytics): LibraryHealth {
  const unusedComponents = analytics.unusedComponents.length;
  const unresolvedInstances = analytics.unresolvedInstances.length;
  const framesWithoutComponents = analytics.framesWithoutComponents.length;
  const parts: string[] = [];
  if (unusedComponents) parts.push(`${unusedComponents} unused`);
  if (unresolvedInstances) parts.push(`${unresolvedInstances} unresolved`);
  if (framesWithoutComponents) parts.push(`${framesWithoutComponents} empty frames`);

  if (unresolvedInstances > 0) {
    return {
      tone: "risk",
      label: "Invent risk",
      detail: parts.join(" · "),
      unusedComponents,
      unresolvedInstances,
      framesWithoutComponents,
    };
  }
  if (unusedComponents > 0 || framesWithoutComponents > 0) {
    return {
      tone: "watch",
      label: "Watch",
      detail: parts.join(" · "),
      unusedComponents,
      unresolvedInstances,
      framesWithoutComponents,
    };
  }
  return {
    tone: "ok",
    label: "Healthy",
    detail: "Components resolve. Nothing unused in this file.",
    unusedComponents,
    unresolvedInstances,
    framesWithoutComponents,
  };
}

export function communityCohesion(
  size: number,
  internalEdges: number,
): { label: string; tone: HealthTone } {
  if (size <= 0) return { label: "Empty", tone: "watch" };
  const ratio = internalEdges / size;
  if (ratio >= 1.1) return { label: "Tight", tone: "ok" };
  if (ratio >= 0.35) return { label: "Linked", tone: "watch" };
  return { label: "Loose", tone: "watch" };
}
