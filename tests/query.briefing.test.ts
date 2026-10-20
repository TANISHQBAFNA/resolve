import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import {
  BriefAnswerError,
  briefAnswers,
  briefAnswersFromFlags,
  briefScreen,
  formatHandoffScreen,
  handoffSheet,
  indexGraph,
  recommendMasters,
  starterRecipes,
  type BriefResult,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, ToolError } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";
import labeled from "../scoreboard/briefing/acme.json";

const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", ...extra };
}

const MASTERS: Array<[string, string]> = [
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

function acmeGraph(): DesignGraph {
  const masters = MASTERS.map(([id, name]) =>
    node(`node:${id}`, "MAIN_COMPONENT", name, { figmaNodeId: id, isMainComponent: true }),
  );
  return {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      node("file:ACMEUI", "FILE", "Acme UI"),
      node("page:1", "PAGE", "Screens", { parentId: "file:ACMEUI" }),
      node("node:1:1", "FRAME", "Activity", { parentId: "page:1", figmaNodeId: "1:1" }),
      node("node:1:2", "COMPONENT_INSTANCE", "Button", {
        parentId: "node:1:1",
        figmaNodeId: "1:2",
        mainComponentId: "node:10:17",
      }),
      ...masters,
    ],
    edges: [{ id: "e1", source: "node:1:2", target: "node:10:17", type: "INSTANCE_OF" }],
  };
}

const decision = {
  proposal: {
    id: "p-table",
    createdAt: FROZEN,
    status: "approved" as const,
    type: "variant-candidate" as const,
    summary: "Use Data Table on the transactions screen",
    evidence: "Acme transactions screens use Data Table",
  },
  who: "Avery",
  when: "2026-01-02T00:00:00.000Z",
};

function run(request: string): BriefResult {
  return briefScreen({
    request,
    index: indexGraph(acmeGraph()),
    recipes: starterRecipes(),
    decisions: [decision],
  });
}

function asked(result: BriefResult) {
  return "questions" in result ? result.questions : [];
}

