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
  type BriefAnswers,
  type BriefResult,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, ToolError } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";
import labeled from "../scoreboard/briefing/acme.json";
import fitSet from "../scoreboard/briefing/acme-fit.json";

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
    let shouldAskCount = 0;
    let askedWhenShould = 0;
    const misses: string[] = [];
    for (const row of cases) {
      const result = run(row.request);
      const prompts = asked(result);
      expect(prompts.length, row.request).toBeLessThanOrEqual(3);
      expect(prompts.some((question) => question.prompt.toLowerCase().includes("settings form")), row.request).toBe(false);
      const didAsk = prompts.length > 0;
      if (didAsk !== row.shouldAsk) misses.push(`${row.request} | should ${row.shouldAsk} | asked ${didAsk} | ${JSON.stringify(result).slice(0, 280)}`);
      questions += prompts.length;
      if (row.shouldAsk) {
        shouldAskCount += 1;
        if (didAsk) askedWhenShould += 1;
      }
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
    const recall = shouldAskCount === 0 ? 1 : askedWhenShould / shouldAskCount;
    expect(precision).toBe(labeled.precision);
    expect(recall).toBe(labeled.recall);
    expect(average).toBe(labeled.average);
    expect(questions).toBe(labeled.questions);
    expect(cases.length).toBe(labeled.screens);
    expect(askedWhenShould).toBe(labeled.askedWhenShould);
    expect(shouldAskCount).toBe(labeled.shouldAsk);
  });

  it("does not invent a pick for just build when nothing fits, and does not treat desktop as Desktop Nav", () => {
    const invented = run("just build a flux capacitor");
    expect(invented).toMatchObject({ ready: true, candidates: [], assumptions: [expect.stringMatching(/^No match\. .*brief again/)] });
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
    expect(quiet).toMatchObject({ candidates: [], assumptions: [expect.stringMatching(/^No match\. .*brief again/)] });
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
    const open = run("a data table");
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

  it("reports part and question recall, precision and questions per request on a fresh held-out set", () => {
    let fitting = 0;
    let found = 0;
    let offered = 0;
    let right = 0;
    let shouldAsk = 0;
    let askedWhenShould = 0;
    let askedCount = 0;
    let questions = 0;
    let max = 0;
    for (const row of fitSet.cases) {
      const result = run(row.request);
      const prompts = asked(result);
      let names = "questions" in result
        ? result.questions.flatMap((question) => question.options.map((option) => option.label))
        : result.candidates.map((candidate) => candidate.name);
      if ("questions" in result && row.expect !== null && !names.includes(row.expect)) {
        const answers: BriefAnswers = { states: [] };
        for (const question of result.questions) {
          const first = question.options[0]!.id;
          if (question.topic === "states") answers.states.push(first);
          else answers[question.topic] = first;
        }
        const answered = briefScreen({ request: row.request, answers, index: indexGraph(acmeGraph()), recipes: starterRecipes() });
        if ("ready" in answered) names = [...names, ...answered.candidates.map((candidate) => candidate.name)];
      }
      const hit = row.expect !== null && names.includes(row.expect);
      if (row.expect !== null) {
        fitting += 1;
        if (hit) found += 1;
      } else {
        // Nothing fits: no candidates, no questions, and a next step.
        expect("ready" in result && result.candidates, row.request).toEqual([]);
        expect("ready" in result && result.assumptions[0], row.request).toMatch(/^No match\. .*brief again/);
      }
      if (names.length) {
        offered += 1;
        if (hit) right += 1;
      }
      expect(prompts.length, row.request).toBeLessThanOrEqual(3);
      questions += prompts.length;
      max = Math.max(max, prompts.length);
      if (row.shouldAsk) shouldAsk += 1;
      if (prompts.length) askedCount += 1;
      if (row.shouldAsk && prompts.length) askedWhenShould += 1;
    }
    const measured = {
      cases: fitSet.cases.length,
      fitting,
      partRecall: found / fitting,
      partPrecision: right / offered,
      shouldAsk,
      askedWhenShould,
      asked: askedCount,
      questionRecall: askedWhenShould / shouldAsk,
      questionPrecision: askedWhenShould / askedCount,
      questions,
      average: questions / fitSet.cases.length,
      max,
    };
    expect(measured).toEqual(fitSet.measured);
  });

  it("does not ask a shape question when the request names the shape, and each shape answer leads to its own part", () => {
    for (const request of ["summary cards for the order", "a summary card with the totals", "list the payees as cards"]) {
      expect(asked(run(request)).some((question) => question.topic === "shape"), request).toBe(false);
    }
    saveGraph(acmeGraph());
    for (const request of ["customer rows in a table or a card list", "a form or a summary of the account"]) {
      const shape = asked(run(request)).find((question) => question.topic === "shape");
      expect(shape, request).toBeDefined();
      const tops = shape!.options.map((option) => {
        const card = callTool("recommend", { intent: request, answers: { shape: option.id }, budgetChars: 4000 }) as { candidates?: Array<{ name?: string }> };
        return card.candidates?.[0]?.name;
      });
      expect(tops, request).toEqual(shape!.options.map((option) => option.label));
    }
  });

  it("asks platform when recommend's top parts differ only by platform, and the answer picks that part in CLI and MCP", async () => {
    const nav = asked(run("a nav bar"));
    expect(nav.map((question) => question.topic)).toEqual(["platform"]);
    expect(nav[0]!.options.map((option) => option.label).sort()).toEqual(["Desktop Nav", "Mobile Nav"]);
    expect(run("a nav bar on mobile")).toMatchObject({ ready: true, candidates: [expect.objectContaining({ name: "Mobile Nav" })] });
    expect(run("on desktop")).toMatchObject({ ready: true, candidates: [] });
    expect(asked(run("scan the card list of payees")).some((question) => question.topic === "platform")).toBe(false);

    saveGraph(acmeGraph());
    const mcp = callTool("brief", { request: "a nav bar", answers: { platform: "mobile" } }) as { candidates?: Array<{ name: string }> };
    expect(mcp.candidates?.map((row) => row.name)).toEqual(["Mobile Nav"]);
    const top = callTool("recommend", { intent: "a nav bar", answers: { platform: "Mobile Nav" }, budgetChars: 4000 }) as { candidates?: Array<{ name?: string }> };
    expect(top.candidates?.[0]?.name).toBe("Mobile Nav");
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["brief", "a nav bar", "--answer", "platform=mobile", "--json"]);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(writes.join("")).candidates.map((row: { name: string }) => row.name)).toEqual(["Mobile Nav"]);
  });

  it("does not ask states on a specific request, and offers only states that add a part", () => {
    for (const request of ["summary cards for the order", "the transfers table", "compare rows in a table", "scan the card list of payees"]) {
      expect(asked(run(request)).some((question) => question.topic === "states"), request).toBe(false);
    }
    expect(asked(run("a data table")).map((question) => question.topic)).toEqual(["states"]);
    const index = indexGraph(acmeGraph());
    for (const row of [...labeled.cases, ...fitSet.cases]) {
      const states = asked(run(row.request)).find((question) => question.topic === "states");
      if (!states) continue;
      const card = recommendMasters(index, row.request, { budgetChars: 4000 }) as { candidates?: Array<{ name?: string }> };
      const have = (card.candidates ?? []).slice(0, 3).map((candidate) => candidate.name);
      for (const option of states.options) expect(have, `${row.request}: ${option.label}`).not.toContain(option.label);
    }
  });

  it("asks one list-or-table question on a list ask with no shape named, and each answer picks its part", () => {
    saveGraph(acmeGraph());
    for (const request of ["show all data", "list every data row", "all data"]) {
      const questions = asked(run(request));
      expect(questions.map((question) => question.topic), request).toEqual(["shape"]);
      expect(questions[0]!.options.map((option) => option.label).sort(), request).toEqual(["Card List", "Data Table"]);
      for (const option of questions[0]!.options) {
        const card = callTool("recommend", { intent: request, answers: { shape: option.id }, budgetChars: 4000 }) as { candidates?: Array<{ name?: string }> };
        expect(card.candidates?.[0]?.name, `${request} ${option.id}`).toBe(option.label);
      }
    }
    for (const request of ["show all payments in a table", "all payees as cards", "the compact list of payees"]) {
      expect(asked(run(request)).some((question) => question.topic === "shape"), request).toBe(false);
    }
  });

  it("never asks list or table when recommend finds no part, by category, and says No match", () => {
    const categories: Record<string, string[]> = {
      "off-topic": ["show all the flux capacitors", "all the hologram widgets", "every warp gauge", "a list of quasars"],
      "bare list words": ["all", "every", "all of them", "show all"],
      "typo nouns": ["list all the pymnts", "show all the trnsfrs", "every invcs"],
      "no part in this library": ["show all payments", "a list of invoices", "list all the orders"],
    };
    for (const [category, requests] of Object.entries(categories)) {
      for (const request of requests) {
        const result = run(request);
        expect(asked(result), `${category}: ${request}`).toEqual([]);
        expect(result, `${category}: ${request}`).toMatchObject({ ready: true, skip: "no-match", candidates: [] });
        expect("ready" in result && result.assumptions, `${category}: ${request}`).toEqual([expect.stringMatching(/^No match\. .*brief again/)]);
      }
    }
    for (const request of ["just build all the quasars", "build every flux widget without asking", "no need to ask, list all the pymnts"]) {
      const result = run(request);
      expect(result, request).toMatchObject({ ready: true, skip: "just-build", candidates: [] });
      expect("ready" in result && result.assumptions, request).toEqual([expect.stringMatching(/^No match\./)]);
      expect(JSON.stringify(result), request).not.toMatch(/Assumed data shape/);
    }
  });

  it("reads just build the same way on every call, with words in between", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(run("make it without asking: data table"), String(i)).toMatchObject({ skip: "just-build" });
      expect(run("a data table"), String(i)).toHaveProperty("questions");
    }
    expect(run("build the page without asking")).toMatchObject({ skip: "just-build", candidates: [] });
  });

  it("treats build it without asking as just build, and says no match for a recipe with no filled parts", () => {
    expect(run("build it without asking")).toMatchObject({ skip: "just-build", candidates: [] });
    const empty = briefScreen({
      request: "warp console",
      index: indexGraph(acmeGraph()),
      recipes: [{ id: "warp-console", title: "Warp console", intentAliases: [], slots: [{ role: "flux gauge", required: true, hints: ["flux gauge"] }] }],
    });
    expect(empty).toMatchObject({ ready: true, skip: "no-match", candidates: [] });
    expect("ready" in empty && empty.assumptions[0]).toMatch(/^No match\. .*brief again/);
  });

  it("prints ok:false JSON for bad input with --json, and marks parts from answers as to-add", async () => {
    saveGraph(acmeGraph());
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["brief", "compare rows in a table", "--answer", "shape=spreadsheet", "--json"]);
      await runCli(["handoff", "Activity", "--answer", "goal=pay", "--json"]);
    } finally {
      process.stdout.write = write;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const printed = writes.join("").trim().split(/\n(?=\{)/).map((text) => JSON.parse(text) as { ok: boolean; message: string });
    expect(printed).toHaveLength(2);
    for (const row of printed) expect(row.ok).toBe(false);
    expect(printed[0]!.message).toMatch(/Unknown option/);

    const index = indexGraph(acmeGraph());
    const pack = handoffSheet(index, ["Activity"], {
      recipes: starterRecipes(),
      briefParts: [{ id: "node:10:1", name: "Data Table", fileKey: "ACMEUI", figmaNodeId: "10:1" }],
    });
    if (!pack.ok) throw new Error("handoff refused");
    const added = pack.screens[0]!.components.find((row) => row.name === "Data Table");
    expect(added).toMatchObject({ count: 0, identity: "to-add" });
    const text = formatHandoffScreen(pack.screens[0]!, false);
    expect(text).toContain("**to-add**");
    expect(text).not.toMatch(/Data Table ×1/);
  });

  it("prefers the save family for a save slot, asks no platform on form-and-list asks, and keeps the form ahead of a state", () => {
    saveGraph(acmeGraph());
    const index = indexGraph(acmeGraph());
    const top = (intent: string) => (recommendMasters(index, intent, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates[0]?.name;
    expect(top("save button")).toBe("Save CTA");
    expect(top("primary button")).toBe("Button");
    expect(top("large button")).toBe("Button");
    for (const request of ["a form with a list for tablet", "form plus a list on phone", "a form and a list of rows on desktop"]) {
      expect(asked(run(request)).some((question) => question.topic === "platform"), request).toBe(false);
    }
    expect(top("a list for tablet")).not.toMatch(/Nav/);
    for (const intent of ["a signup form on phone with an error alert", "profile form for tablet with an error alert"]) {
      const card = callTool("recommend", { intent, answers: { shape: "form" }, budgetChars: 4000 }) as { candidates?: Array<{ name?: string }> };
      expect(card.candidates?.[0]?.name, intent).toBe("Text Field");
    }
  });

  it("keeps the form first and asks no platform when a density list leads a form-with-list ask", () => {
    // Same shape as the report: a form plus a list, where the density variants are the used lists.
    const graph = acmeGraph();
    for (const [id, master] of [["1:3", "10:14"], ["1:4", "10:14"], ["1:5", "10:13"]] as const) {
      graph.nodes.push(node(`node:${id}`, "COMPONENT_INSTANCE", "List", { parentId: "node:1:1", figmaNodeId: id, mainComponentId: `node:${master}` }));
      graph.edges.push({ id: `e${id}`, source: `node:${id}`, target: `node:${master}`, type: "INSTANCE_OF" });
    }
    const index = indexGraph(graph);
    const lead = (recommendMasters(index, "a list", { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates[0]?.name;
    expect(lead).toBe("Card List");
    const expectLead = new Map<string, string>([
      ["a form with a list", "Text Field"],
      ["form and list", "Text Field"],
      ["settings form with my trips list, tight deadline", "Text Field"],
    ]);
    for (const request of ["a form with a list", "a signup form with a list of saved cards", "form and list", "settings form with my trips list, tight deadline"]) {
      const result = briefScreen({ request, index, recipes: starterRecipes(), decisions: [decision] });
      expect(asked(result).some((question) => question.topic === "platform"), request).toBe(false);
      const lead = expectLead.get(request);
      if (lead && "ready" in result) expect(result.candidates[0]?.name, request).toBe(lead);
    }
    const names = (recommendMasters(index, "settings form with my trips list, tight deadline", { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates.slice(0, 3).map((row) => row.name);
    expect(names).not.toContain("Compact List");
    expect(names).not.toContain("Comfortable List");
  });

  it("reads density synonyms as compact or comfortable on a list ask", () => {
    const graph = acmeGraph();
    // Comfortable List is the used list, as in the form-with-list case.
    graph.nodes.push(node("node:1:9", "COMPONENT_INSTANCE", "List", { parentId: "node:1:1", figmaNodeId: "1:9", mainComponentId: "node:10:14" }));
    graph.edges.push({ id: "e19", source: "node:1:9", target: "node:10:14", type: "INSTANCE_OF" });
    // A plain List Row part too, so a density word must still pick its density part.
    graph.nodes.push(node("node:10:18", "MAIN_COMPONENT", "List Row", { figmaNodeId: "10:18", isMainComponent: true }));
    const index = indexGraph(graph);
    const brief = (request: string) => briefScreen({ request, index, recipes: starterRecipes(), decisions: [decision] });
    for (const [request, name] of [
      ["a squeezed-in dense list of rows", "Compact List"],
      ["a tight list", "Compact List"],
      ["condensed list view", "Compact List"],
      ["a roomy list", "Comfortable List"],
      ["an airy list of rows", "Comfortable List"],
    ] as const) {
      const result = brief(request);
      expect(asked(result), request).toEqual([]);
      expect("ready" in result && result.candidates[0]?.name, request).toBe(name);
      // Recommend keeps the density part near the top; a literal "rows" may put List Row first.
      const names = (recommendMasters(index, request, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates.slice(0, 3).map((row) => row.name);
      expect(names, request).toContain(name);
      if (!/rows/.test(request)) expect(names[0], request).toBe(name);
    }
  });

  it("counts a density word only when it sits right before list or row", () => {
    const index = indexGraph(acmeGraph());
    const brief = (request: string) => briefScreen({ request, index, recipes: starterRecipes(), decisions: [decision] });
    const density = (request: string) => {
      const result = brief(request);
      return "ready" in result ? result.assumptions.find((line) => /platform and density/.test(line)) : undefined;
    };
    const names = (request: string) => (recommendMasters(index, request, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates.map((row) => row.name);
    // Another part, a deadline, or the listed items: no density read, and no density list offered.
    for (const request of [
      "a cramped-looking tight nav bar",
      "an intake form with a tight turnaround",
      "a list of roomy studio flats",
      "a tight button row label",
      "relaxed card for the promo",
      "my trips list, tight deadline",
      "my trips list, spacious hero",
      "my trips list but airy hero image",
      "my trips list, dense nav bar",
    ]) {
      expect(density(request), request).toBeUndefined();
      expect(names(request).slice(0, 3), request).not.toContain("Compact List");
      expect(names(request).slice(0, 3), request).not.toContain("Comfortable List");
    }
    expect(asked(brief("a cramped-looking tight nav bar")).map((question) => question.topic)).toEqual(["platform"]);
    // Right before list or row it is the density.
    expect(density("a condensed list for the ledger")).toMatch(/compact/);
    expect(density("spacious rows for the settings page")).toMatch(/comfortable/);
  });

  it("reads density said after the list, and not on a row of another part", () => {
    const index = indexGraph(acmeGraph());
    const brief = (request: string) => briefScreen({ request, index, recipes: starterRecipes(), decisions: [decision] });
    const density = (request: string) => {
      const result = brief(request);
      return "ready" in result ? result.assumptions.find((line) => /platform and density/.test(line)) : undefined;
    };
    const top = (request: string) => (recommendMasters(index, request, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates.slice(0, 3).map((row) => row.name);
    // A row of another part: that part wins, and no density list.
    for (const [request, name] of [
      ["a cramped dense row of buttons", "Button"],
      ["airy rows of error alerts under the form", "Error Alert"],
      ["a compact row of buttons", "Button"],
      ["comfortable rows containing error alerts under the form", "Error Alert"],
      ["dense rows full of error alerts under the form", "Error Alert"],
      ["airy rows with error alerts under the form", "Error Alert"],
    ] as const) {
      expect(density(request), request).toBeUndefined();
      expect("ready" in brief(request) && (brief(request) as { candidates: Array<{ name: string }> }).candidates[0]?.name, request).toBe(name);
      expect(top(request), request).not.toContain("Compact List");
      expect(top(request), request).not.toContain("Comfortable List");
    }
    // Density said after the list, joined by a comma, but, or that is.
    for (const [request, word, name] of [
      ["the ledger list, but condensed", "compact", "Compact List"],
      ["a list, but dense", "compact", "Compact List"],
      ["a settings list that is relaxed", "comfortable", "Comfortable List"],
      ["rows that are airy", "comfortable", "Comfortable List"],
      ["a list which is compact please", "compact", "Compact List"],
      ["a list, dense for mobile", "compact", "Compact List"],
      ["a list, roomy on desktop", "comfortable", "Comfortable List"],
      ["a list, compact in ios", "compact", "Compact List"],
      ["a list, airy;", "comfortable", "Comfortable List"],
      ["rows, dense!", "compact", "Compact List"],
      ["payout rows, roomy", "comfortable", "Comfortable List"],
    ] as const) {
      expect(density(request), request).toMatch(word);
      expect("ready" in brief(request) && (brief(request) as { candidates: Array<{ name: string }> }).candidates[0]?.name, request).toBe(name);
    }
    const mobileTop = top("a list, dense on mobile");
    expect(density("a list, dense on mobile")).toMatch(/compact/);
    expect(mobileTop[0]).toBe("Compact List");
    // Without a joint, or on words that are not platform/device words, it is not the list density.
    for (const request of ["a list dense", "a list of tight deadlines", "a list, dense for time", "a list, airy on details", "a list, roomy in notes", "a list, tight for the weekend", "a list, dense for a phone plan", "a list, roomy for tv dinners", "rows, airy on the laptop sleeve", "a list, tight for tablet owners"]) {
      expect(density(request), request).toBeUndefined();
    }
    // A device after for/on/in, plural, with an article, a brand, a screen size, or an orientation still ends the clause.
    for (const [request, word, name] of [
      ["a list, dense for tablets", "compact", "Compact List"],
      ["a list, roomy on the phone", "comfortable", "Comfortable List"],
      ["refund rows, tight on an ipad", "compact", "Compact List"],
      ["a list, airy for small displays", "comfortable", "Comfortable List"],
      ["a list, dense in landscape", "compact", "Compact List"],
      ["a list, spacious in portrait", "comfortable", "Comfortable List"],
    ] as const) {
      expect(density(request), request).toMatch(word);
      expect("ready" in brief(request) && (brief(request) as { candidates: Array<{ name: string }> }).candidates[0]?.name, request).toBe(name);
    }
    // A density word and a desktop word together: brief keeps the density part recommend leads with.
    const withRow = acmeGraph();
    withRow.nodes.push(node("node:10:18", "MAIN_COMPONENT", "List Row", { figmaNodeId: "10:18", isMainComponent: true }));
    const rowIndex = indexGraph(withRow);
    const agree = (request: string, name: string) => {
      const recommended = (recommendMasters(rowIndex, request, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates[0]?.name;
      const result = briefScreen({ request, index: rowIndex, recipes: starterRecipes(), decisions: [decision] });
      expect(recommended, request).toBe(name);
      expect("ready" in result && result.candidates[0]?.name, request).toBe(name);
    };
    agree("list, compact for desktop", "Compact List");
    agree("compact list for desktop", "Compact List");
    agree("comfortable list for desktop", "Comfortable List");
    agree("compact list for phone", "Compact List");
    agree("compact list for tablet", "Compact List");
    // A density word before the head list, with a noun in between, is still that density.
    agree("a dense contact list", "Compact List");
    agree("a roomy task list", "Comfortable List");
    agree("a dense contact list for desktop", "Compact List");
    agree("a roomy task list for desktop", "Comfortable List");
    agree("a compact task list", "Compact List");
    agree("a dense list", "Compact List");
    for (const request of ["a dense contact list", "a roomy task list", "a dense contact list for desktop", "a roomy task list for desktop"]) {
      const result = briefScreen({ request, index: rowIndex, recipes: starterRecipes(), decisions: [decision] });
      expect(asked(result).some((question) => question.topic === "states"), request).toBe(false);
      expect("ready" in result && result.candidates[0]?.name, request).not.toBe("List Row");
    }
    for (const request of ["a tight deadline and a list", "a list of dense documents", "a dense row of buttons"]) {
      const result = briefScreen({ request, index: rowIndex, recipes: starterRecipes(), decisions: [decision] });
      expect("ready" in result && result.candidates[0]?.name, request).not.toBe("Compact List");
      expect("ready" in result && result.candidates[0]?.name, request).not.toBe("Comfortable List");
    }
    // A document sense is empty. A word that only describes the noun asks, and does not commit to a density part.
    for (const request of ["a dense history list", "a dense biography list"]) {
      const recommended = (recommendMasters(rowIndex, request, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates[0]?.name;
      expect(recommended, request).toBeUndefined();
      const result = briefScreen({ request, index: rowIndex, recipes: starterRecipes(), decisions: [decision] });
      expect(asked(result), request).toEqual([]);
      if ("ready" in result) expect(result.candidates, request).toEqual([]);
    }
    for (const request of ["a tight deadline list", "an airy room list", "a compact car list", "a comfortable chair list"]) {
      const recommended = (recommendMasters(rowIndex, request, { budgetChars: 4000 }) as { candidates: Array<{ name?: string }> }).candidates[0]?.name;
      expect(recommended ?? "", request).not.toMatch(/Compact List|Comfortable List/);
      const result = briefScreen({ request, index: rowIndex, recipes: starterRecipes(), decisions: [decision] });
      expect(asked(result).length, request).toBeGreaterThan(0);
      if ("ready" in result) expect(result.candidates[0]?.name, request).not.toMatch(/Compact List|Comfortable List/);
    }
    // The part's own word is never weaker than a synonym: "compact" after the list stays Compact List.
    for (const request of ["a ledger list, compact for phones", "a ledger list, compact for now", "a list, compact in notes"]) {
      expect(top(request)[0], request).toBe("Compact List");
    }
  });
});
