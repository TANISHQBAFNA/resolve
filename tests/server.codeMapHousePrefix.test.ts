import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapReport } from "@/server/code/map";
import { buildCatalog } from "@/server/code/scan";
import type { ResolveConfig } from "@/server/mode";

function setup(names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "resolve-house-"));
  const store = join(root, "store");
  mkdirSync(store, { recursive: true });
  for (const name of names) {
    mkdirSync(join(root, "building-blocks", name), { recursive: true });
    writeFileSync(join(root, "building-blocks", name, `${name}.css`), `.${name} { color: var(--ink); }\n`);
  }
  const cfg: ResolveConfig = { mode: "both", modeSource: "env", repoPath: root, localPrefixes: [], storeDir: store };
  return { cfg, catalog: buildCatalog(cfg) };
}

describe("a house prefix shared by most names is not a reason to pair", () => {

  it("keeps a real shared word that only a few names carry", () => {
    const { cfg, catalog } = setup(["acme-date-field", "acme-badge", "acme-card", "acme-chip"]);
    const masters = ["Acme Date Note", "Acme Badge", "Acme Card", "Acme Chip"].map((name, i) => ({ name, nodeId: `2:${i + 1}` }));
    const report = mapReport(catalog, cfg, { suggest: true, limit: 25, masters });
    expect(report.suggestions?.some((row) => row.figma === "Acme Date Note" && row.code === "acme-date-field")).toBe(true);
    expect(report.suggestions?.some((row) => row.figma === "Acme Date Note" && row.code === "acme-card")).toBe(false);
  });
});
