import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion";
import { mapReport } from "@/server/code/map";
import { buildCatalog } from "@/server/code/scan";
import { graphMasters } from "@/server/graphMasters";
import { learnLibrary } from "@/server/learn";
import type { ResolveConfig } from "@/server/mode";
import { clearCache } from "@/server/store";

const KIT = `
<frame id="1:1" name="Kit">
  <component-set id="2:1" name="Acme Button">
    <component id="2:11" name="Kind=Primary, Size=Large" />
  </component-set>
  <frame id="2:5" name="Acme Banner">
    <symbol id="2:51" name="Tone=Promo" />
  </frame>
  <component id="2:2" name="Acme Badge" />
</frame>`;

const saved = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
afterEach(() => {
  for (const [key, value] of [["RESOLVE_HOME", saved.home], ["RESOLVE_MODE", saved.mode]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearCache();
});

describe("get_metadata learn keeps variant names", () => {
  it("reads Prop=Value names inside a set as variant properties, like REST", () => {
    const doc = adaptFigmaMcpMetadata({ fileKey: "ACMEKIT", fileName: "Acme Kit", metadataXml: KIT });
    const nodes = JSON.stringify(doc);
    expect(nodes).toContain('"variantProperties":{"Kind":"Primary","Size":"Large"}');
    expect(nodes).toContain('"variantProperties":{"Tone":"Promo"}');
  });

  it("does not read a loose component with = in its name as a variant", () => {
    const doc = adaptFigmaMcpMetadata({ fileKey: "ACMEKIT", fileName: "Acme Kit", metadataXml: `<frame id="1:1" name="Kit"><component id="3:1" name="Ratio=Wide" /><component id="3:2" name="Acme Card" /></frame>` });
    expect(JSON.stringify(doc)).not.toContain("variantProperties");
  });

  it("lets a metadata-learned set join its coded twin on a shared variant", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-meta-variants-"));
    const store = join(root, ".resolve");
    mkdirSync(store, { recursive: true });
    for (const [name, body] of [
      ["acme-button", ".acme-button { color: var(--ink); }\n.acme-button--primary { color: var(--ink); }\n"],
      ["acme-banner", ".acme-banner { color: var(--ink); }\n.acme-banner--promo { color: var(--ink); }\n"],
      ["acme-badge", ".acme-badge { color: var(--ink); }\n"],
    ]) {
      mkdirSync(join(root, "building-blocks", name), { recursive: true });
      writeFileSync(join(root, "building-blocks", name, `${name}.css`), body);
    }
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "both";
    clearCache();
    learnLibrary({ fileKey: "ACMEKIT", role: "library", fileName: "Acme Kit", metadataXml: KIT });
    const masters = graphMasters();
    expect(masters.find((m) => m.name === "Acme Button")?.variants).toEqual(["Large", "Primary"]);
    expect(masters.find((m) => m.name === "Acme Banner")?.variants).toEqual(["Promo"]);

    const cfg: ResolveConfig = { mode: "both", modeSource: "env", repoPath: root, localPrefixes: [], storeDir: store };
    const report = mapReport(buildCatalog(cfg), cfg, { suggest: true, masters });
    expect(report.pairs.map((pair) => `${pair.figma}=${pair.code}:${pair.confidence}`).sort()).toEqual(["Acme Banner=acme-banner:exact", "Acme Button=acme-button:exact"]);
    expect(report.suggestions?.find((row) => row.figma === "Acme Badge" && row.code === "acme-badge")?.confidence).toBe("risky: same name only");
  });
});
