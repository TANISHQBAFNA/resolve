import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapReport } from "@/server/code/map";
import { buildCatalog } from "@/server/code/scan";
import type { ResolveConfig } from "@/server/mode";

function setup(files: Array<[folder: string, name: string]>) {
  const root = mkdtempSync(join(tmpdir(), "resolve-leaf-"));
  for (const [folder, name] of files) {
    mkdirSync(join(root, folder, name), { recursive: true });
    writeFileSync(join(root, folder, name, `${name}.css`), `.${name} { color: var(--ink); }\n`);
  }
  const cfg: ResolveConfig = { mode: "both", modeSource: "env", repoPath: root, localPrefixes: [], storeDir: join(root, "store") };
  return { cfg, catalog: buildCatalog(cfg) };
}

const masters = [
  { name: "ingredients/button", nodeId: "1:1" },
  { name: "acme-lib/button", nodeId: "1:2" },
  { name: "ingredients/forms/text-area", nodeId: "1:3" },
  { name: "Atoms/Input", nodeId: "1:4" },
  { name: "recipes/input-field", nodeId: "1:5" },
  { name: "base/field-label", nodeId: "1:6" },
  { name: "Button/Primary", nodeId: "1:7" },
];

describe("pair suggestions ignore library path prefixes", () => {
  const { cfg, catalog } = setup([["building-blocks", "button"], ["building-blocks", "input"], ["building-blocks", "textarea"], ["recipes", "input-field"]]);
  const report = mapReport(catalog, cfg, { suggest: true, masters, limit: 5 });
  const score = (figma: string, code: string) => report.suggestions?.find((row) => row.figma === figma && row.code === code)?.score;

  it("suggests a same-name coded component at 1.0 behind a known, unknown or nested folder", () => {
    expect(score("ingredients/button", "button")).toBe(1);
    expect(score("acme-lib/button", "button")).toBe(1);
    expect(score("ingredients/forms/text-area", "textarea")).toBe(1);
    expect(score("Atoms/Input", "input")).toBe(1);
    expect(score("recipes/input-field", "input-field")).toBe(1);
    expect(score("Button/Primary", "button")).toBe(1);
  });

  it("does not treat input-field as the same name as input", () => {
    expect(report.suggestions?.some((row) => row.figma === "recipes/input-field" && row.code === "input" && row.score === 1)).toBe(false);
  });

  it("keeps a same name with no evidence risky, never joined, and leaves base parts out", () => {
    expect(report.suggestions?.find((row) => row.figma === "acme-lib/button" && row.code === "button")?.confidence).toBe("risky: same name only");
    expect(report.pairs).toEqual([]);
    expect(report.bulkConfirm).toEqual([]);
    expect(report.suggestions?.some((row) => row.figma === "base/field-label")).toBe(false);
  });
});
