import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGNER } from "@/server/designerMessages";
import { PHRASES, classify, commandPlan } from "../scripts/fresh-install-kit.mjs";

const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const reply = (id: string, content: unknown, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const done = (result: string) => ({ type: "result", result });
const status = "npx -y -p github:TANISHQBAFNA/resolve resolve-figma status";

describe("F4-R1 fresh-install kit", () => {
  it("looks for the designer messages Resolve really prints", () => {
    expect(DESIGNER.notInstalled.startsWith(PHRASES.notInstalled)).toBe(true);
    expect(DESIGNER.nothingLearned.startsWith(PHRASES.nothingLearned)).toBe(true);
    expect(DESIGNER.token.startsWith(PHRASES.token)).toBe(true);
    expect(DESIGNER.viewSeat.startsWith(PHRASES.viewSeat)).toBe(true);
  });

  it("runs the 8 shipped commands", () => {
    const shipped = readdirSync(join(__dirname, "..", "commands")).map((file) => file.replace(/\.md$/, "")).sort();
    expect(commandPlan().map(([name]) => name).sort()).toEqual(shipped);
    const link = "https://www.figma.com/design/KEY/File?node-id=1-2";
    expect(Object.fromEntries(commandPlan(link))).toMatchObject({ parts: link, handoff: link, check: link, "design-system": "https://www.figma.com/design/KEY/File" });
  });

  it("passes a command only when a call reached Resolve and came back with an answer", () => {
    expect(classify("resolve-status", [call("1", "Bash", { command: status }), reply("1", "Learned files:\n- Lib"), done("One library is learned.")]).verdict).toBe("pass");
    expect(classify("find", [call("1", "mcp__resolve__recommend", { intent: "button" }), reply("1", [{ type: "text", text: "name: Button" }]), done("Use Button.")]).verdict).toBe("pass");
    const refused = [call("1", "Bash", { command: `${status.replace("status", "handoff")} "link"` }), reply("1", "Handoff refused. Nothing written.", true), done("Replace the retired part.")];
    expect(classify("handoff", refused).verdict).toBe("pass");
  });

  it("fails the old breaks: a missing bin, a bin that prints nothing, a stack trace, no Resolve call", () => {
    const missing = [call("1", "Bash", { command: "resolve-figma status" }), reply("1", "bash: resolve-figma: command not found", true), done(DESIGNER.notInstalled)];
    expect(classify("resolve-status", missing)).toEqual({ verdict: "fail", why: "said Resolve is not installed" });
    expect(classify("parts", [call("1", "Bash", { command: status }), reply("1", ""), done("Done.")]).verdict).toBe("fail");
    expect(classify("parts", [call("1", "Bash", { command: status }), reply("1", "Error\n    at runCli (cli.mjs:1:1)"), done("Done.")]).verdict).toBe("fail");
    expect(classify("check", [call("1", "Bash", { command: "ls" }), reply("1", "a b"), done("Looks fine.")]).verdict).toBe("fail");
    expect(classify("find", [done("Error at node_modules/resolve-figma/dist-server/cli.mjs")]).verdict).toBe("fail");
  });

  it("marks Figma and learned-library answers as needs-Figma", () => {
    expect(classify("design-system", [done("Connect Figma first.")]).verdict).toBe("needs-Figma");
    expect(classify("find", [call("1", "mcp__resolve__recommend", {}), reply("1", "x"), done(DESIGNER.nothingLearned)]).verdict).toBe("needs-Figma");
    expect(classify("check", [done(DESIGNER.token)]).verdict).toBe("needs-Figma");
  });

  it("--dry-run prints the setup and 8 isolated claude runs, and writes nothing", () => {
    const out = mkdtempSync(join(realpathSync(tmpdir()), "resolve-kit-dry-"));
    const run = spawnSync(process.execPath, [join(__dirname, "..", "scripts", "fresh-install-kit.mjs"), "--dry-run", "--out", out], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines[0]).toBe("npx -y -p github:TANISHQBAFNA/resolve resolve-setup");
    const claude = lines.filter((line) => line.startsWith("claude "));
    expect(claude).toHaveLength(8);
    for (const line of claude) {
      expect(line).toContain(`--mcp-config ${join(out, "project", ".mcp.json")} --strict-mcp-config --setting-sources project`);
      expect(line).toContain('"Bash(npx -y -p github:TANISHQBAFNA/resolve resolve-figma:*)"');
    }
    expect(existsSync(join(out, "home"))).toBe(false);
    expect(existsSync(join(out, "project"))).toBe(false);
  });
});
