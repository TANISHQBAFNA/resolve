import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/server/cli";
import { BRIEF_EXIT } from "@/core/query/designBrief";
import { clearCache } from "@/server/store";

const EXAMPLE_PATH = "examples/design-brief/acme-approval/brief.md";
const EXAMPLE = readFileSync(EXAMPLE_PATH, "utf8");

async function run(args: string[]): Promise<{ out: string; code: number }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli(["brief", "check", ...args]);
  } finally {
    process.stdout.write = write;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: chunks.join(""), code };
}

describe("resolve brief check", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolve-brief-"));
    process.env["RESOLVE_HOME"] = join(dir, "store");
    clearCache();
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  const brief = (text: string) => {
    const file = join(dir, "brief.md");
    writeFileSync(file, text);
    return file;
  };

  it("exits 0 on the Acme example and prints PASS", async () => {
    const { out, code } = await run([EXAMPLE_PATH]);
    expect(code).toBe(0);
    expect(out).toMatch(/^Brief check: PASS \(brief\)/);
  });

  it("exits with a distinct code per failure type and lists the problem", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["frontmatter", EXAMPLE.replace(/^ticket: .*\n/m, ""), /\[frontmatter\] ticket/],
      ["screens", EXAMPLE.replace("N/A — the list has no submit action, so there is nothing to confirm.", "N/A"), /\[screens\].*no reason/],
      ["fields", EXAMPLE.replace("| Up to 15 digits | contract |", "| Up to 15 digits |  |"), /\[fields\].*Provenance is empty/],
      ["questions", EXAMPLE.replace("| Yes, in the maker's payment history. |", "|  |"), /\[questions\] Open questions row 2: Unanswered/],
      ["status", EXAMPLE.replace("status: complete", "status: draft"), /\[status\]/],
    ];
    const seen = new Set<number>();
    for (const [type, text, message] of cases) {
      const { out, code } = await run([brief(text)]);
      expect(code, type).toBe(BRIEF_EXIT[type as keyof typeof BRIEF_EXIT]);
      expect(out, type).toMatch(/^Brief check: FAIL/);
      expect(out, type).toMatch(message);
      seen.add(code);
    }
    expect(seen.size).toBe(cases.length);
  });

  it("passes a handoff pack folder, and fails a draft one", async () => {
    const pack = { ok: true, handoff: 1, draft: false, codeMap: false, screens: [{ name: "Confirm payment", verify: { pass: true } }], ingredients: [] };
    const folder = join(dir, "handoff");
    mkdirSync(folder);
    writeFileSync(join(folder, "handoff.json"), JSON.stringify(pack));
    expect(await run([folder])).toMatchObject({ code: 0 });
    expect((await run([folder])).out).toMatch(/PASS \(handoff\)/);
    writeFileSync(join(folder, "handoff.json"), JSON.stringify({ ...pack, draft: true }));
    const failed = await run([folder]);
    expect(failed.code).toBe(BRIEF_EXIT.handoff);
    expect(failed.out).toMatch(/draft/);
  });

  it("errors, with the usual exit 1, when the input is missing or unreadable", async () => {
    await expect(runCli(["brief", "check"])).rejects.toThrow(/Usage: resolve brief check/);
    await expect(runCli(["brief", "check", join(dir, "nope.md")])).rejects.toThrow(/No brief or handoff folder/);
    await expect(runCli(["brief", "check", dir])).rejects.toThrow(/No handoff\.json/);
  });

  it("prints JSON with --json, including the exit-code table", async () => {
    const { out } = await run([brief(EXAMPLE.replace("status: complete", "status: draft")), "--json"]);
    const data = JSON.parse(out);
    expect(data).toMatchObject({ ok: false, input: "brief", exitCode: BRIEF_EXIT.status, exitCodes: BRIEF_EXIT });
    expect(data.issues[0]).toMatchObject({ type: "status" });
  });

  it("--suggest is advisory: without a learned library it says so and the exit code stays 0", async () => {
    const { out, code } = await run([EXAMPLE_PATH, "--suggest"]);
    expect(code).toBe(0);
    expect(out).toMatch(/Advisory only/);
    expect(out).toMatch(/Suggestions not available/);
  });

  it("--suggest maps the screen rows with a learned library and still never changes the exit code", async () => {
    await runCli(["ingest", "scoreboard/fixture/library.json", "--role", "library", "--name", "Fixture"]);
    const passing = await run([EXAMPLE_PATH, "--suggest"]);
    expect(passing.code).toBe(0);
    expect(passing.out).toMatch(/Advisory only/);
    expect(passing.out).toMatch(/Mapped \d+ · weak \d+ · no match \d+/);
    const failing = await run([brief(EXAMPLE.replace("status: complete", "status: draft")), "--suggest"]);
    expect(failing.code).toBe(BRIEF_EXIT.status);
    const json = JSON.parse((await run([EXAMPLE_PATH, "--suggest", "--json"])).out);
    expect(json.exitCode).toBe(0);
    expect(json.advisory.note).toMatch(/Advisory only/);
    expect(Array.isArray(json.advisory.rows.rows)).toBe(true);
  });

  it("--suggest on a handoff pack says it reads briefs only", async () => {
    const folder = join(dir, "handoff");
    mkdirSync(folder);
    writeFileSync(join(folder, "handoff.json"), JSON.stringify({ ok: true, draft: false, screens: [{ name: "S", verify: { pass: true } }] }));
    const { out, code } = await run([folder, "--suggest"]);
    expect(code).toBe(0);
    expect(out).toMatch(/reads a brief's screen inventory/);
  });

  it("help documents the command and every exit code", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await runCli([]);
    } finally {
      process.stdout.write = write;
    }
    const help = chunks.join("");
    expect(help).toMatch(/resolve brief check <brief\.md \| handoff-folder> \[--suggest\] \[--json\]/);
    for (const code of Object.values(BRIEF_EXIT)) expect(help).toContain(`${code} `);
    expect(help).toMatch(/never changes the exit code/);
  });
});
