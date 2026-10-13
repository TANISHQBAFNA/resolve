import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "resolve-setup.mjs");

function tempDir(name: string): string {
  const dir = join(realpathSync(tmpdir()), `resolve-bytes-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setup(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: tempDir("home"), FIGMA_ACCESS_TOKEN: "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("H2 and M1 install then uninstall restores bytes", () => {
  it("keeps an existing empty mcpServers object in both MCP files", () => {
    const cwd = tempDir("mcp");
    const cursor = join(cwd, ".cursor", "mcp.json");
    const claude = join(cwd, ".mcp.json");
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    const original = `{"mcpServers":{}}`;
    writeFileSync(cursor, original);
    writeFileSync(claude, original);
    expect(setup([], cwd).status).toBe(0);
    expect(setup(["--uninstall"], cwd).status).toBe(0);
    expect(JSON.parse(readFileSync(cursor, "utf8"))).toEqual({ mcpServers: {} });
    expect(JSON.parse(readFileSync(claude, "utf8"))).toEqual({ mcpServers: {} });
  });

  it("keeps whitespace-only CLAUDE.md and .gitignore, and removes a file setup created", () => {
    const cwd = tempDir("white");
    writeFileSync(join(cwd, "CLAUDE.md"), "\n");
    writeFileSync(join(cwd, ".gitignore"), "\n");
    expect(setup([], cwd).status).toBe(0);
    expect(readFileSync(join(cwd, ".cursor", "rules", "resolve.mdc"), "utf8")).toContain("resolve-setup:begin");
    expect(setup(["--uninstall"], cwd).status).toBe(0);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("\n");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("\n");
    expect(existsSync(join(cwd, ".cursor", "rules", "resolve.mdc"))).toBe(false);
  });

  it("round-trips compact JSON, a missing newline, extra newlines, and a CRLF last line", () => {
    const cases = [
      { name: "compact", file: ".mcp.json", text: `{"mcpServers":{"x":{"command":"y"}}}` },
      { name: "nonewline", file: "CLAUDE.md", text: "# Notes" },
      { name: "blanks", file: "CLAUDE.md", text: "\n\n\n" },
      { name: "crlf", file: ".gitignore", text: "node_modules/\r\ndist/\r\n" },
    ];
    for (const item of cases) {
      const cwd = tempDir(item.name);
      if (item.file.startsWith(".")) mkdirSync(join(cwd, ".cursor"), { recursive: true });
      const path = join(cwd, item.file);
      writeFileSync(path, item.text);
      expect(setup([], cwd).status).toBe(0);
      expect(setup(["--uninstall"], cwd).status).toBe(0);
      const after = readFileSync(path, "utf8");
      if (item.file.endsWith("mcp.json")) expect(JSON.parse(after)).toEqual(JSON.parse(item.text));
      else expect(after).toBe(item.text);
    }
  });

  it("refuses a read-only CLAUDE.md before writing anything else, and names the file", () => {
    const cwd = tempDir("ro");
    const claude = join(cwd, "CLAUDE.md");
    writeFileSync(claude, "# Mine\n");
    chmodSync(claude, 0o444);
    const result = setup([], cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(claude);
    expect(result.stderr).not.toContain("permission to create files");
    expect(existsSync(join(cwd, ".cursor", "rules", "resolve.mdc"))).toBe(false);
    chmodSync(claude, 0o644);
  });
});
