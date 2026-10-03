import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const guide = read("INSTALL-FOR-AI.md");

describe("INSTALL-FOR-AI.md", () => {
  it("is linked from AGENTS.md and the top of the README, and ships in the package", () => {
    expect(read("AGENTS.md").split("\n").slice(0, 3).join("\n")).toContain("INSTALL-FOR-AI.md");
    expect(read("README.md").split("\n").slice(0, 12).join("\n")).toContain("INSTALL-FOR-AI.md");
    expect(read("README.md")).toContain("Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md");
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    expect(pkg.files).toContain("INSTALL-FOR-AI.md");
  });

  it("gives the ordered steps for Claude Code, Cursor and Codex with the real commands", () => {
    const order = ["## Step 0", "## Step 1", "## Step 2", "## Step 3", "## Step 4", "## Step 5", "## Step 6"].map((h) =>
      guide.indexOf(h),
    );
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(guide).toContain("npx -y -p github:TANISHQBAFNA/resolve resolve-setup");
    expect(guide).toContain("claude mcp get resolve");
    expect(guide).toContain("claude mcp get figma");
    expect(guide).toContain("claude mcp add --transport http figma https://mcp.figma.com/mcp -s project");
    expect(guide).toContain("### Claude Code");
    expect(guide).toContain("### Cursor");
    expect(guide).toContain("### Codex (not verified)");
    expect(guide).toContain("sign in to Figma");
    expect(guide).toContain("Paste a Figma file link");
  });

  it("states the safety rules", () => {
    expect(guide).toMatch(/Do not touch user-level settings without asking/);
    expect(guide).toContain("~/.claude.json");
    expect(guide).toMatch(/Never print a token/);
    expect(guide).toMatch(/Safe to repeat/);
    expect(guide).toMatch(/Report what changed/);
    expect(guide).not.toMatch(/figd_|FIGMA_ACCESS_TOKEN=\S/);
    // "mcp list" prints every server's arguments (secrets). It may appear only in the "never run" rule.
    const listLines = guide.split("\n").filter((line) => line.includes("mcp list"));
    expect(listLines).toHaveLength(1);
    expect(listLines[0]).toMatch(/Never run/);
    expect(guide).toMatch(/restart|reload/i);
    expect(read("README.md")).not.toContain("mcp list");
    expect(read("README.md")).not.toContain("Step 3");
  });

  it("only names commands, files and bin names that exist", () => {
    const pkg = JSON.parse(read("package.json")) as { bin: Record<string, string> };
    expect(pkg.bin).toHaveProperty("resolve-setup");
    expect(pkg.bin).toHaveProperty("resolve-mcp");
    expect(guide).toContain("resolve-mcp");
    expect(existsSync(join(root, "docs/AGENTS-RESOLVE-SECTION.md"))).toBe(true);
    for (const link of guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      expect(existsSync(join(root, link[1] ?? "")), link[1]).toBe(true);
    }
  });

  it("the Cursor path works as written: setup, merge the Figma line, setup again", () => {
    const cwd = join(tmpdir(), `install-guide-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const home = `${cwd}-home`;
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }));
    const run = () =>
      spawnSync(process.execPath, [join(root, "bin/resolve-setup.mjs")], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: home, FIGMA_ACCESS_TOKEN: "" },
      });
    const first = run();
    expect(first.stdout).toContain("Figma connected? no");
    const fragment = /```json\n\s*("figma": \{[^\n]*\})\n\s*```/.exec(guide)?.[1];
    expect(fragment).toBeTruthy();
    const file = join(cwd, ".cursor/mcp.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
    Object.assign(doc.mcpServers, JSON.parse(`{${fragment}}`));
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    const second = run();
    expect(second.stdout).toContain(`unchanged ${file}`);
    expect(second.stdout).toContain("Figma connected? yes");
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual(["notes", "resolve", "figma"]);
  });
});
