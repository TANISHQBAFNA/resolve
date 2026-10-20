import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-angular.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import {
  AidlcHandoffSchema,
  aidlcExport,
  aidlcJsonSchema,
  briefScreen,
  composeRecipe,
  formatDecisionRecord,
  handoffSheet,
  indexGraph,
  recordFromBrief,
  recordFromCompose,
  recordFromHandoff,
  starterRecipes,
  type ComposeCardLike,
  type DecisionRecord,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, listToolDefinitions } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";
const graph = () => buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });
const SCHEMA = join(__dirname, "..", "schemas", "aidlc-handoff.schema.json");
const SAMPLE = join(__dirname, "..", "fixtures", "aidlc", "acme-sample.json");

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

describe("decision record and AIDLC export", () => {
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
    expect(listToolDefinitions(false).map((tool) => tool.name)).not.toContain("export_aidlc");
    expect(() => callTool("brief", { request: "payee picker", record: "yes" })).toThrow(/record must be true or false/);
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const handoff = callTool("get_handoff", { frame: "Confirm payment", record: true }) as { decisionRecord: string };
    expect(handoff.decisionRecord.endsWith("handoff-confirm-payment.json")).toBe(true);
    expect(existsSync(handoff.decisionRecord.replace(/\.json$/, ".md"))).toBe(true);
  });

  it("export aidlc: validates against the schema, the same from CLI and MCP, and --json errors are ok:false", async () => {
    await cli(["handoff", "Confirm payment", "--out", work]);
    const doc = JSON.parse(await cli(["export", "aidlc", work])) as unknown;
    expect(AidlcHandoffSchema.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({ schemaVersion: 1, kind: "resolve.aidlc", designHandoff: { decisions: { recorded: true } } });
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const { cost: _cost, ...viaMcp } = callTool("export_aidlc", { folder: work }) as { cost: unknown };
    expect(viaMcp).toEqual(doc);
    const out = join(work, "aidlc.json");
    await cli(["export", "aidlc", work, "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(doc);
    const empty = join(work, "empty");
    mkdirSync(empty);
    const error = JSON.parse(await cli(["export", "aidlc", empty, "--json"])) as { ok: boolean; message: string };
    expect(error).toMatchObject({ ok: false });
    expect(error.message).toMatch(/No handoff.json/);
    expect(process.exitCode).toBe(1);
  });

  it("the committed JSON Schema is generated from the zod contract (UPDATE_AIDLC=1 rewrites it)", () => {
    const generated = `${JSON.stringify(aidlcJsonSchema(), null, 2)}\n`;
    if (process.env["UPDATE_AIDLC"] === "1") writeFileSync(SCHEMA, generated);
    expect(readFileSync(SCHEMA, "utf8")).toBe(generated);
  });

  it("the Acme + Angular sample is reproducible and valid (UPDATE_AIDLC=1 rewrites it)", () => {
    const index = indexGraph(graph());
    const pack = handoffSheet(index, ["Confirm payment"], { recipes: starterRecipes() });
    if (!pack.ok) throw new Error("refused");
    const doc = aidlcExport(pack, recordFromHandoff({ pack, createdAt: FROZEN }));
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env["UPDATE_AIDLC"] === "1") {
      mkdirSync(join(SAMPLE, ".."), { recursive: true });
      writeFileSync(SAMPLE, text);
    }
    expect(readFileSync(SAMPLE, "utf8")).toBe(text);
    expect(AidlcHandoffSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(text).not.toMatch(/figma\.com\/(file|design)\//);
  });

  it("records only report what a result already said: compose card in, same parts out", () => {
    const index = indexGraph(graph());
    const out = composeRecipe({ request: "a payee picker and a text field", index, recipes: starterRecipes() });
    const record = recordFromCompose({ request: "a payee picker and a text field", card: out.card as ComposeCardLike, createdAt: FROZEN });
    const cardNames = ((out.card as ComposeCardLike).slots ?? []).flatMap((slot) => (slot.master && slot.status === "filled" ? [slot.master.name] : []));
    expect(record.picks.map((pick) => pick.name)).toEqual(cardNames);
  });
});
