import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-selectors.json";
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
    expect(handoff.decisionRecord).toMatch(/handoff-confirm-payment-[0-9a-f]{10}\.json$/);
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
  describe("Michigan #70 r1, negative cases", () => {
    const handoffFolder = async () => {
      await cli(["handoff", "Confirm payment", "--out", work]);
      return JSON.parse(readFileSync(join(work, "decision.json"), "utf8")) as DecisionRecord;
    };
    const exportError = async () => JSON.parse(await cli(["export", "aidlc", work, "--json"])) as { ok: boolean; message: string };

    it("M1: the contract uses enums for match, source, identity, status, codeStatus, matchedBy and answers", () => {
      const schema = JSON.stringify(aidlcJsonSchema());
      for (const values of [
        ["fit", "bound", "placed", "to-add", "weak", "name-guess"],
        ["brief", "answer", "recipe", "decision", "compose", "placed"],
        ["confirmed", "name-guess", "not-found", "to-add"],
        ["current", "retired", "not-found", "other-library"],
        ["mapped", "unmapped", "unknown"],
        ["asked", "screen name"],
        ["table", "cards", "form", "summary", "counts"],
        ["empty", "loading", "error", "pending"],
      ]) {
        expect(schema, values.join()).toContain(`"enum":${JSON.stringify(values)}`);
        // The docs table lists the same values.
        const doc = readFileSync(join(__dirname, "..", "docs", "AIDLC.md"), "utf8");
        for (const value of values) expect(doc, value).toContain(`\`${value}\``);
      }
      const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as { designHandoff: { screens: Array<{ parts: Array<Record<string, unknown>> }> } };
      sample.designHandoff.screens[0]!.parts[0]!["identity"] = "sort-of";
      expect(AidlcHandoffSchema.safeParse(sample).success).toBe(false);
      const none = JSON.parse(readFileSync(SAMPLE, "utf8")) as { designHandoff: { screens: unknown[] } };
      none.designHandoff.screens = [];
      expect(AidlcHandoffSchema.safeParse(none).success).toBe(false);
    });

    it("M2: export refuses a record with the wrong version or kind, junk, other screens, or a pick that is not in handoff.json", async () => {
      const good = await handoffFolder();
      const cases: Array<[string, unknown, RegExp]> = [
        ["version 2", { ...good, schemaVersion: 2 }, /not a decision record/],
        ["brief kind", { ...good, kind: "brief" }, /brief record, not a handoff record/],
        ["junk object", { hello: "world" }, /not a decision record/],
        ["other screen", { ...good, screens: ["Somewhere else"] }, /is for Somewhere else, but handoff.json is for Confirm payment/],
        ["made-up pick", { ...good, picks: [...good.picks, { name: "Hover Board", fileKey: "ACMEUI", figmaNodeId: "99:99", source: "placed", match: "placed", screen: "Confirm payment" }] }, /picks "Hover Board" \(99:99\) on Confirm payment, which is not a part in handoff.json/],
        ["unknown match value", { ...good, picks: [{ ...good.picks[0]!, match: "pretty sure" }] }, /not a decision record/],
      ];
      for (const [label, record, message] of cases) {
        writeFileSync(join(work, "decision.json"), JSON.stringify(record));
        const error = await exportError();
        expect(error.ok, label).toBe(false);
        expect(error.message, label).toMatch(message);
        expect(process.exitCode, label).toBe(1);
        process.exitCode = undefined;
      }
      writeFileSync(join(work, "decision.json"), "{not json");
      expect((await exportError()).message).toMatch(/decision.json in .* is not JSON/);
      writeFileSync(join(work, "handoff.json"), JSON.stringify({ ok: true, screens: [] }));
      expect((await exportError()).message).toMatch(/not a passing handoff with screens/);
    });

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

    it("L3: compose --record into a file with --json is ok:false naming it; export_aidlc without a folder is a clear error", async () => {
      const notFolder = join(work, "plain.txt");
      writeFileSync(notFolder, "x");
      const error = JSON.parse(await cli(["recipe", "a payee picker and a text field", "--compose", "--json", "--record", notFolder])) as { ok: boolean; message: string };
      expect(error).toMatchObject({ ok: false });
      expect(error.message).toContain(`Cannot write the decision record to ${notFolder}`);
      process.exitCode = undefined;
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      expect(() => callTool("export_aidlc", {})).toThrow(/export_aidlc needs folder/);
      expect(() => callTool("export_aidlc", { folder: "  " })).toThrow(/never uses the current folder/);
      expect(() => callTool("export_aidlc", { folder: join(work, "nowhere") })).toThrow(new RegExp(`No handoff.json in ${join(work, "nowhere")}`));
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
    const folderWithRecord = async () => {
      await cli(["handoff", "Confirm payment", "--out", work]);
      return JSON.parse(readFileSync(join(work, "decision.json"), "utf8")) as DecisionRecord;
    };
    const exportWith = async (record: unknown) => {
      writeFileSync(join(work, "decision.json"), JSON.stringify(record));
      const out = JSON.parse(await cli(["export", "aidlc", work, "--json"])) as { ok?: boolean; message?: string };
      process.exitCode = undefined;
      return out;
    };

    it("L5: a pick with a changed id, match or why, a duplicate, or a dropped pick is refused", async () => {
      const good = await folderWithRecord();
      const first = good.picks[0]!;
      const cases: Array<[string, DecisionRecord, RegExp]> = [
        ["fake id", { ...good, picks: [{ ...first, id: "node:made-up" }, ...good.picks.slice(1)] }, /changes id of "/],
        ["edited match", { ...good, picks: [{ ...first, match: "weak" }, ...good.picks.slice(1)] }, /changes match of "/],
        ["edited why", { ...good, picks: [{ ...first, why: "Because I said so." }, ...good.picks.slice(1)] }, /changes why of ".*handoff.json gives/],
        ["duplicate", { ...good, picks: [first, ...good.picks] }, /picks ".*" .* twice\./],
        ["dropped", { ...good, picks: good.picks.slice(1) }, /has \d+ picks, but handoff.json has \d+ parts/],
        ["edited rejected", { ...good, rejected: [{ what: "Old Button", reason: "retired" }] }, /rejects different parts/],
      ];
      for (const [label, record, message] of cases) {
        const out = await exportWith(record);
        expect(out.ok, label).toBe(false);
        expect(out.message, label).toMatch(message);
      }
      expect((await exportWith(good)).ok, "the untouched record still exports").not.toBe(false);
    });

    it("L7: export refuses edited handoff context fields (request, assumptions, openQuestions, asked, answers); untouched still exports", async () => {
      const good = await folderWithRecord();
      const cases: Array<[string, DecisionRecord, RegExp]> = [
        ["emptied openQuestions", { ...good, openQuestions: [] }, /changes openQuestions/],
        ["added assumption", { ...good, assumptions: [...good.assumptions, "manual note"] }, /changes assumptions/],
        ["added request", { ...good, request: "manual request" }, /changes request/],
        ["added asked", { ...good, asked: [{ topic: "shape", prompt: "Which shape?", options: ["cards"] }] }, /changes asked/],
        ["added answers", { ...good, answers: { states: ["empty"] } }, /changes answers/],
      ];
      for (const [label, record, message] of cases) {
        const out = await exportWith(record);
        expect(out.ok, label).toBe(false);
        expect(out.message, label).toMatch(message);
      }
      expect((await exportWith(good)).ok, "the untouched record still exports").not.toBe(false);
    });

    it("M1 regression: handoff --answer exports through CLI + MCP, and tampered answers are still refused", async () => {
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      await cli(["handoff", "Confirm payment", "--answer", "platform=mobile", "--out", work, "--force"]);
      const handoff = JSON.parse(readFileSync(join(work, "handoff.json"), "utf8")) as { answers?: { platform?: string; states: string[] } };
      expect(handoff.answers).toMatchObject({ platform: "mobile", states: [] });

      const doc = JSON.parse(await cli(["export", "aidlc", work])) as { requirementsContext: { answers?: { platform?: string; states: string[] } } };
      expect(doc.requirementsContext.answers).toMatchObject({ platform: "mobile", states: [] });
      const { cost: _cost, ...viaMcp } = callTool("export_aidlc", { folder: work }) as { cost: unknown; requirementsContext: { answers?: { platform?: string; states: string[] } } };
      expect(viaMcp).toEqual(doc);

      const good = JSON.parse(readFileSync(join(work, "decision.json"), "utf8")) as DecisionRecord;
      const tampered = { ...good, answers: { ...(good.answers ?? { states: [] }), platform: "desktop", states: good.answers?.states ?? [] } };
      writeFileSync(join(work, "decision.json"), JSON.stringify(tampered));
      const out = JSON.parse(await cli(["export", "aidlc", work, "--json"])) as { ok: boolean; message: string };
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/changes answers/);
      process.exitCode = undefined;
    });

    it("Info: AIDLC.md names every rejected reason a record can carry", () => {
      const doc = readFileSync(join(__dirname, "..", "docs", "AIDLC.md"), "utf8");
      for (const reason of ["weak, check", "no match in the learned library", "retired", "not a library component", "not found in the learned files", "saved recipe <title> already covers this"]) {
        expect(doc, reason).toContain(`\`${reason}\``);
      }
    });

    it("L6: export --out into a missing or existing folder, and handoff --out into a used folder, give clear errors (ok:false with --json)", async () => {
      await folderWithRecord();
      const missing = join(work, "no-such-folder", "aidlc.json");
      const message = `Cannot write ${missing}: the folder ${join(work, "no-such-folder")} does not exist.`;
      const plain = await cli(["export", "aidlc", work, "--out", missing]).then(() => "", (error: Error) => error.message);
      expect(plain).toBe(message);
      const jsonMissing = JSON.parse(await cli(["export", "aidlc", work, "--out", missing, "--json"])) as { ok: boolean; message: string };
      expect(jsonMissing).toMatchObject({ ok: false, message });
      expect(jsonMissing.message).not.toMatch(/ENOENT|ENOTDIR|EISDIR/);
      process.exitCode = undefined;
      const jsonFolder = JSON.parse(await cli(["export", "aidlc", work, "--out", work, "--json"])) as { ok: boolean; message: string };
      expect(jsonFolder).toMatchObject({ ok: false, message: `Cannot write ${work}: it is a folder. Pass a file name, for example --out aidlc.json.` });
      process.exitCode = undefined;
      const used = JSON.parse(await cli(["handoff", "Confirm payment", "--out", work, "--json"])) as { ok: boolean; message: string };
      expect(used).toMatchObject({ ok: false });
      expect(used.message).toMatch(/already has handoff files \(.*\)\. Add --force to replace them\./);
      expect(process.exitCode).toBe(1);
    });

    it("Info: export --out to /proc says the folder cannot be written", async () => {
      await folderWithRecord();
      if (!existsSync("/proc")) return;
      const target = "/proc/resolve-aidlc.json";
      const out = JSON.parse(await cli(["export", "aidlc", work, "--out", target, "--json"])) as { ok: boolean; message: string };
      expect(out.ok).toBe(false);
      expect(out.message).toBe(`Cannot write ${target}: the folder /proc cannot be written.`);
      expect(out.message).not.toContain("does not exist");
      process.exitCode = undefined;
    });

    it("L8: export accepts a decision.json file that starts with a UTF-8 BOM", async () => {
      const good = await folderWithRecord();
      writeFileSync(join(work, "decision.json"), `\uFEFF${JSON.stringify(good)}`);
      const out = JSON.parse(await cli(["export", "aidlc", work, "--json"])) as { ok?: boolean; schemaVersion?: number };
      expect(out.ok, "BOM should not break parsing").not.toBe(false);
      expect(out.schemaVersion).toBe(1);
    });
  });
});
