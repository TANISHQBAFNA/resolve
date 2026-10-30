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
  it("does not suggest every Acme component for every other one", () => {
    const { cfg, catalog } = setup(["acme-avatar", "acme-badge", "acme-banner", "acme-card", "acme-chip", "acme-slider"]);
    const masters = ["Acme Avatar", "Acme Badge", "Acme Banner", "Acme Card", "Acme Chip", "Acme Slider"].map((name, i) => ({ name, nodeId: `1:${i + 1}` }));
    const report = mapReport(catalog, cfg, { suggest: true, limit: 25, masters });
    const rows = (report.suggestions ?? []).map((row) => `${row.figma}=${row.code}:${row.reasons.join(";")}`);
    expect(rows.filter((row) => row.endsWith(":same words"))).toEqual([]);
    for (const name of ["avatar", "badge", "banner", "card", "chip", "slider"]) {
      const figma = `Acme ${name[0]!.toUpperCase()}${name.slice(1)}`;
      expect(report.suggestions?.find((row) => row.figma === figma && row.code === `acme-${name}`)?.confidence).toBe("risky: same name only");
    }
    expect(rows).toContain("Acme Badge=acme-chip:badg~chip");
  });

  it("keeps a real shared word that only a few names carry", () => {
    const { cfg, catalog } = setup(["acme-date-field", "acme-badge", "acme-card", "acme-chip"]);
    const masters = ["Acme Date Note", "Acme Badge", "Acme Card", "Acme Chip"].map((name, i) => ({ name, nodeId: `2:${i + 1}` }));
    const report = mapReport(catalog, cfg, { suggest: true, limit: 25, masters });
    expect(report.suggestions?.some((row) => row.figma === "Acme Date Note" && row.code === "acme-date-field")).toBe(true);
    expect(report.suggestions?.some((row) => row.figma === "Acme Date Note" && row.code === "acme-card")).toBe(false);
  });
});
