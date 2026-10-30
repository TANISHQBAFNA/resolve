import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addonHooks, addonUsageLines, registerAddonCommand, runAddonCommand, spawnAddonCommand } from "@/server/addonHook";

function addon(root: string, name: string, hook: unknown, bin?: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "hook.json"), typeof hook === "string" ? hook : JSON.stringify(hook));
  if (bin) writeFileSync(join(dir, "bin", "run.mjs"), bin);
}

function captured(run: () => void): string {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return writes.join("");
}

describe("generic add-on hook", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("ships with no add-on: installed add-on folders are gitignored and never packed, and help lists only installed hooks", () => {
    const root = join(__dirname, "..");
    expect(readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/)).toContain("addons/*/");
    const files = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] }).files;
    expect(files.filter((entry) => entry === "addons" || entry.startsWith("addons/"))).toEqual([]);
    // A locally installed add-on (addons/<name>/) may add hooks; help shows exactly their lines.
    expect(addonUsageLines()).toEqual(addonHooks().flatMap((hook) => hook.usage));
  });

  it("finds hook.json add-ons, skips broken ones, runs the bin and passes its exit code on", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-addons-"));
    addon(root, "hello", { command: "hello", bin: "bin/run.mjs", usage: ["  resolve hello <name>"] }, 'process.stdout.write(`hello ${process.argv.slice(2).join(" ")}\\n`);\n');
    addon(root, "sad", { command: "sad", bin: "bin/run.mjs" }, 'process.stdout.write("{\\"ok\\":false}\\n"); process.exit(3);\n');
    addon(root, "broken", "{ not json");
    addon(root, "partial", { command: "partial" });
    addon(root, "missing", { command: "missing", bin: "bin/none.mjs" });
    expect(addonHooks(root).map((hook) => hook.command).sort()).toEqual(["hello", "missing", "sad"]);
    expect(addonHooks(root).find((hook) => hook.command === "hello")?.usage).toEqual(["  resolve hello <name>"]);

    expect(captured(() => spawnAddonCommand("hello", ["Ada"], root))).toBe("hello Ada\n");
    expect(process.exitCode ?? 0).toBe(0);
    expect(captured(() => spawnAddonCommand("sad", ["--json"], root))).toBe('{"ok":false}\n');
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
    expect(() => captured(() => spawnAddonCommand("sad", [], root))).toThrow('{"ok":false}');
    expect(() => spawnAddonCommand("missing", [], root)).toThrow(/Add-on command missing is missing/);
    expect(() => spawnAddonCommand("nope", [], root)).toThrow(/Unknown command: nope/);
  });

  it("a registered in-process handler wins over the bin", async () => {
    const seen: string[][] = [];
    registerAddonCommand("test-only-hook", (args) => void seen.push(args));
    await runAddonCommand("test-only-hook", ["a", "b"]);
    expect(seen).toEqual([["a", "b"]]);
  });
});
