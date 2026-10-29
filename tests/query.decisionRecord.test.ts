import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-selectors.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import {
  briefScreen,
  composeRecipe,
  formatDecisionRecord,
  indexGraph,
  recordFromBrief,
  recordFromCompose,
  starterRecipes,
  type ComposeCardLike,
  type DecisionRecord,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";
const graph = () => buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });

async function cli(argv: string[]): Promise<string> {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli(argv);
  } finally {
    process.stdout.write = write;
  }
  return writes.join("");
}

/** Every pick names a real node: by graph id, or by file key + Figma id. */
function assertRealPicks(record: DecisionRecord) {
  const g = graph();
  const ids = new Set(g.nodes.map((node) => node.id));
  const figma = new Set(g.nodes.map((node) => `${node.fileKey}:${node.figmaNodeId}`));
  for (const pick of record.picks) {
    const known = (pick.id && ids.has(pick.id)) || (pick.figmaNodeId && figma.has(`${pick.fileKey}:${pick.figmaNodeId}`));
    expect(known, JSON.stringify(pick)).toBeTruthy();
  }
}

describe("decision record", () => {
  const previous = { home: process.env["RESOLVE_HOME"], advanced: process.env["RESOLVE_MCP_ADVANCED"] };
  let home: string;
  let work: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-decision-"));
    work = mkdtempSync(join(tmpdir(), "resolve-decision-out-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(graph());
    writeFileSync(join(home, "code-map.json"), JSON.stringify(angularMap));
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    for (const [key, value] of [["RESOLVE_HOME", previous.home], ["RESOLVE_MCP_ADVANCED", previous.advanced]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("brief: --record writes the record, stdout is unchanged, and nothing is written without the flag", async () => {
    const plain = await cli(["brief", "pick a payee with the payee picker", "--json"]);
    expect(readdirSync(work)).toEqual([]);
    const recorded = await cli(["brief", "pick a payee with the payee picker", "--json", "--record", work]);
    expect(recorded).toBe(plain);
    expect(readdirSync(work).sort()).toEqual(["decision-brief.json", "decision-brief.md"]);
    const record = JSON.parse(readFileSync(join(work, "decision-brief.json"), "utf8")) as DecisionRecord;
    expect(record).toMatchObject({ schemaVersion: 1, kind: "brief", request: "pick a payee with the payee picker" });
    expect(record.picks.map((pick) => pick.name)).toContain("Payee picker");
    assertRealPicks(record);
    expect(readFileSync(join(work, "decision-brief.md"), "utf8")).toContain("# Decision record (brief)");
  });

  it("brief with no match records the rejection and picks nothing", () => {
    const index = indexGraph(graph());
    const result = briefScreen({ request: "a warp drive gauge", index, recipes: starterRecipes() });
    const record = recordFromBrief({ request: "a warp drive gauge", result, createdAt: FROZEN });
    expect(record.picks).toEqual([]);
    expect(record.rejected).toEqual([{ what: "a warp drive gauge", reason: "no match in the learned library" }]);
    expect(formatDecisionRecord(record)).toContain("No part was picked. Nothing was invented.");
  });

  it("compose: picks, weak and no-match parts, through the CLI and the same record from MCP", async () => {
    const request = "payment page with a payee picker, a velvet avatar, a text field and a flux gauge";
    await cli(["recipe", request, "--compose", "--json", "--record", work]);
    const record = JSON.parse(readFileSync(join(work, "decision-compose.json"), "utf8")) as DecisionRecord;
    expect(record.picks.map((pick) => pick.name)).toEqual(["Payee picker", "Text field"]);
    expect(record.rejected.map((row) => row.what)).toEqual(["velvet-avatar: Avatar", "flux-gauge"]);
    expect(record.recipe).toMatchObject({ id: "composed-payment-page", how: "composed" });
    assertRealPicks(record);

    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const card = callTool("recipe", { query: request, compose: true, record: true }) as { decisionRecord: string };
    expect(card.decisionRecord.startsWith(join(home, "decisions", "compose-payment-page-with-a-payee-picker"))).toBe(true);
    const { cost: _cost, ...viaMcp } = callTool("decision_record", { ref: card.decisionRecord }) as DecisionRecord & { cost: unknown };
    expect({ ...viaMcp, createdAt: "x" }).toEqual({ ...record, createdAt: "x" });
  });

  it("handoff --out writes decision.json and decision.md next to the handoff; --no-record writes none and removes an old one", async () => {
    await cli(["handoff", "Confirm payment", "--out", work]);
    expect(readdirSync(work)).toEqual(expect.arrayContaining(["decision.json", "decision.md", "handoff.json"]));
    const record = JSON.parse(readFileSync(join(work, "decision.json"), "utf8")) as DecisionRecord;
    expect(record).toMatchObject({ kind: "handoff", screens: ["Confirm payment"] });
    expect(record.picks.length).toBeGreaterThan(0);
    assertRealPicks(record);
    await cli(["handoff", "Confirm payment", "--out", work, "--force", "--no-record"]);
    expect(existsSync(join(work, "decision.json"))).toBe(false);
    expect(existsSync(join(work, "decision.md"))).toBe(false);
  });

  it("MCP record works only on the advanced surface, adds only a path, and rejects a non-boolean", () => {
    const plain = callTool("brief", { request: "pick a payee with the payee picker", record: true }) as { decisionRecord: string };
    expect(plain.decisionRecord).toMatch(/advanced surface/);
    expect(existsSync(join(home, "decisions"))).toBe(false);
    expect(() => callTool("brief", { request: "payee picker", record: "yes" })).toThrow(/record must be true or false/);
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const handoff = callTool("get_handoff", { frame: "Confirm payment", record: true }) as { decisionRecord: string };
    expect(handoff.decisionRecord).toMatch(/handoff-confirm-payment-[0-9a-f]{10}\.json$/);
    expect(existsSync(handoff.decisionRecord.replace(/\.json$/, ".md"))).toBe(true);
  });

  it("records only report what a result already said: compose card in, same parts out", () => {
    const index = indexGraph(graph());
    const out = composeRecipe({ request: "a payee picker and a text field", index, recipes: starterRecipes() });
    const record = recordFromCompose({ request: "a payee picker and a text field", card: out.card as ComposeCardLike, createdAt: FROZEN });
    const cardNames = ((out.card as ComposeCardLike).slots ?? []).flatMap((slot) => (slot.master && slot.status === "filled" ? [slot.master.name] : []));
    expect(record.picks.map((pick) => pick.name)).toEqual(cardNames);
  });
  describe("Michigan #70 r1, negative cases", () => {
    const handoffFolder = async () => {
      await cli(["handoff", "Confirm payment", "--out", work]);
      return JSON.parse(readFileSync(join(work, "decision.json"), "utf8")) as DecisionRecord;
    };
    it("L1: decision_record reads only stored records or decision*.json files, and checks them", async () => {
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      const other = join(work, "notes.json");
      writeFileSync(other, JSON.stringify({ secret: 1 }));
      expect(() => callTool("decision_record", { ref: other })).toThrow(/is not a decision record Resolve wrote/);
      expect(() => callTool("decision_record", { ref: "../../notes" })).toThrow(/is not a decision record Resolve wrote/);
      expect(() => callTool("decision_record", { ref: "/etc/hosts" })).toThrow(/is not a decision record Resolve wrote/);
      const fake = join(work, "decision-fake.json");
      writeFileSync(fake, JSON.stringify({ schemaVersion: 1, kind: "handoff" }));
      expect(() => callTool("decision_record", { ref: fake })).toThrow(/decision-fake.json is not a decision record/);
      await handoffFolder();
      const { cost: _cost, ...beside } = callTool("decision_record", { ref: join(work, "decision.json") }) as DecisionRecord & { cost: unknown };
      expect(beside.kind).toBe("handoff");
    });

    it("L2: records can be listed, --record does not overwrite without --force, and long requests get unique names", async () => {
      await cli(["brief", "pick a payee with the payee picker", "--json", "--record", work]);
      const again = JSON.parse(await cli(["brief", "pick a payee with the payee picker", "--json", "--record", work])) as { ok: boolean; message: string };
      expect(again).toMatchObject({ ok: false });
      expect(again.message).toMatch(/already has decision-brief.json\. Add --force/);
      process.exitCode = undefined;
      await cli(["brief", "pick a payee with the payee picker", "--json", "--record", work, "--force"]);
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      const long = "a very long screen request about choosing who to pay from the saved list of people";
      const first = callTool("brief", { request: `${long} with the payee picker`, record: true }) as { decisionRecord: string };
      const second = callTool("brief", { request: `${long} with a button`, record: true }) as { decisionRecord: string };
      expect(first.decisionRecord).not.toBe(second.decisionRecord);
      const { cost: _cost, ...listed } = callTool("decision_record", {}) as { records: Array<{ file: string }>; cost: unknown };
      expect(listed.records.map((row) => row.file).sort()).toEqual([first.decisionRecord, second.decisionRecord].map((path) => path.split("/").pop()).sort());
      expect(await cli(["decisions"])).toContain("brief");
    });

    it("L3: compose --record into a file with --json is ok:false naming it", async () => {
      const notFolder = join(work, "plain.txt");
      writeFileSync(notFolder, "x");
      const error = JSON.parse(await cli(["recipe", "a payee picker and a text field", "--compose", "--json", "--record", notFolder])) as { ok: boolean; message: string };
      expect(error).toMatchObject({ ok: false });
      expect(error.message).toContain(`Cannot write the decision record to ${notFolder}`);
    });

    it("L4: a weak match the compose card shows is listed under rejected, also in a one-part answer", () => {
      const index = indexGraph(graph());
      for (const request of ["sheet with a velvet avatar and a payee picker", "sheet with a velvet avatar, a payee picker and a text field"]) {
        const out = composeRecipe({ request, index, recipes: starterRecipes() });
        const card = out.card as ComposeCardLike;
        expect(card.weak, request).toEqual(["velvet-avatar: Avatar (weak, check)"]);
        const record = recordFromCompose({ request, card, createdAt: FROZEN });
        expect(record.rejected, request).toContainEqual({ what: "velvet-avatar: Avatar", reason: "weak, check" });
        expect(record.rejected.filter((row) => row.what.startsWith("velvet-avatar")), request).toHaveLength(1);
      }
    });
  });
  describe("Michigan #70 r2, negative cases", () => {
    it("L6: handoff --out into a used folder gives a clear error (ok:false with --json)", async () => {
      await cli(["handoff", "Confirm payment", "--out", work]);
      const used = JSON.parse(await cli(["handoff", "Confirm payment", "--out", work, "--json"])) as { ok: boolean; message: string };
      expect(used).toMatchObject({ ok: false });
      expect(used.message).toMatch(/already has handoff files \(.*\)\. Add --force to replace them\./);
      expect(process.exitCode).toBe(1);
    });
  });
});
