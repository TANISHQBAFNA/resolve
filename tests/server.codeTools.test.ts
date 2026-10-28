import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_TOOL_NAMES, runCodeTool } from "@/server/code/mcp";
import { listToolDefinitions } from "@/server/tools";

const previous = {
  home: process.env["RESOLVE_HOME"],
  mode: process.env["RESOLVE_MODE"],
  repo: process.env["RESOLVE_REPO_PATH"],
};

afterEach(() => {
  const restore = (key: "RESOLVE_HOME" | "RESOLVE_MODE" | "RESOLVE_REPO_PATH", value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("RESOLVE_HOME", previous.home);
  restore("RESOLVE_MODE", previous.mode);
  restore("RESOLVE_REPO_PATH", previous.repo);
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "resolve-code-"));
  process.env["RESOLVE_HOME"] = join(root, "store");
  process.env["RESOLVE_MODE"] = "code";
  mkdirSync(join(root, "components", "button"), { recursive: true });
  mkdirSync(join(root, "components", "badge"), { recursive: true });
  writeFileSync(
    join(root, "components", "button", "button.css"),
    ".btn { color: var(--ink); }\n.btn--primary { color: var(--ink); }\n/* deprecated .btn-old use .btn */\n",
  );
  writeFileSync(join(root, "components", "badge", "badge.css"), ".badge { color: var(--ink); }\n");
  writeFileSync(join(root, "tokens.css"), ":root { --ink: #112233; }\n");
  writeFileSync(
    join(root, "screen.html"),
    '<link rel="stylesheet" href="components/button/button.css">\n<button class="btn btn--primary">Pay</button>\n<div class="nope"></div>\n<span class="btn--primary btn-old" style="color:#ff00aa"></span>\n',
  );
  return root;
}

describe("code tools", () => {
  it("offers the four code tools in code mode and not in figma mode", () => {
    expect(listToolDefinitions(false, "code").map((tool) => tool.name)).toEqual([...CODE_TOOL_NAMES]);
    for (const name of CODE_TOOL_NAMES) {
      expect(listToolDefinitions(false, "figma").map((tool) => tool.name)).not.toContain(name);
      expect(listToolDefinitions(true, "figma").map((tool) => tool.name)).not.toContain(name);
    }
  });

  it("scans a repo, picks the button, checks the screen, and maps Button by name", () => {
    const root = repo();
    const scan = runCodeTool("code_scan", {
      repoPath: root,
      list: true,
      figma: [{ name: "Button", nodeId: "30:10", fileKey: "ACME", variants: ["primary"] }],
    }) as { components: number; list: Array<{ name: string }> };
    expect(scan.components).toBe(2);
    expect(scan.list.map((row) => row.name).sort()).toEqual(["badge", "button"]);

    const pick = runCodeTool("code_pick", { repoPath: root, query: "primary button" }) as {
      components: Array<{ name: string; classes: string[]; avoid?: string[] }>;
    };
    expect(pick.components[0]?.name).toBe("button");
    expect(pick.components[0]?.classes).toContain("btn");
    expect(pick.components[0]?.avoid).toContain(".btn-old");

    const check = runCodeTool("code_check", { repoPath: root, file: join(root, "screen.html") }) as {
      ok: boolean;
      findings: Array<{ rule: string }>;
    };
    expect(check.ok).toBe(false);
    const rules = check.findings.map((finding) => finding.rule);
    expect(rules).toContain("unknown-class");
    expect(rules).toContain("deprecated-class");
    expect(rules).toContain("modifier-without-base");
    expect(rules).toContain("hardcoded-color");

    const map = runCodeTool("code_map", { repoPath: root }) as {
      pairs: Array<{ figma: string; code: string; confidence: string }>;
    };
    expect(map.pairs).toEqual([{ figma: "Button", code: "button", confidence: "exact" }]);
    expect(() => runCodeTool("code_pick", { repoPath: root, query: "  " })).toThrow(/query/);
  });
});
