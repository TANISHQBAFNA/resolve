import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph, recommendMasters, type GraphIndex } from "@/core/query";
import { buildGraph } from "@/core/transform/buildGraph";
import { clearCache } from "@/server/store";
import probesFile from "../scoreboard/meaning/probes.json";
import freshFile from "../scoreboard/meaning/fresh.json";
import r21File from "../scoreboard/meaning/r21.json";
import r5File from "../scoreboard/meaning/r5.json";
import r6File from "../scoreboard/meaning/r6.json";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const FROZEN = "2026-01-01T00:00:00.000Z";

interface Probe {
  id: string;
  library: "acme" | "material";
  kind: string;
  phrase: string;
  expect: string | null;
  accept?: string[];
  weak?: boolean;
}

function node(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", ...extra };
}

const ACME_MASTERS: Array<[string, string]> = [
  ["10:1", "Data Table"],
  ["10:2", "Card List"],
  ["10:3", "Summary Card"],
  ["10:4", "Stat Block"],
  ["10:5", "Text Field"],
  ["10:6", "Pay CTA"],
  ["10:7", "Save CTA"],
  ["10:8", "Search Field"],
  ["10:9", "Empty Message"],
  ["10:10", "Error Alert"],
  ["10:11", "Pending Banner"],
  ["10:12", "Loading Spinner"],
  ["10:13", "Compact List"],
  ["10:14", "Comfortable List"],
  ["10:15", "Mobile Nav"],
  ["10:16", "Desktop Nav"],
  ["10:17", "Button"],
];

function acmeIndex(): GraphIndex {
  const masters = ACME_MASTERS.map(([id, name]) =>
    node(`node:${id}`, "MAIN_COMPONENT", name, { figmaNodeId: id, isMainComponent: true }),
  );
  const graph: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:ACMEUI", "FILE", "Acme UI"), ...masters],
    edges: [],
  };
  return indexGraph(graph);
}

function materialIndex(): GraphIndex {
  const fix = join(repo, "fixtures", "material");
  const payload = JSON.parse(readFileSync(join(fix, "library.json"), "utf8")) as { fileKey: string; variables: unknown };
  return indexGraph(
    buildGraph(
      adaptFigmaRestFile({
        fileKey: payload.fileKey,
        file: payload,
        variables: payload.variables,
        kind: "json",
        ingestedAt: "2026-10-21T00:00:00.000Z",
      }),
      { builtAt: "2026-10-21T00:00:00.000Z" },
    ),
  );
}

function offered(index: GraphIndex, phrase: string): { name?: string; weak: boolean } {
  const card = recommendMasters(index, phrase, { budgetChars: 4000 }) as {
    match?: string;
    candidates: Array<{ name?: string }>;
  };
  return { name: card.candidates[0]?.name, weak: card.match === "weak match" };
}

function right(probe: Probe, name: string | undefined): boolean {
  if (probe.expect === null) return name === undefined;
  if (!name) return false;
  if (name === probe.expect) return true;
  return probe.accept?.includes(name) ?? false;
}

