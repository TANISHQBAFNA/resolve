import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTRUCTION_LIMIT, MCP_INSTRUCTIONS, WORKFLOW_MARKDOWN, WORKFLOW_URI, readResource } from "@/server/instructions";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("MCP instructions stay a short trigger", () => {
  it("fits under the Claude Code cut and leads with the trigger", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(2048);
    expect(MCP_INSTRUCTIONS.startsWith("For ANY Figma design, screen, or component task, call Resolve first")).toBe(true);
    expect(MCP_INSTRUCTIONS).toContain("recommend");
    expect(MCP_INSTRUCTIONS).toContain("get_example");
    expect(MCP_INSTRUCTIONS).toContain("verify_frame");
    expect(MCP_INSTRUCTIONS).toContain("recipe");
    expect(MCP_INSTRUCTIONS).toContain("check_cousins");
    expect(MCP_INSTRUCTIONS).toContain("learn_library");
    expect(MCP_INSTRUCTIONS).toContain("Map the Figma file first");
    expect(MCP_INSTRUCTIONS).toContain("read-only");
    expect(MCP_INSTRUCTIONS).toContain("plain words");
    expect(MCP_INSTRUCTIONS).toContain("Do not invent components");
    expect(MCP_INSTRUCTIONS).toContain(WORKFLOW_URI);
  });

  it("keeps the long workflow on the resource, and the server points at that text", () => {
    expect(WORKFLOW_MARKDOWN).toContain("placeholders.json");
    expect(WORKFLOW_MARKDOWN).toContain("search_design_system");
    expect(WORKFLOW_MARKDOWN).toContain("RESOLVE_MCP_ADVANCED");
    expect(WORKFLOW_MARKDOWN).toContain("Do not start from the default variant");
    const read = readResource(WORKFLOW_URI);
    expect(read?.contents[0]?.text).toBe(WORKFLOW_MARKDOWN);
    expect(readResource("resolve://nope")).toBeUndefined();

    const server = readFileSync(join(root, "src/server/mcpSession.ts"), "utf8");
    expect(server).toContain("instructions: MCP_INSTRUCTIONS");
    expect(server).toContain("resources/read");
    expect(server).not.toContain("Forced path: learn_library");
  });

  it("rule and skill name MCP tools, not a CLI the designer does not have", () => {
    for (const path of ["rules/resolve.mdc", "skills/resolve/SKILL.md", ".cursor/skills/resolve/SKILL.md"]) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text, path).toContain("For ANY Figma design, screen, or component task, call Resolve");
      expect(text, path).toContain("learn_library");
      expect(text, path).toContain("recommend");
      expect(text, path).toContain("get_example");
      expect(text, path).toContain("verify_frame");
      expect(text, path).toContain("check_cousins");
      expect(text, path).toContain("plain words");
      expect(text, path).toContain("Simplest thing that works");
      expect(text, path).not.toContain("npm run resolve");
    }
    const rule = readFileSync(join(root, "rules/resolve.mdc"), "utf8");
    expect(rule).toContain("alwaysApply: true");
    const skill = readFileSync(join(root, "skills/resolve/SKILL.md"), "utf8");
    expect(readFileSync(join(root, ".cursor/skills/resolve/SKILL.md"), "utf8")).toBe(skill);
  });

  it("rule, skill, CLAUDE block, and MCP instructions name the same path", () => {
    const setup = readFileSync(join(root, "bin/resolve-setup.mjs"), "utf8");
    const block = setup.slice(setup.indexOf("export const CLAUDE_BLOCK"), setup.indexOf("].join"));
    const texts = [
      readFileSync(join(root, "rules/resolve.mdc"), "utf8"),
      readFileSync(join(root, "skills/resolve/SKILL.md"), "utf8"),
      readFileSync(join(root, "AGENTS.md"), "utf8"),
      readFileSync(join(root, "docs/AGENTS-RESOLVE-SECTION.md"), "utf8"),
      block,
      MCP_INSTRUCTIONS,
    ];
    for (const text of texts) {
      expect(text).toContain("learn_library");
      expect(text).toContain("recipe");
      expect(text).toContain("recommend");
      expect(text).toContain("get_example");
      expect(text).toContain("verify_frame");
      expect(text).toContain("check_cousins");
      expect(text).toContain("Set context before any component pick");
      expect(text).toContain("requirements or FSD");
      expect(text).toContain("Do not ask for those four");
      expect(text).not.toContain("ask once");
      expect(text).toContain("audience");
      expect(text).toContain("a11y");
      expect(text).not.toMatch(/npm run resolve/);
      expect(text.toLowerCase()).toContain("do not invent a product");
      expect(text.toLowerCase()).toContain("leave a field off");
      expect(text).not.toMatch(/Level-1/);
      expect(text).not.toMatch(/caveman/i);
    }
  });
});
