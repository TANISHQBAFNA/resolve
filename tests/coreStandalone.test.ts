import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runAddonCommand } from "@/server/addonHook";

const word = String.fromCharCode(97, 105, 100, 108, 99);
const pattern = new RegExp(word, "i");
const allowedLine = `Optional ${word.toUpperCase()} add-on: [\`addons/${word}\`](addons/${word}/).`;
const skipDir = new Set(["node_modules", ".git", "coverage"]);
const skipFile = new Set(["package-lock.json"]);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDir.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (entry.isFile() && !skipFile.has(entry.name)) out.push(path);
  }
  return out;
}

describe("core stands alone", () => {
  it("refuses an unknown add-on command", async () => {
    await expect(runAddonCommand("not-a-real-command", [])).rejects.toThrow(/Unknown command: not-a-real-command/);
  });

  it("no file outside the optional add-on names that delivery contract", () => {
    const root = process.cwd();
    const home = `addons/${word}/`;
    const hits: string[] = [];
    for (const path of files(root)) {
      const rel = relative(root, path).split("\\").join("/");
      if (rel === `addons/${word}` || rel.startsWith(home)) continue;
      if (statSync(path).size > 2_000_000) continue;
      const text = readFileSync(path);
      if (text.includes(0)) continue;
      const lines = text.toString("utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        if (rel === "README.md" && line === allowedLine) return;
        hits.push(`${rel}:${index + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