describe("designer briefing", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-brief-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("asks only on the requests labeled should-ask, and reports precision and the average", () => {
    const cases = labeled.cases;
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.some((row) => /tabel|lsit|paymnts|asdf/.test(row.request))).toBe(true);
    expect(cases.some((row) => /flux|orbital|zxcv/.test(row.request))).toBe(true);
    let questions = 0;
    let askedCount = 0;
    let truePositive = 0;
    const misses: string[] = [];
    for (const row of cases) {
      const result = run(row.request);
      const prompts = asked(result);
      expect(prompts.length, row.request).toBeLessThanOrEqual(3);
      expect(prompts.some((question) => question.prompt.toLowerCase().includes("settings form")), row.request).toBe(false);
      const didAsk = prompts.length > 0;
      if (didAsk !== row.shouldAsk) misses.push(`${row.request} | should ${row.shouldAsk} | asked ${didAsk} | ${JSON.stringify(result).slice(0, 280)}`);
      questions += prompts.length;
      if (didAsk) {
        askedCount += 1;
        if (row.shouldAsk) truePositive += 1;
      }
      if (!row.shouldAsk && /flux|asdf|tabel|lsit|pyament|orbital|recent activity|just do it|without asking|on desktop|comfortable please/.test(row.request)) {
        expect("ready" in result && result.candidates, row.request).toEqual([]);
        expect("ready" in result && result.assumptions.join(" "), row.request).toMatch(/No match/);
        expect(JSON.stringify(result), row.request).not.toMatch(/Desktop Nav|Save CTA|Comfortable List|Mobile Nav/);
      }
    }
    expect(misses, misses.join("\n")).toEqual([]);
    const precision = askedCount === 0 ? 1 : truePositive / askedCount;
    const average = questions / cases.length;
    expect(precision).toBe(labeled.precision);
    expect(average).toBe(labeled.average);
    expect(questions).toBe(labeled.questions);
    expect(cases.length).toBe(labeled.screens);
  });

  it("does not invent a pick for just build when nothing fits, and does not treat desktop as Desktop Nav", () => {
    const invented = run("just build a flux capacitor");
    expect(invented).toMatchObject({ ready: true, candidates: [], assumptions: ["No match."] });
    const desktop = run("on desktop");
    expect(desktop).toMatchObject({ ready: true, candidates: [] });
    expect(JSON.stringify(desktop)).not.toContain("Desktop Nav");
    const settings = run("desktop settings form");
    expect("ready" in settings && settings.candidates.map((row) => row.name)).toEqual(["Text Field", "Save CTA"]);
    const named = briefScreen({
      request: "use the Desktop Nav",
      answers: { states: ["empty"] },
      index: indexGraph(acmeGraph()),
      recipes: starterRecipes(),
    });
    expect("ready" in named && named.candidates.some((row) => row.name === "Desktop Nav")).toBe(true);
    const word = briefScreen({
      request: "on desktop",
      answers: { states: ["empty"] },
      index: indexGraph(acmeGraph()),
      recipes: starterRecipes(),
    });
    expect(JSON.stringify(word)).not.toContain("Desktop Nav");
    const ahead = run("go ahead and build the checkout summary");
    expect(asked(ahead)).toEqual([]);
    expect("ready" in ahead && ahead.candidates.length).toBeGreaterThan(0);
    const quiet = run("build without asking");
    expect(quiet).toMatchObject({ candidates: [], assumptions: ["No match."] });
  });

  it("says you answered when the value came from an answer, and lets states take more than one", () => {
    const result = briefScreen({
      request: "compare rows in a table",
      answers: { states: ["empty", "error"] },
      index: indexGraph(acmeGraph()),
      recipes: starterRecipes(),
    });
    expect("ready" in result).toBe(true);
    if (!("ready" in result)) return;
    expect(result.assumptions.some((line) => line.startsWith("You answered states:"))).toBe(true);
    expect(result.assumptions.some((line) => line.startsWith("Request already says data shape:"))).toBe(true);
    expect(result.candidates.map((row) => row.name)).toEqual(expect.arrayContaining(["Data Table", "Empty Message", "Error Alert"]));
    const open = run("compare rows in a table");
    const states = asked(open).find((question) => question.topic === "states");
    expect(states?.multiple).toBe(true);
    expect(states?.prompt).toContain("Pick any that apply");
  });

  it("rejects a bad answer from brief, recommend, and handoff", async () => {
    saveGraph(acmeGraph());
    const bad = [
      ["--answer", "shape="],
      ["--answer", "goal=pay"],
      ["--answer", "shape=spreadsheet"],
      ["--answer", "states=empty", "--answer", "states=empty"],
      ["--answer", "shape=table", "--answer", "states=empty,error", "--answer", "platform=desktop"],
    ];
    for (const flags of bad) {
      await expect(runCli(["brief", "compare rows in a table", ...flags])).rejects.toBeInstanceOf(BriefAnswerError);
      await expect(runCli(["recommend", "compare rows in a table", ...flags])).rejects.toBeInstanceOf(BriefAnswerError);
      await expect(runCli(["handoff", "Activity", ...flags])).rejects.toBeInstanceOf(BriefAnswerError);
    }
    expect(() => briefAnswers({ shape: "" })).toThrow(/empty/i);
    expect(() => briefAnswers({ states: [] })).toThrow(/empty/i);
    expect(() => briefAnswersFromFlags(["--answer", "shape=table", "--answer", "shape=cards"])).toThrow(/twice/i);
    expect(() => callTool("brief", { request: "compare rows in a table", answers: { nope: "x" } })).toThrow(ToolError);
    expect(() => callTool("recommend", { intent: "table", answers: { shape: "" } })).toThrow(/empty/i);
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    expect(() => callTool("get_handoff", { frame: "Activity", answers: { platform: "lunar" } })).toThrow(/Unknown option/);
    delete process.env["RESOLVE_MCP_ADVANCED"];
  });

  it("changes the handoff parts the same way the answer changes recommend", () => {
    saveGraph(acmeGraph());
    const index = indexGraph(acmeGraph());
    const sheet = (shape: string) => {
      const pack = handoffSheet(index, ["Activity"], {
        recipes: starterRecipes(),
        briefing: [`You answered data shape: ${shape === "table" ? "Data Table" : "Card List"}.`],
        briefParts: [
          {
            id: shape === "table" ? "node:10:1" : "node:10:2",
            name: shape === "table" ? "Data Table" : "Card List",
            fileKey: "ACMEUI",
            figmaNodeId: shape === "table" ? "10:1" : "10:2",
          },
        ],
      });
      expect(pack.ok).toBe(true);
      if (!pack.ok) throw new Error("handoff refused");
      return pack;
    };
    const table = sheet("table");
    const cards = sheet("cards");
    expect(table.screens[0]?.components.map((row) => row.name)).toContain("Data Table");
    expect(table.screens[0]?.ingredients.map((row) => row.name)).toContain("Data Table");
    expect(cards.screens[0]?.components.map((row) => row.name)).toContain("Card List");
    expect(cards.screens[0]?.components.map((row) => row.name)).not.toContain("Data Table");
    expect(formatHandoffScreen(table.screens[0]!, false)).not.toBe(formatHandoffScreen(cards.screens[0]!, false));

    const ranked = callTool("recommend", {
      intent: "compare rows",
      answers: { states: ["empty", "error"] },
    }) as { intent?: string; candidates?: Array<{ name?: string }> };
    expect(ranked.intent).toContain("Empty Message");
    expect(ranked.intent).toContain("Error Alert");
    const plain = recommendMasters(index, "compare rows", { budgetChars: 4000 }) as { intent?: string };
    expect(plain.intent).not.toContain("Empty Message");

    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const handed = callTool("get_handoff", { frame: "Activity", answers: { shape: "cards", states: ["pending"] } }) as {
      screens?: Array<{ components: Array<{ name: string }>; ingredients: Array<{ name: string }> }>;
    };
    const names = handed.screens?.[0]?.components.map((row) => row.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["Card List", "Pending Banner"]));
    expect(handed.screens?.[0]?.ingredients.map((row) => row.name)).toEqual(expect.arrayContaining(["Card List", "Pending Banner"]));
  });
});
