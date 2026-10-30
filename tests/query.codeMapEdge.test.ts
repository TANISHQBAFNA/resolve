import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { scanAngularPackage } from "@/adapters/angular";
import { entriesToCsv } from "@/core/query/codeMapCsv";
import { handoffSheet, indexGraph, ingredientCard } from "@/core/query";
import { scoreSuggestions, suggestPairs, wrongMappedLinks, type AnswerPair } from "@/core/query/codeMapSuggest";
import { libraryCodeTargets, screenPartsCard } from "@/core/query/replacements";
import { isRetired } from "@/core/rules/retired";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";

const FIX = join(__dirname, "..", "fixtures", "pr63-edge");
const PKG = join(FIX, "acme-edge-angular");
const LEGACY = join(FIX, "acme-edge-legacy");
const KEY = JSON.parse(readFileSync(join(FIX, "answer-key.json"), "utf8")) as {
  pairs: AnswerPair[];
  retired: string[];
  noCode: string[];
  notComponents: string[];
  codeDeprecated: string[];
};
const FROZEN = "2026-01-01T00:00:00.000Z";

function graph(file = "figma-acme-edge.json") {
  return buildGraph(
    adaptFigmaRestFile({ fileKey: "ACMEEDGE", file: JSON.parse(readFileSync(join(FIX, file), "utf8")), kind: "mock", ingestedAt: FROZEN }),
    { builtAt: FROZEN },
  );
}

