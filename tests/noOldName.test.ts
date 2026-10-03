import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The product's old name is gone from the repo. It stays only where it is read as a fallback.
const OLD = ["graph", "ify"].join("");
const ALLOWED = new Set([
  "README.md", // the one upgrade note
  "src/core/query/overlayFile.ts", // fallback: old setting name, old folder name
  "src/server/store.ts", // fallback: the old setting name in the env type
  "bin/resolve-setup.mjs", // fallback: old folder name
  "tests/server.resolveHome.test.ts", // fallback tests
  "tests/noAmbientStore.ts", // test setup clears the old setting too
  "tests/noOldName.test.ts",
]);
const ROOTS = ["src", "bin", "docs", "tests", "rules", "skills", ".cursor", "figma-plugin", "scoreboard", "e2e", "README.md", "AGENTS.md", "CHANGELOG.md", "package.json", "index.html"];

function files(path: string): string[] {
  try {
    if (!statSync(path).isDirectory()) return [path];
  } catch {
    return [];
  }
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

describe("old product name", () => {
  it("appears only in the fallback code, its tests and the README upgrade note", () => {
    const hits = ROOTS.flatMap(files)
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => file.toLowerCase().includes(OLD) || readFileSync(file, "utf8").toLowerCase().includes(OLD));
    expect(hits).toEqual([]);
  });
});
