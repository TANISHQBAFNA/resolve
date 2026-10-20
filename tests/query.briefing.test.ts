import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import {
  briefScreen,
  formatHandoffScreen,
  handoffSheet,
  indexGraph,
  recommendMasters,
  starterRecipes,
  type BriefQuestion,
  type BriefResult,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { presentToolResult } from "@/server/cards";
import { callTool } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";
import cases from "../scoreboard/briefing/acme.json";

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
    edges: [
      { id: "e1", source: "node:1:2", target: "node:10:17", type: "INSTANCE_OF" },
    ],
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

function topName(request: string): string | undefined {
  const card = recommendMasters(indexGraph(acmeGraph()), request, { budgetChars: 4000 }) as {
    candidates?: Array<{ name?: string }>;
  };
  return card.candidates?.[0]?.name;
}

interface ExpectedCase {
  request: string;
  questions?: string[];
  skip?: string;
  assumptions?: string[];
  candidates?: string[];
  picks?: Record<string, Record<string, string>>;
}

const expected = cases as { cases: ExpectedCase[] };

function asked(result: BriefResult): BriefQuestion[] {
  return "questions" in result ? result.questions : [];
}

const DUMP_REQUESTS = [
  "show recent activity",
  "show recent activity as a data table",
  "show recent activity as a data table on desktop",
  "show recent activity as a data table on desktop with an empty state",
  "checkout summary",
  "settings form",
  "search results",
  "sign in",
  "inbox",
  "confirm dialog",
  "empty state",
  "app shell",
  "just build a transactions screen",
  "just build the checkout summary",
  "don't ask, make the transactions screen",
  "no questions, use a data table",
  "transactions screen",
  "desktop settings",
  "compare rows in a table",
  "scan items on a card list",
  "fill in a form",
  "review a summary",
  "read the counts",
  "mobile nav with a loading spinner",
  "compact list of payments",
  "comfortable cards for a catalog",
  "error when a payment fails",
  "pending transfer status",
  "place the Pay CTA",
  "checkout",
  "blank",
  "preferences screen",
  "login screen",
  "navigation shell",
  "show recent activity as a data table on a phone",
];

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

  it("covers at least 30 Acme screen requests and only asks questions that change the pick", () => {
    if (process.env["BRIEF_DUMP"] === "1") {
      let questions = 0;
      let changed = 0;
      const dumped = DUMP_REQUESTS.map((request) => {
        const result = run(request);
        const prompts = asked(result);
        questions += prompts.length;
        if ("questions" in result) {
          const picks: Record<string, Record<string, string>> = {};
          for (const question of result.questions) {
            picks[question.topic] = {};
            const names = question.options.map((option) => topName(`${request} ${option.label}`));
            if (new Set(names).size === names.length) changed += question.options.length ? 1 : 0;
            question.options.forEach((option, index) => {
              picks[question.topic]![option.id] = names[index] ?? "";
            });
          }
          return { request, questions: result.questions.map((question) => question.topic), picks };
        }
        return { request, skip: result.skip, assumptions: result.assumptions, candidates: result.candidates.map((candidate) => candidate.name) };
      });
      const payload = {
        average: questions / dumped.length,
        changedShare: questions ? changed / questions : 1,
        cases: dumped,
      };
      writeFileSync(join(import.meta.dirname, "../scoreboard/briefing/acme.json"), `${JSON.stringify(payload, null, 2)}\n`);
      expect(dumped.length).toBeGreaterThanOrEqual(30);
      return;
    }
    expect(expected.cases.length).toBeGreaterThanOrEqual(30);
    const seen = new Set<string>();
    let questions = 0;
    let changed = 0;
    for (const row of expected.cases) {
      expect(seen.has(row.request), row.request).toBe(false);
      seen.add(row.request);
      const result = run(row.request);
      const prompts = asked(result);
      expect(prompts.length, row.request).toBeLessThanOrEqual(3);
      questions += prompts.length;
      if ("questions" in result) {
        expect(result.questions.map((question) => question.topic)).toEqual(row.questions ?? []);
        for (const question of result.questions) {
          expect(question.options.length).toBeGreaterThanOrEqual(2);
          expect(question.prompt).toContain("?");
          const names = question.options.map((option) => topName(`${row.request} ${option.label}`));
          expect(new Set(names).size, question.prompt).toBe(names.length);
          changed += 1;
          const want = row.picks?.[question.topic] ?? {};
          for (const option of question.options) {
            expect(names[question.options.indexOf(option)], `${row.request} ${option.id}`).toBe(want[option.id]);
            expect(MASTERS.some(([, name]) => name === option.label)).toBe(true);
          }
        }
      } else {
        expect(result.ready).toBe(true);
        expect(result.skip).toBe(row.skip);
        expect(result.assumptions).toEqual(row.assumptions ?? []);
        expect(result.candidates.map((candidate) => candidate.name)).toEqual(row.candidates ?? []);
      }
    }
    const average = questions / expected.cases.length;
    expect(average).toBeLessThanOrEqual(3);
    expect(changed).toBe(questions);
    expect(average).toBeCloseTo(cases.average, 5);
    expect(changed / questions).toBeCloseTo(cases.changedShare, 5);
  });

  it("folds an answer into recommend and shows it on the handoff", () => {
    const open = run("show recent activity");
    expect("questions" in open).toBe(true);
    const plain = topName("show recent activity");
    const table = topName("show recent activity Data Table");
    expect(table).toBe("Data Table");
    expect(table).not.toBe(plain);

    saveGraph(acmeGraph());
    const briefed = callTool("brief", { request: "show recent activity", answers: { shape: "table" } }) as BriefResult;
    const topics = asked(briefed).map((question) => question.topic);
    expect(topics).not.toContain("shape");
    const ranked = callTool("recommend", { intent: "show recent activity", answers: { shape: "table" } }) as {
      candidates?: Array<{ name?: string }>;
    };
    expect(ranked.candidates?.[0]?.name).toBe("Data Table");

    const sheet = handoffSheet(indexGraph(acmeGraph()), ["Activity"], {
      recipes: starterRecipes(),
      briefing: ["data shape: Data Table"],
    });
    expect(sheet.ok).toBe(true);
    if (!sheet.ok) return;
    expect(sheet.screens[0]?.briefing).toEqual(["data shape: Data Table"]);
    const text = formatHandoffScreen(sheet.screens[0]!, false);
    expect(text).toContain("## Briefing");
    expect(text).toContain("data shape: Data Table");
    expect(presentToolResult(sheet, "markdown", "get_handoff")).toContain("data shape: Data Table");
  });

  it("resolve brief prints questions or a ready card", async () => {
    saveGraph(acmeGraph());
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["brief", "checkout summary"]);
    } finally {
      process.stdout.write = write;
    }
    const printed = JSON.parse(chunks.join("")) as BriefResult;
    expect("ready" in printed && printed.ready).toBe(true);
    if ("ready" in printed) expect(printed.candidates.some((candidate) => candidate.name === "Pay CTA")).toBe(true);
  });
});