describe("meaning probes", () => {
  const previous = process.env["RESOLVE_HOME"];
  let acme: GraphIndex;
  let material: GraphIndex;

  beforeEach(() => {
    const home = join(tmpdir(), "resolve-meaning-probes");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(repo, "fixtures", "material", "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    acme = acmeIndex();
    material = materialIndex();
  });

  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("scores made-up Acme and Angular Material asks", () => {
    const cases = probesFile.cases as Probe[];
    expect(cases.length).toBeGreaterThanOrEqual(150);
    const misses: string[] = [];
    const totals = { acme: [0, 0], material: [0, 0] } as Record<string, [number, number]>;
    for (const probe of cases) {
      const index = probe.library === "acme" ? acme : material;
      const got = offered(index, probe.phrase);
      const hit = right(probe, got.name) && (probe.weak === undefined || probe.weak === got.weak);
      const pair = totals[probe.library] ?? [0, 0];
      pair[1] += 1;
      if (hit) pair[0] += 1;
      else misses.push(`${probe.id} [${probe.kind}] "${probe.phrase}" → ${got.name ?? "∅"}${got.weak ? " weak" : ""} (want ${probe.expect ?? "∅"})`);
      totals[probe.library] = pair;
    }
    const correct = (totals["acme"]?.[0] ?? 0) + (totals["material"]?.[0] ?? 0);
    const all = cases.length;
    const line = `meaning probes ${correct}/${all} acme ${totals["acme"]?.[0]}/${totals["acme"]?.[1]} material ${totals["material"]?.[0]}/${totals["material"]?.[1]}`;
    process.stdout.write(`${line}\n${misses.join("\n")}\n`);
    // Density-synonym probes used the deleted word lists. The regression gate still guards leads main got right.
    expect(correct).toBeGreaterThanOrEqual(149);
  });

  it("does not copy a scoreboard or held-out phrase", () => {
    const exact = new Set<string>();
    const held = new Set<string>();
    const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/ +/g, " ");
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (path.includes(`${join("scoreboard", "meaning")}`)) continue;
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.endsWith(".json")) continue;
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { cases?: Array<Record<string, unknown>>; phrases?: Array<Record<string, unknown>> };
        const rows = [...(parsed.cases ?? []), ...(parsed.phrases ?? [])];
        const heldFile = path.includes("held");
        for (const row of rows) {
          for (const key of ["phrase", "q", "request"]) {
            const value = row[key];
            if (typeof value !== "string") continue;
            const cleaned = norm(value);
            if (!cleaned) continue;
            exact.add(cleaned);
            if (heldFile) held.add(cleaned);
          }
        }
      }
    };
    walk(join(repo, "scoreboard"));
    const copies = (probesFile.cases as Probe[]).filter((row) => {
      const phrase = norm(row.phrase);
      if (exact.has(phrase)) return true;
      const padded = ` ${phrase} `;
      return [...held].some((value) => value.length >= 3 && padded.includes(` ${value} `));
    });
    expect(copies.map((row) => row.phrase)).toEqual([]);
  });

  it("scores a fresh set written after the parse was wired", () => {
    const rows = freshFile.cases as Probe[];
    let correct = 0;
    const misses: string[] = [];
    for (const probe of rows) {
      const index = probe.library === "acme" ? acme : material;
      const got = offered(index, probe.phrase);
      if (right(probe, got.name)) correct += 1;
      else misses.push(`${probe.phrase} → ${got.name ?? "∅"} (want ${probe.expect ?? "∅"})`);
    }
    process.stdout.write(`fresh probes ${correct}/${rows.length}\n${misses.join("\n")}\n`);
    expect(correct).toBeGreaterThanOrEqual(14);
  });

  it("scores 30 probes for an unlisted noun, a device word, and a joined plural", () => {
    const rows = r21File.cases as Probe[];
    expect(rows.length).toBe(30);
    let correct = 0;
    const misses: string[] = [];
    const byKind: Record<string, [number, number]> = {};
    for (const probe of rows) {
      const index = probe.library === "acme" ? acme : material;
      const got = offered(index, probe.phrase);
      const hit = right(probe, got.name);
      const pair = byKind[probe.kind] ?? [0, 0];
      pair[1] += 1;
      if (hit) {
        pair[0] += 1;
        correct += 1;
      } else misses.push(`${probe.kind} "${probe.phrase}" → ${got.name ?? "∅"} (want ${probe.expect ?? "∅"})`);
      byKind[probe.kind] = pair;
    }
    const kinds = Object.entries(byKind)
      .map(([kind, pair]) => `${kind} ${pair[0]}/${pair[1]}`)
      .join(" ");
    process.stdout.write(`r21 probes ${correct}/${rows.length} ${kinds}\n${misses.join("\n")}\n`);
    expect(correct).toBeGreaterThanOrEqual(20);
  });

  it("scores fresh probes for everyday nouns, plain lists, units, and purpose", () => {
    const rows = r5File.cases as Probe[];
    expect(rows.length).toBe(29);
    let correct = 0;
    const misses: string[] = [];
    const byKind: Record<string, [number, number]> = {};
    for (const probe of rows) {
      const index = probe.library === "acme" ? acme : material;
      const got = offered(index, probe.phrase);
      const hit = right(probe, got.name);
      const pair = byKind[probe.kind] ?? [0, 0];
      pair[1] += 1;
      if (hit) {
        pair[0] += 1;
        correct += 1;
      } else misses.push(`${probe.kind} "${probe.phrase}" → ${got.name ?? "∅"} (want ${probe.expect ?? "∅"})`);
      byKind[probe.kind] = pair;
    }
    const kinds = Object.entries(byKind)
      .map(([kind, pair]) => `${kind} ${pair[0]}/${pair[1]}`)
      .join(" ");
    process.stdout.write(`r5 probes ${correct}/${rows.length} ${kinds}\n${misses.join("\n")}\n`);
    expect(correct).toBeGreaterThanOrEqual(9);
  });

  it("scores 25 fresh probes for purpose fallback, sense nouns, and plain lists", () => {
    const rows = r6File.cases as Probe[];
    expect(rows.length).toBe(25);
    let correct = 0;
    const misses: string[] = [];
    for (const probe of rows) {
      const index = probe.library === "acme" ? acme : material;
      const got = offered(index, probe.phrase);
      if (right(probe, got.name)) correct += 1;
      else misses.push(`${probe.kind} "${probe.phrase}" → ${got.name ?? "∅"} (want ${probe.expect ?? "∅"})`);
    }
    process.stdout.write(`r6 probes ${correct}/${rows.length}\n${misses.join("\n")}\n`);
    expect(correct).toBeGreaterThanOrEqual(11);
  });
});
