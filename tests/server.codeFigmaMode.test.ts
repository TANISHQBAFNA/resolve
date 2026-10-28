import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodeCommand } from "@/server/code/command";
import { readConfig } from "@/server/mode";

const OFF = (tool: string) =>
  `Tool "${tool}" is in the code workflow, which is off (mode: figma). Set mode to code or both in .resolve/config.json, or RESOLVE_MODE.`;

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

function isolate(): string {
  const root = mkdtempSync(join(tmpdir(), "resolve-figma-mode-"));
  const home = join(root, "store");
  mkdirSync(home, { recursive: true });
  process.env["RESOLVE_HOME"] = home;
  delete process.env["RESOLVE_MODE"];
  delete process.env["RESOLVE_REPO_PATH"];
  return root;
}

async function capture(run: () => void): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  return { out: out.join(""), err: err.join("") };
}

describe("code commands in figma mode", () => {
  it("refuses scan, pick, and check, and a --repo flag does not change the mode", () => {
    const root = isolate();
    for (const [sub, tool] of [
      ["scan", "code_scan"],
      ["pick", "code_pick"],
      ["check", "code_check"],
    ] as const) {
      expect(() => runCodeCommand([sub, "--repo", root, "button"]), sub).toThrow(OFF(tool));
    }
    const cfg = readConfig();
    expect(cfg.mode).toBe("figma");
    expect(cfg.modeSource).toBe("default");
    expect(cfg.repoPath).toBeUndefined();

    process.env["RESOLVE_MODE"] = "figma";
    expect(() => runCodeCommand(["scan", "--repo", root])).toThrow(OFF("code_scan"));
    expect(() => runCodeCommand(["map", "--repo", root])).toThrow(OFF("code_map"));
    expect(readConfig().mode).toBe("figma");
    expect(readConfig().modeSource).toBe("env");

    delete process.env["RESOLVE_MODE"];
    writeFileSync(join(process.env["RESOLVE_HOME"] ?? "", "config.json"), JSON.stringify({ mode: "figma", repoPath: root }));
    expect(() => runCodeCommand(["pick", "--repo", root, "button"])).toThrow(OFF("code_pick"));
    expect(readConfig().mode).toBe("figma");
    expect(readConfig().modeSource).toBe("config");
  });

  it("still runs a code command when the mode is code, and code map in the default mode", async () => {
    const root = isolate();
    const mapped = await capture(() => runCodeCommand(["map", "--repo", root]));
    expect(mapped.err).not.toContain("code workflow, which is off");
    expect(readConfig().mode).toBe("figma");
    expect(readConfig().modeSource).toBe("default");

    process.env["RESOLVE_MODE"] = "code";
    const scanned = await capture(() => runCodeCommand(["scan", "--repo", root]));
    expect(scanned.err).toBe("");
    expect(scanned.out).toContain(root);
    expect(readConfig().mode).toBe("code");
    expect(readConfig().modeSource).toBe("env");
  });
});
