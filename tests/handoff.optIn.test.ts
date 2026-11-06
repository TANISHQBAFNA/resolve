import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/server/cli";
import { usage } from "@/server/cliUsage";
import { callTool, listToolDefinitions } from "@/server/tools";
import { clearCache } from "@/server/store";

/** Handoff is beyond the readiness check, so it is opt-in (RESOLVE_HANDOFF=1). The test setup turns it on; these check the default. */
describe("handoff is opt-in", () => {
  const saved = { handoff: process.env["RESOLVE_HANDOFF"], home: process.env["RESOLVE_HOME"] };
  beforeEach(() => {
    delete process.env["RESOLVE_HANDOFF"];
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-handoff-off-"));
    clearCache();
  });
  afterEach(() => {
    for (const [key, value] of [["RESOLVE_HANDOFF", saved.handoff], ["RESOLVE_HOME", saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearCache();
  });

  const capture = async (run: () => unknown) => {
    const out: string[] = [];
    const err: string[] = [];
    const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      await run();
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
    }
    return { out: out.join(""), err: err.join("") };
  };

  it("get_handoff is not offered, even on the advanced surface, until RESOLVE_HANDOFF=1", () => {
    expect(listToolDefinitions(true, "figma").map((tool) => tool.name)).not.toContain("get_handoff");
    expect(listToolDefinitions(false, "figma").map((tool) => tool.name)).not.toContain("get_handoff");
    process.env["RESOLVE_HANDOFF"] = "1";
    expect(listToolDefinitions(true, "figma").map((tool) => tool.name)).toContain("get_handoff");
    expect(listToolDefinitions(true, "figma")).toHaveLength(18);
  });

  it("calling get_handoff while it is off says how to turn it on", () => {
    const advanced = process.env["RESOLVE_MCP_ADVANCED"];
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    try {
      expect(() => callTool("get_handoff", { frame: "Send money" })).toThrow(/off by default.*next:.*RESOLVE_HANDOFF=1/);
    } finally {
      if (advanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
      else process.env["RESOLVE_MCP_ADVANCED"] = advanced;
    }
  });

  it("resolve handoff is a warning with a next step and exit 0, and help leaves it out", async () => {
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const ran = await capture(() => runCli(["handoff", "Send money"]));
      expect(ran.err).toContain("warning: handoff is off by default");
      expect(ran.err).toContain("next:");
      expect(ran.err).toContain("RESOLVE_HANDOFF=1");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = previous;
    }
    const help = await capture(() => usage());
    expect(help.out).not.toContain("resolve handoff");
    process.env["RESOLVE_HANDOFF"] = "1";
    expect((await capture(() => usage())).out).toContain("resolve handoff");
  });

  it("brief check stays available and advisory", async () => {
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const ran = await capture(() => runCli(["brief", "check", join(process.cwd(), "templates", "design-brief", "brief.md")]));
      expect(ran.out).toMatch(/Brief check: (PASS|FAIL)/);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = previous;
    }
  });
});
