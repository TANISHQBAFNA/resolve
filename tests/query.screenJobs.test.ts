import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approachFor,
  emptySock,
  jobOfName,
  jobsInAsk,
  recordVerifiedUsage,
  screenAskCard,
  starterRecipes,
  type SockState,
} from "@/core/query";
import { formatGaps, readGaps } from "@/server/gaps";
import { clearCache, saveGraph, saveSock } from "@/server/store";
import { callTool, encodeToolResult } from "@/server/tools";
import { graph } from "./fixture";

const at = "2026-10-07T00:00:00.000Z";
const search = { id: "m-search", name: "Search", fileKey: "LIB", figmaNodeId: "10:1" };
const list = { id: "m-list", name: "List", fileKey: "LIB", figmaNodeId: "10:2" };
const header = { id: "m-header", name: "Header", fileKey: "LIB", figmaNodeId: "10:3" };
const icon = { id: "m-icon", name: "Icon", fileKey: "LIB", figmaNodeId: "10:4", nested: true };

/** Three verified inquiry frames sharing Search and List. No master is named Inquiry. */
function inquirySock(): SockState {
  let state = emptySock(3);
  const frames: Array<[string, string, typeof search[]]> = [
    ["LIB:20:1", "Account inquiry", [search, list, header, icon]],
    ["LIB:20:2", "Balance enquiry v2", [search, list, icon]],
    ["LIB:20:3", "Card lookup", [search, list]],
  ];
  for (const [screenId, screenName, masters] of frames) {
    state = recordVerifiedUsage(state, { screenId, screenName, masters, job: jobOfName(screenName), frameId: screenId, verifiedAt: at });
  }
  return state;
}

describe("screen jobs", () => {
  it("classifies a bare screen ask, and leaves a part ask alone", () => {
    expect(jobsInAsk("inquiry screen")).toEqual(["inquiry"]);
    expect(jobsInAsk("summary screen")).toEqual(["summary"]);
    expect(jobsInAsk("approval screen")).toEqual(["approval"]);
    expect(jobsInAsk("Payment Page")).toEqual(["payment"]);
    expect(jobsInAsk("the checkout screen")).toEqual(["payment"]);
    expect(jobsInAsk("approval summary")).toEqual(["approval", "summary"]);
    for (const ask of ["primary button", "payment button", "screen", "payee picker"]) expect(jobsInAsk(ask), ask).toBeUndefined();
  });

  it("tags a frame by the one job its journey or name names", () => {
    expect(jobOfName("Fund transfer - Payment v2")).toBe("payment");
    expect(jobOfName("Payee list")).toBeUndefined();
    expect(jobOfName("Approval summary")).toBeUndefined();
  });

  it("ranks the masters of mapped inquiry screens from SOCK, with ids from the facts", () => {
    const approach = approachFor(inquirySock(), "inquiry");
    expect(approach).toMatchObject({ job: "inquiry", confidence: "strong", mappedScreens: 3 });
    expect(approach.masters.map((row) => [row.name, row.screens, row.figmaNodeId])).toEqual([
      ["Search", 3, "10:1"],
      ["List", 3, "10:2"],
      ["Header", 1, "10:3"],
    ]);
    expect(approach.masters.every((row) => row.fileKey === "LIB")).toBe(true);
  });

  it("classifies an old fact with no job from its screen name, and one mapped screen is low", () => {
    const old = recordVerifiedUsage(emptySock(3), { screenId: "LIB:30:1", screenName: "Loan approval", masters: [header], verifiedAt: at });
    expect(old.facts[0]?.job).toBeUndefined();
    expect(approachFor(old, "approval")).toMatchObject({ confidence: "low", mappedScreens: 1, masters: [{ name: "Header", screens: 1 }] });
  });

  it("an unmapped job answers empty, never a starter recipe or a look-alike part", () => {
    const card = screenAskCard("summary screen", { sock: inquirySock(), recipes: starterRecipes() });
    expect(card?.approaches).toEqual([{ job: "summary", meaning: expect.any(String), confidence: "low", mappedScreens: 0, masters: [] }]);
    expect(card?.hint).toMatch(/No mapped summary screen yet/);
    expect(card).not.toHaveProperty("recipe");
  });

  it("two jobs give both approaches, stronger first; an exact recipe title keeps the recipe", () => {
    const card = screenAskCard("approval inquiry", { sock: inquirySock(), recipes: starterRecipes() });
    expect(card?.approaches.map((row) => row.job)).toEqual(["inquiry", "approval"]);
    expect(screenAskCard("checkout summary", { sock: inquirySock(), recipes: starterRecipes() })).toBeUndefined();
    expect(screenAskCard("primary button", { sock: inquirySock(), recipes: starterRecipes() })).toBeUndefined();
  });
});

describe("screen jobs on the agent path", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-jobs-"));
    clearCache();
    saveGraph(graph);
    saveSock(inquirySock());
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("recommend answers a screen ask from SOCK; a component ask is unchanged", () => {
    const screen = callTool("recommend", { intent: "inquiry screen" }) as { approaches: Array<{ masters: Array<{ name: string }> }> };
    expect(screen.approaches[0]?.masters.map((row) => row.name)).toEqual(["Search", "List", "Header"]);
    const markdown = encodeToolResult(screen);
    for (const id of ["10:1", "10:2", "LIB"]) expect(markdown).toContain(id);
    const part = callTool("recommend", { intent: "primary button" }) as Record<string, unknown>;
    expect(Array.isArray(part["candidates"])).toBe(true);
    expect(part).not.toHaveProperty("approaches");
  });

  it("recipe: a bare job never fills a starter; the exact title still does", () => {
    expect(callTool("recipe", { query: "summary screen" })).toMatchObject({ approaches: [{ job: "summary", masters: [] }] });
    expect(callTool("recipe", { query: "checkout summary" })).toMatchObject({ found: true, recipe: { id: "checkout-summary" } });
  });

  it("logs a screen miss as no mapped screen of that job, not as a missing word or part", () => {
    callTool("recommend", { intent: "approval screen" });
    const rows = readGaps();
    expect(rows).toMatchObject([{ phrase: "approval screen", result: "no-screen", jobs: ["approval"], count: 1 }]);
    const text = formatGaps(rows);
    expect(text).toContain('1x "approval screen": no mapped approval screen yet');
    expect(text).not.toMatch(/synonyms\.json/);
  });
});
