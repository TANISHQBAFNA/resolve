import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function check(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "meaning-check-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
    }
    const result = spawnSync(process.execPath, ["scripts/check-meaning-sock.mjs", dir, "--structural"], { encoding: "utf8" });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const index = "# Acme\nbuilt: 2026-01-01T00:00:00.000Z\n- [switch](switch.md) — Switch\n";
const component = "# Acme / Switch\nSwitch\n[switch](index.md)\n";

describe("meaning file checker", () => {
  it("accepts a linked component file", () => {
    const output = check({
      "pack.txt": "pack\n",
      "acme/index.md": index,
      "acme/switch.md": component,
    });
    expect(output).toContain("meaning sock files ok");
  });

  it("fails an empty file", () => {
    const output = check({
      "pack.txt": "pack\n",
      "acme/index.md": index,
      "acme/switch.md": "",
    });
    expect(output).toContain("empty file");
  });

  it("fails a garbage file", () => {
    const output = check({
      "pack.txt": "pack\n",
      "acme/index.md": index,
      "acme/switch.md": component,
      "acme/notes.md": "hello garbage\n",
    });
    expect(output).toContain("garbage file");
  });

  it("fails a missing index line and an orphaned file", () => {
    const output = check({
      "pack.txt": "pack\n",
      "acme/index.md": index,
      "acme/switch.md": component,
      "acme/button.md": "# Acme / Button\nButton\n[button](index.md)\n",
    });
    expect(output).toContain("missing index line");
    expect(output).toContain("orphaned file");
  });
});
