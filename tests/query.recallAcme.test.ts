import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, NodeType } from "@/core/model";
import { indexGraph, recommendMasters } from "@/core/query";
import { scorePhrases, type PhraseCase } from "@/core/query/phraseScore";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

/**
 * Fresh Acme phrases, written before any score. The split is a hash of the id.
 * Tune on the even half. The odd half is held out and is not used to change ranking.
 */
const CASES: PhraseCase[] = [
  { id: "acme-buttons", type: "recall", phrase: "buttons", expect: ["Button"] },
  { id: "acme-cards", type: "recall", phrase: "cards", expect: ["Card"] },
  { id: "acme-big", type: "recall", phrase: "big button", expect: ["Button"] },
  { id: "acme-action", type: "recall", phrase: "main action", expect: ["Button"] },
  { id: "acme-heading", type: "recall", phrase: "page heading", expect: ["Header"] },
  { id: "acme-photo", type: "recall", phrase: "person photo", expect: ["Avatar"] },
  { id: "acme-find", type: "recall", phrase: "find box", expect: ["Search field"] },
  { id: "acme-switch", type: "recall", phrase: "on off switch", expect: ["Switch"] },
  { id: "acme-tick", type: "recall", phrase: "tick box", expect: ["Checkbox"] },
  { id: "acme-popup", type: "recall", phrase: "popup window", expect: ["Modal"] },
  { id: "acme-notice", type: "recall", phrase: "warning notice", expect: ["Alert"] },
  { id: "acme-money", type: "recall", phrase: "money figure", expect: ["Price"] },
  { id: "acme-rule", type: "recall", phrase: "hairline rule", expect: ["Divider"] },
  { id: "acme-link", type: "recall", phrase: "hyperlink", expect: ["Link"] },
  { id: "acme-snack", type: "recall", phrase: "snackbar", expect: ["Toast"] },
  { id: "acme-textbox", type: "recall", phrase: "text box", expect: ["Text field"] },
  { id: "acme-dialog", type: "recall", phrase: "dialog window", expect: ["Modal"] },
  { id: "acme-nav", type: "recall", phrase: "navigation item", expect: ["Nav item"] },
  { id: "acme-drop", type: "recall", phrase: "drop down", expect: ["Dropdown"] },
  { id: "acme-glyph", type: "recall", phrase: "home glyph", expect: ["Home"] },
  { id: "acme-symbol", type: "recall", phrase: "settings symbol", expect: ["Settings"] },
  { id: "acme-chevrons", type: "recall", phrase: "chevrons", expect: ["Chevron down"] },
  { id: "acme-picture", type: "recall", phrase: "user picture", expect: ["Avatar"] },
  { id: "acme-blank", type: "recall", phrase: "blank state", expect: ["Empty message"] },
  { id: "acme-cost", type: "recall", phrase: "cost figure", expect: ["Price"] },
  { id: "acme-line", type: "recall", phrase: "separator line", expect: ["Divider"] },
  { id: "acme-tabs", type: "recall", phrase: "tabs", expect: ["Tabs"] },
  { id: "acme-input", type: "recall", phrase: "input box", expect: ["Text field"] },
  { id: "acme-profile", type: "recall", phrase: "profile photo", expect: ["Avatar"] },
  { id: "acme-dismiss", type: "recall", phrase: "dismiss icon", expect: ["Icon close"] },
];

function heldOut(id: string): boolean {
  const digest = createHash("sha256").update(id).digest();
  return (digest[0] ?? 0) % 2 === 1;
}

function acmeIndex() {
  const names = [
    "Button",
    "Card",
    "Account summary card",
    "Bottom action bar",
    "Search field",
    "Banner",
    "Dropdown",
    "Nav item",
    "Text field",
    "Checkbox",
    "Modal",
    "Tabs",
    "Badge",
    "Toast",
    "Avatar",
    "List row",
    "Footer bar",
    "Header",
    "Switch",
    "Alert",
    "Link",
    "Divider",
    "Price",
    "Radio",
    "Empty message",
    "Icon close",
  ];
  const nodes: GraphNode[] = [
    n("file", "FILE", "Acme UI"),
    n("page", "PAGE", "Controls", { parentId: "file" }),
    n("icons", "PAGE", "Icons", { parentId: "file" }),
  ];
  const edges: GraphEdge[] = [e("CONTAINS", "file", "page"), e("CONTAINS", "file", "icons")];
  names.forEach((name, i) => {
    const id = `part-${i}`;
    nodes.push(n(id, "MAIN_COMPONENT", name, { parentId: "page", figmaNodeId: `1:${i + 1}`, isMainComponent: true }));
    edges.push(e("CONTAINS", "page", id));
  });
  for (const [id, name, fig] of [
    ["home", "Home", "9:1"],
    ["settings", "Settings", "9:2"],
    ["chevron", "Chevron down", "9:3"],
  ] as const) {
    nodes.push(
      n(id, "MAIN_COMPONENT", name, {
        parentId: "icons",
        pageId: "icons",
        figmaNodeId: fig,
        isRemote: true,
        isMainComponent: true,
      }),
    );
    edges.push(e("CONTAINS", "icons", id));
  }
  return indexGraph({
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    schemaVersion: 1,
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  });
}

export function recallHalves(): { tune: PhraseCase[]; held: PhraseCase[] } {
  const tune: PhraseCase[] = [];
  const held: PhraseCase[] = [];
  for (const row of CASES) (heldOut(row.id) ? held : tune).push(row);
  return { tune, held };
}

describe("fresh Acme recall", () => {
  it("splits thirty phrases into two halves and scores both", () => {
    expect(CASES).toHaveLength(30);
    const { tune, held } = recallHalves();
    expect(tune.length).toBeGreaterThan(0);
    expect(held.length).toBeGreaterThan(0);
    expect(tune.length + held.length).toBe(30);
    const index = acmeIndex();
    const workspace = { version: 1 as const, files: [{ role: "library" as const, key: "ACMEUI", label: "Acme UI" }] };
    const score = (rows: PhraseCase[]) => scorePhrases(index, rows, { workspace });
    const tuned = score(tune);
    const heldOutReport = score(held);
    if (process.env["RECALL_LOG"] === "1") {
      const lines = tuned.misses.map((miss) => `${miss.id}\t${miss.phrase}\t${miss.kind}\t${miss.detail}`);
      process.stdout.write(`TUNE top1 ${tuned.totals.top1}/${tuned.totals.matchCases} top3 ${tuned.totals.top3}/${tuned.totals.matchCases}\n${lines.join("\n")}\n`);
      process.stdout.write(`HELD top1 ${heldOutReport.totals.top1}/${heldOutReport.totals.matchCases} top3 ${heldOutReport.totals.top3}/${heldOutReport.totals.matchCases}\n`);
    }
    const top3 = (report: typeof tuned) => `${report.totals.top3}/${report.totals.matchCases}`;
    expect(tuned.totals.invented).toBe(0);
    expect(heldOutReport.totals.invented).toBe(0);
    expect(tuned.totals.top1).toBe(12);
    expect(tuned.totals.top3).toBe(12);
    expect(heldOutReport.totals.top1).toBe(18);
    expect(heldOutReport.totals.top3).toBe(18);
    expect(top3(tuned)).toBe("12/12");
    expect(top3(heldOutReport)).toBe("18/18");
    expect(recommendMasters(index, tune[0]?.phrase ?? "buttons", { workspace }).candidates.length).toBeGreaterThan(0);
  });
});
