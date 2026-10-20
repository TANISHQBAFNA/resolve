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

it("probe", () => {
  const reqs = ["show my payments","list of transactions","account balances","payees","transfer history","invoice details","order overview","payments","transactions table","the transactions","payment history table","dashboard of balances","customer list","a list of orders","show the orders","results of the search","balances","recent payments for the account","search the payees","new payee form","payment review","card lists of payees","table of payments","summary card","data tables","pay ctas","Card Lists","the balance stats","payment","an alert"];
  for (const r of reqs) {
    const res = run(r);
    const lead = recommendMasters(indexGraph(acmeGraph()), r, { budgetChars: 4000 }) as any;
    console.log(r.padEnd(34), "|", JSON.stringify(res).slice(0, 180), "| REC", lead.match, (lead.candidates ?? []).slice(0,3).map((c: any) => c.name).join(","));
  }
});
