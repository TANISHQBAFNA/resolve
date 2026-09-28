import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mcpBin = join(root, "bin", "resolve-mcp.mjs");
const cliBin = join(root, "bin", "resolve-cli.mjs");
const mcpDist = join(root, "dist-server", "mcp.mjs");

async function listToolsFrom(command: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RESOLVE_MCP_ADVANCED: "" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const lines = out.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
          if (msg.id === 2 && msg.result?.tools) {
            child.kill();
            resolve(msg.result.tools.map((tool) => tool.name));
            return;
          }
        } catch {
          // ignore partial lines
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0 && code !== null) {
        reject(new Error(`MCP exited ${code}: ${err || out}`));
      }
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for tools/list\nstdout=${out}\nstderr=${err}`));
    }, 12_000);
  });
}

describe("Node version gate", () => {
  it("rejects Node below 22.12 with a one-line stderr message", () => {
    const guard = join(root, "bin", "node-version.mjs");
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { nodeVersionMessage, nodeVersionTooOld } from ${JSON.stringify(guard)};
        if (!nodeVersionTooOld("v22.11.0")) process.exit(2);
        if (nodeVersionTooOld("v22.12.0")) process.exit(3);
        if (nodeVersionTooOld("v24.0.0")) process.exit(4);
        process.stderr.write(nodeVersionMessage("v20.11.1"));
        process.exit(0);`,
      ],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    expect(probe.stderr).toBe(
      "Resolve needs Node.js 22.12 or newer (this is v20.11.1). Install the LTS from https://nodejs.org\n",
    );
    const bin = readFileSync(join(root, "bin", "resolve-mcp.mjs"), "utf8");
    const gate = bin.indexOf("nodeVersionTooOld");
    const server = bin.indexOf("dist-server");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(server);
  });
});

describe("documented MCP install command", () => {
  it("docs use npx -p github:… resolve-mcp so the server bin starts", () => {
    const setup = readFileSync(join(root, "docs", "SETUP-MCP.md"), "utf8");
    expect(setup).toContain('"args": ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]');
    expect(setup).not.toContain('"args": ["-y", "github:TANISHQBAFNA/resolve", "resolve-mcp"]');
  });

  it("spawns the MCP server and lists default tools", async () => {
    expect(existsSync(mcpDist)).toBe(true);
    const viaMcpBin = await listToolsFrom(process.execPath, [mcpBin]);
    expect(new Set(viaMcpBin)).toEqual(
      new Set(["learn_library", "recipe", "recommend", "resolve", "verify_frame", "check_cousins"]),
    );
    expect(viaMcpBin).toHaveLength(6);

    const viaCliArg = await listToolsFrom(process.execPath, [cliBin, "resolve-mcp"]);
    expect(viaCliArg).toEqual(viaMcpBin);

    const viaNpx = await listToolsFrom("npx", ["-y", "-p", root, "resolve-mcp"]);
    expect(viaNpx).toEqual(viaMcpBin);
  }, 30_000);
});
