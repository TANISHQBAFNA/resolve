import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Ajv from "ajv";
import { knowledgeInstructions } from "@/core/codeKnowledge/instructions";
import { runCodeCommand } from "@/server/code/command";

const root = join(__dirname, "..");
const fixture = join(root, "fixtures/acme-code-knowledge");
const dirs: string[] = [];

function capture(run: () => void): string {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return chunks.join("");
}

function acmeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "resolve-dsck-"));
  cpSync(join(fixture, "repo"), dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function draft(folder: string): { status: string; source?: string; by?: string } {
  return JSON.parse(readFileSync(join(folder, ".resolve", "code-knowledge.json"), "utf8")) as { status: string; source?: string; by?: string };
}

afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AI coded-component knowledge", () => {
  it("prints the steps for a local folder or a git URL plus a ref", () => {
    const text = capture(() => runCodeCommand(["knowledge"]));
    expect(process.exitCode).toBe(0);
    expect(text).toBe(knowledgeInstructions());
    for (const phrase of ["git clone", "checkout <ref>", "HTML", "CSS", "JS", "file", "line", "DSCK", "DSCI", "proposed"]) {
      expect(text).toContain(phrase);
    }
    const command = readFileSync(join(root, "commands/code-knowledge.md"), "utf8");
    for (const phrase of ["git clone", "checkout <ref>", "HTML", "CSS", "JS", "DSCK", "DSCI", "file:line"]) expect(command).toContain(phrase);
    expect(readFileSync(join(root, "templates/code-knowledge/dsck.json"), "utf8")).toBe(readFileSync(join(fixture, "good.dsck.json"), "utf8"));
    expect(readFileSync(join(root, "templates/code-knowledge/dsci.json"), "utf8")).toBe(readFileSync(join(fixture, "good.dsci.json"), "utf8"));
  });

  it("accepts a good Acme draft, keeps it proposed, and files the mapping with scanner drafts", () => {
    const folder = acmeRepo();
    const text = capture(() => runCodeCommand(["knowledge", "check", join(fixture, "good.dsck.json"), "--repo", folder, "--usage", join(fixture, "good.dsci.json")]));
    expect(process.exitCode).toBe(0);
    expect(text.split("\n").filter((line) => line.startsWith("warning:"))).toEqual([]);
    expect(text).toContain("agreement ds@1.0.0.core.button variants primary");
    expect(text).toContain("pair ds@1.0.0.core.button variants primary source ai");
    expect(text).toContain("pair ds@1.0.0.core.button variants primary source scanner");
    expect(text).toContain("Nothing was confirmed");
    expect(draft(folder)).toMatchObject({ status: "proposed", source: "ai" });
    const map = JSON.parse(readFileSync(join(folder, ".resolve", "component-map.json"), "utf8")) as { entries: unknown[] };
    expect(map.entries).toEqual([{ figma: "Acme Button", code: "button", status: "proposed", tier: "suggested", reason: "AI draft" }]);
  });

  it("warns on fake evidence and still exits 0", () => {
    const text = capture(() => runCodeCommand(["knowledge", "check", join(fixture, "fake-evidence.dsck.json"), "--repo", acmeRepo()]));
    expect(process.exitCode).toBe(0);
    expect(text).toMatch(/warning: evidence building-blocks\/button\/button\.css:50 is past the end of the file next:/);
  });

  it("warns on a schema error and still exits 0", () => {
    const text = capture(() => runCodeCommand(["knowledge", "check", join(fixture, "bad-schema.dsck.json"), "--repo", acmeRepo()]));
    expect(process.exitCode).toBe(0);
    expect(text).toMatch(/warning: schema .* next:/);
    expect(text).toContain("components/0/id");
  });

  it("shows an AI versus scanner disagreement with each source", () => {
    const text = capture(() => runCodeCommand(["knowledge", "check", join(fixture, "disagree.dsck.json"), "--repo", acmeRepo(), "--json"]));
    expect(process.exitCode).toBe(0);
    const report = JSON.parse(text) as { exitCode: number; disagreements: Array<{ value: string; source: string }> };
    expect(report.exitCode).toBe(0);
    expect(report.disagreements).toContainEqual({ id: "ds@1.0.0.core.button", field: "variants", value: "danger", source: "ai" });
    expect(report.disagreements).toContainEqual({ id: "ds@1.0.0.core.button", field: "variants", value: "primary", source: "scanner" });
  });

  it("does not keep a confirmed status from the AI file", () => {
    const folder = acmeRepo();
    const file = join(folder, "claimed.json");
    const body = JSON.parse(readFileSync(join(fixture, "good.dsck.json"), "utf8")) as { status: string };
    body.status = "confirmed";
    writeFileSync(file, JSON.stringify(body));
    const text = capture(() => runCodeCommand(["knowledge", "check", file, "--repo", folder, "--usage", join(fixture, "good.dsci.json")]));
    expect(process.exitCode).toBe(0);
    expect(text).toMatch(/warning: status confirmed was ignored next:/);
    expect(draft(folder).status).toBe("proposed");
  });

  it("confirms only when a person passes --who, and leaves the mapping proposed", () => {
    const folder = acmeRepo();
    capture(() => runCodeCommand(["knowledge", "check", join(fixture, "good.dsck.json"), "--repo", folder, "--usage", join(fixture, "good.dsci.json")]));
    const refused = capture(() => runCodeCommand(["knowledge", "confirm", "--repo", folder]));
    expect(process.exitCode).toBe(0);
    expect(refused).toMatch(/warning: confirm needs a person next:/);
    expect(draft(folder).status).toBe("proposed");
    const accepted = capture(() => runCodeCommand(["knowledge", "confirm", "--who", "Tanishk", "--repo", folder]));
    expect(process.exitCode).toBe(0);
    expect(accepted).toContain("The scanner catalog was not changed.");
    expect(draft(folder)).toMatchObject({ status: "confirmed", by: "Tanishk" });
    const map = JSON.parse(readFileSync(join(folder, ".resolve", "component-map.json"), "utf8")) as { entries: Array<{ status: string }> };
    expect(map.entries[0]?.status).toBe("proposed");
  });

  it("checks the Acme templates and the bad file against the schemas", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const dsck = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/dsck.schema.json"), "utf8")) as object);
    const dsci = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/dsci.schema.json"), "utf8")) as object);
    const read = (name: string) => JSON.parse(readFileSync(join(fixture, name), "utf8")) as unknown;
    expect(dsck(read("good.dsck.json"))).toBe(true);
    expect(dsck(read("fake-evidence.dsck.json"))).toBe(true);
    expect(dsck(read("disagree.dsck.json"))).toBe(true);
    expect(dsck(read("bad-schema.dsck.json"))).toBe(false);
    expect(dsci(read("good.dsci.json"))).toBe(true);
  });
});
