import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import acmeFile from "../../../docs/examples/acme-ui.json";
import angularMap from "../../../docs/examples/acme-code-map-selectors.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { handoffSheet, indexGraph, recordFromHandoff, starterRecipes, type DecisionRecord } from "@/core/query";
import { registerAddonCommand } from "@/server/addonHook";
import { runCli } from "@/server/cli";
import { listToolDefinitions } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";
import { AidlcHandoffSchema, aidlcExport, aidlcJsonSchema } from "../src/contract";
import { runExport } from "../src/exportCommand";
import { callTool } from "../src/mcp";

registerAddonCommand("export", runExport);

const FROZEN = "2026-01-01T00:00:00.000Z";
const graph = () => buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });
const SCHEMA = join(__dirname, "..", "schema", "aidlc-handoff.schema.json");
const SAMPLE = join(__dirname, "..", "fixtures", "acme-sample.json");
const DOC = join(__dirname, "..", "docs", "AIDLC.md");

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

  it("default MCP surface does not list export_aidlc", () => {
    expect(listToolDefinitions(false).map((tool) => tool.name)).not.toContain("export_aidlc");
  });

  it("the handoff command note still names the export", () => {
    const text = readFileSync(join(__dirname, "..", "commands", "handoff.md"), "utf8");
    const spec = "npx -y -p github:TANISHQBAFNA/resolve#v0.1.3";
    expect(text).toContain(`${spec} resolve-figma export aidlc`);
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
        const doc = readFileSync(DOC, "utf8");
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

    it("L3: compose --record into a file with --json is ok:false naming it; export_aidlc without a folder is a clear error", async () => {
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      expect(() => callTool("export_aidlc", {})).toThrow(/export_aidlc needs folder/);
      expect(() => callTool("export_aidlc", { folder: "  " })).toThrow(/never uses the current folder/);
      expect(() => callTool("export_aidlc", { folder: join(work, "nowhere") })).toThrow(new RegExp(`No handoff.json in ${join(work, "nowhere")}`));
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
      const doc = readFileSync(DOC, "utf8");
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
