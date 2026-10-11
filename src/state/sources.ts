import type { IngestionSource } from "@/core/ingestion/types";
import { mockIngestionSource } from "@/core/ingestion/adapters/mockSource";

const EXAMPLE_SOURCE_IDS = new Set([
  "mock:demo-pay",
  "mcp:demo-mobile-screens",
  "mcp:demo-mobile-portfolio",
]);

/** True for the shipped fixtures. A Figma REST load and an imported file are not examples. */
export function isExampleSource(id: string): boolean {
  return EXAMPLE_SOURCE_IDS.has(id);
}

function exampleLabel(label: string): string {
  return label.startsWith("Example") ? label : `Example — ${label}`;
}

/** Shown in the picker. Heavy MCP captures load only when selected. */
export const SOURCE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: mockIngestionSource.id, label: exampleLabel(mockIngestionSource.label) },
  { id: "mcp:demo-mobile-screens", label: exampleLabel("Demo — 2 screens combined (Figma MCP)") },
  { id: "mcp:demo-mobile-portfolio", label: exampleLabel("Demo — Portfolio screen (Figma MCP)") },
];

export const DEFAULT_SOURCE = mockIngestionSource;

export async function resolveSource(id: string): Promise<IngestionSource> {
  if (id === mockIngestionSource.id) return mockIngestionSource;
  const { demoPortfolioSource, demoScreensSource } = await import(
    "@/core/ingestion/adapters/mcpSource"
  );
  if (id === demoScreensSource.id) return demoScreensSource;
  if (id === demoPortfolioSource.id) return demoPortfolioSource;
  throw new Error(`Unknown source: ${id}`);
}
