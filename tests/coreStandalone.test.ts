import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runAddonCommand } from "@/server/addonHook";

const word = String.fromCharCode(97, 105, 100, 108, 99);
const pattern = new RegExp(word, "i");
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

  it("no file in the product names that delivery contract", () => {
    const root = process.cwd();
    const hits: string[] = [];
    for (const path of files(root)) {
      const rel = relative(root, path).split("\\").join("/");
      // A locally installed add-on (addons/<name>/, gitignored) is not part of the product.
      if (/^addons\/[^/]+\//.test(rel)) continue;
      if (statSync(path).size > 2_000_000) continue;
      const text = readFileSync(path);
      if (text.includes(0)) continue;
      const lines = text.toString("utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        hits.push(`${rel}:${index + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