describe("code map edge fixture", () => {
  const previous = process.env["RESOLVE_HOME"];
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-edge-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(graph());
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("scans directives, template-literal selectors, and @deprecated, and skips noise", () => {
    const inventory = scanAngularPackage(PKG);
    const names = inventory.components.map((row) => row.component);
    expect(names).toContain("AcmeTooltipDirective");
    expect(inventory.components.find((row) => row.component === "AcmeTooltipDirective")?.selector).toBe("[acmeTooltip]");
    expect(inventory.components.find((row) => row.component === "AcmeSnackbarComponent")?.selector).toBe("acme-snackbar");
    expect(inventory.components.find((row) => row.component === "AcmeBannerComponent")?.deprecated).toMatch(/deprecated|AcmeAlert/i);
    expect(inventory.components.find((row) => row.component === "AcmeButtonLegacyComponent")?.deprecated).toBeTruthy();
    const skipped = KEY.notComponents.filter((name) => name !== "AcmeTooltipSourceDirective");
    for (const noise of skipped) expect(names).not.toContain(noise);
    expect(names).toContain("AcmeTooltipSourceDirective");
    expect(inventory.components.find((row) => row.component === "AcmeTooltipDirective")?.selectorConflict).toEqual(["AcmeTooltipSourceDirective"]);
    expect(inventory.components.find((row) => row.component === "AcmeTooltipSourceDirective")?.selectorConflict).toEqual(["AcmeTooltipDirective"]);
  });

  it("suggests the 49-pair key with no wrong link when every suggestion is accepted", () => {
    const index = indexGraph(graph());
    const pairs = suggestPairs(index, scanAngularPackage(PKG), libraryCodeTargets(index), { retired: (node) => isRetired(index, node) });
    const score = scoreSuggestions(
      pairs.map((pair) => ({ figma: pair.name, component: pair.component, relation: pair.relation })),
      KEY.pairs,
    );
    const accepted = pairs
      .filter((pair) => pair.status === "suggested")
      .map((pair) => ({ name: pair.name, status: "mapped", relation: pair.relation, code: { component: pair.component } }));
    expect(pairs.filter((pair) => KEY.retired.includes(pair.name))).toEqual([]);
    expect(pairs.filter((pair) => KEY.noCode.includes(pair.name) && pair.status === "suggested")).toEqual([]);
    const byStatus = (status: "suggested" | "partial") =>
      scoreSuggestions(
        pairs.filter((pair) => pair.status === status).map((pair) => ({ figma: pair.name, component: pair.component, relation: pair.relation })),
        KEY.pairs,
      );
    const suggested = byStatus("suggested");
    const partial = byStatus("partial");
    const label = (pair: AnswerPair) => `${pair.figma} → ${pair.component}`;
    expect(wrongMappedLinks(accepted, KEY.pairs)).toEqual([]);
    expect(pairs.filter((pair) => KEY.noCode.includes(pair.name) && pair.status === "suggested")).toEqual([]);
    expect(suggested.extra).toEqual([]);
    expect(suggested).toMatchObject({ proposed: 43, labelled: 49, hits: 43, precision: 1, recall: 43 / 49 });
    expect(suggested.missed.map(label).sort()).toEqual(
      [
        "Avatar → AcmeAvatarComponent",
        "Breadcrumbs → AcmeBreadcrumbComponent",
        "Date range picker → AcmeDateRangeEndComponent",
        "Date range picker → AcmeDateRangeStartComponent",
        "Pagination → AcmePaginatorComponent",
        "Radio → AcmeRadioButtonComponent",
      ].sort(),
    );
    const avatar = pairs.filter((pair) => pair.name === "Avatar");
    expect(avatar.map((pair) => pair.component).sort()).toEqual(["AcmeAvatarComponent", "AvatarComponent"]);
    expect(avatar.every((pair) => pair.status === "partial")).toBe(true);
    expect(partial.extra).toEqual([{ figma: "Avatar", component: "AvatarComponent", relation: "maps" }]);
    expect(partial).toMatchObject({ proposed: 6, labelled: 49, hits: 5, precision: 5 / 6, recall: 5 / 49 });
    expect(score.extra).toEqual([{ figma: "Avatar", component: "AvatarComponent", relation: "maps" }]);
    expect(score.missed.map(label).sort()).toEqual(["Pagination → AcmePaginatorComponent"]);
    expect(score).toMatchObject({ proposed: 49, labelled: 49, hits: 48, precision: 48 / 49, recall: 48 / 49 });
    expect(pairs.some((pair) => pair.component === "AcmeBannerComponent" && pair.codeDeprecated)).toBe(true);
  });

  it("round-trips the import path through the review CSV", async () => {
    const entry = {
      fileKey: "ACMEEDGE",
      id: "1:1",
      name: "Button",
      status: "suggested",
      relation: "maps",
      code: { import: "import { AcmeButtonComponent } from '@acme/edge-angular'", component: "AcmeButtonComponent", framework: "angular", selector: "acme-button" },
    };
    writeFileSync(join(home, "code-map.json"), JSON.stringify({ entries: [entry] }));
    const csv = join(home, "review.csv");
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await runCli(["code-map", "review", "--out", csv]);
    } finally {
      process.stdout.write = write;
    }
    const text = readFileSync(csv, "utf8");
    expect(text).toContain("@acme/edge-angular");
    expect(text).not.toMatch(/,c,/);
    expect(entriesToCsv([entry])).toContain("@acme/edge-angular");
    const mapped = text.replace(",suggested,", ",mapped,");
    writeFileSync(csv, mapped);
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await runCli(["code-map", "review", "--import", csv]);
    } finally {
      process.stdout.write = write;
    }
    const stored = JSON.parse(readFileSync(join(home, "code-map.json"), "utf8")) as { entries: { code: { import: string } }[] };
    expect(stored.entries[0]?.code.import).toBe("import { AcmeButtonComponent } from '@acme/edge-angular'");
  });

  it("rejects retired mapped rows, conflicting statuses and unknown ids, and warns when a version changes", async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const capture = async (args: string[]) => {
      out.length = 0;
      process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
      try {
        await runCli(args);
      } finally {
        process.stdout.write = write;
      }
      return out.join("");
    };
    const button = {
      fileKey: "ACMEEDGE",
      id: "1:1",
      name: "Button",
      status: "mapped",
      relation: "maps",
      figmaVersion: "2026.10.1",
      packageVersion: "3.2.0",
      code: { import: "import { AcmeButtonComponent } from '@acme/edge-angular'", component: "AcmeButtonComponent", framework: "angular", selector: "button[acme-button]" },
    };
    writeFileSync(join(home, "code-map.json"), JSON.stringify({ figmaVersion: "2026.10.1", packages: { "@acme/edge-angular": "3.2.0" }, entries: [button] }, null, 2));
    await capture(["code-map", "suggest", LEGACY, "--write"]);
    const doc = JSON.parse(readFileSync(join(home, "code-map.json"), "utf8")) as { packages?: Record<string, string> };
    expect(doc.packages?.["@acme/edge-angular"]).toBe("3.2.0");
    expect(doc.packages?.["@acme/edge-legacy"]).toBe("0.9.1");
    saveGraph(graph("figma-acme-edge-v2.json"));
    clearCache();
    const soft = handoffSheet(indexGraph(graph("figma-acme-edge-v2.json")), ["Edge screen"]);
    if (!soft.ok) throw new Error("a stale link is a warning, not a refusal");
    expect(soft.screens[0]!.warnings?.some((row) => row.kind === "review" && /Button/.test(row.message) && /re-review the code link/.test(row.next ?? ""))).toBe(true);
    const sheet = handoffSheet(indexGraph(graph("figma-acme-edge-v2.json")), ["Edge screen"], { strict: true });
    expect(sheet.ok).toBe(false);
    if (!sheet.ok) expect(sheet.refused.some((row) => row.kind === "review" && /Button/.test(row.message))).toBe(true);
    const parts = screenPartsCard(indexGraph(graph("figma-acme-edge-v2.json")), "Edge screen");
    if (!parts.ok) throw new Error("parts");
    expect(parts.ask).toMatch(/re-review/);
    const staleCard = ingredientCard(indexGraph(graph("figma-acme-edge-v2.json")), "Button");
    if (!staleCard.found) throw new Error("button");
    expect(staleCard.code).toBeNull();
    expect(staleCard.note).toMatch(/re-review/);
    const retiredCsv = join(home, "retired.csv");
    writeFileSync(retiredCsv, "fileKey,id,name,component,importPath,status,relation\nACMEEDGE,1:29,Alert,AcmeAlertComponent,@acme/edge-angular,mapped,maps\n");
    expect(await capture(["code-map", "review", "--import", retiredCsv])).toContain("retired and cannot be mapped");
    const dup = join(home, "dup.csv");
    writeFileSync(dup, "fileKey,id,name,component,importPath,status\nACMEEDGE,1:11,Tag,AcmeTagComponent,@acme/edge-angular,mapped\nACMEEDGE,1:11,Tag,AcmeTagComponent,@acme/edge-angular,suggested\n");
    expect(await capture(["code-map", "review", "--import", dup])).toContain("conflicting status");
    const unknown = join(home, "unknown.csv");
    writeFileSync(unknown, "fileKey,id,name,component,importPath,status\nACMEEDGE,1:777,Ghost,AcmeGhostComponent,@acme/edge-angular,mapped\n");
    expect(await capture(["code-map", "review", "--import", unknown])).toContain("unknown id");
    const liveRetired = join(home, "live.csv");
    writeFileSync(liveRetired, "fileKey,id,name,component,importPath,status,relation\nACMEEDGE,1:23,Dialog body,AcmeDialogBodyComponent,@acme/edge-angular,retired,maps\n");
    await capture(["code-map", "--import", liveRetired, "--force"]);
    clearCache();
    const body = ingredientCard(indexGraph(graph()), "Dialog body");
    if (!body.found) throw new Error("body");
    expect(body.component.status).toBe("retired");
    expect(body.code).toBeNull();
    const force = join(home, "force.csv");
    writeFileSync(force, "fileKey,id,name,component,importPath,status,relation\nACMEEDGE,1:1,Button,AcmeButtonComponent,@acme/edge-angular,mapped,maps\nACMEEDGE,1:10,Chip,AcmeChipComponent,@acme/edge-angular,,maps\n");
    await capture(["code-map", "--import", force, "--force"]);
    const after = JSON.parse(readFileSync(join(home, "code-map.json"), "utf8")) as { entries: { name?: string; status?: string }[] };
    expect(after.entries.find((entry) => entry.name === "Chip")?.status).toBe("suggested");
  });
});
