import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getPrompt, listPrompts } from "@/server/commands";
import { TOOLS, listToolDefinitions } from "@/server/tools";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "bin", "resolve-setup.mjs");
const saved = process.env["RESOLVE_HANDOFF"];

afterEach(() => {
  if (saved === undefined) delete process.env["RESOLVE_HANDOFF"];
  else process.env["RESOLVE_HANDOFF"] = saved;
});

function withoutHandoff(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FIGMA_ACCESS_TOKEN: "" };
  delete env["RESOLVE_HANDOFF"];
  return env;
}

describe("handoff stays out of default discovery", () => {
  it("setup does not install the slash command unless RESOLVE_HANDOFF=1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "resolve-handoff-off-setup-"));
    const home = mkdtempSync(join(tmpdir(), "resolve-handoff-off-home-"));
    const off = spawnSync(process.execPath, [bin, "--yes"], {
      cwd,
      encoding: "utf8",
      env: { ...withoutHandoff(), HOME: home },
    });
    expect(off.status, off.stderr).toBe(0);
    expect(existsSync(join(cwd, ".claude/commands/handoff.md"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor/commands/handoff.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/commands/configure.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/commands/find.md"))).toBe(true);
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8", env: withoutHandoff() });
    expect(help.stdout).not.toContain("/handoff");
    expect(help.stdout).toContain("/configure");

    process.env["RESOLVE_HANDOFF"] = "1";
    const onDir = mkdtempSync(join(tmpdir(), "resolve-handoff-on-setup-"));
    const onHome = mkdtempSync(join(tmpdir(), "resolve-handoff-on-home-"));
    const on = spawnSync(process.execPath, [bin, "--yes"], {
      cwd: onDir,
      encoding: "utf8",
      env: { ...process.env, HOME: onHome, FIGMA_ACCESS_TOKEN: "" },
    });
    expect(on.status, on.stderr).toBe(0);
    expect(existsSync(join(onDir, ".claude/commands/handoff.md"))).toBe(true);
    expect(existsSync(join(onDir, ".cursor/commands/handoff.md"))).toBe(true);
  });

  it("MCP prompts and the brief tool omit handoff until the flag is set", () => {
    delete process.env["RESOLVE_HANDOFF"];
    expect(listPrompts().map((prompt) => prompt.name)).not.toContain("handoff");
    expect(getPrompt("handoff", {})).toBeUndefined();
    const brief = listToolDefinitions(false).find((tool) => tool.name === "brief");
    expect(brief?.description).not.toMatch(/handoff/i);
    expect(TOOLS.find((tool) => tool.name === "get_ingredients")?.description).not.toMatch(/handoff/i);
    expect(listToolDefinitions(true).map((tool) => tool.name)).not.toContain("get_handoff");

    process.env["RESOLVE_HANDOFF"] = "1";
    expect(listPrompts().map((prompt) => prompt.name)).toContain("handoff");
    expect(getPrompt("handoff", { input: "https://www.figma.com/design/Acme/File?node-id=1-2" })?.messages[0]?.content.text).toContain("get_handoff");
    expect(listToolDefinitions(true).map((tool) => tool.name)).toContain("get_handoff");
  });

  it("the choose-and-configure skill and command still do not name handoff", () => {
    for (const path of ["skills/resolve-configure/SKILL.md", "skills/resolve-configure/guidelines.md", "commands/configure.md"]) {
      expect(readFileSync(join(root, path), "utf8")).not.toMatch(/handoff/i);
    }
  });
});
