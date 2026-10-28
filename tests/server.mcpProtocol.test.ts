import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachMcpStdio } from "@/server/mcpSession";
import pkg from "../package.json";

function initialize(protocolVersion?: string): Promise<{ result?: { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } }> {
  return new Promise((resolve, reject) => {
    const params = protocolVersion === undefined ? {} : { protocolVersion };
    const input = Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params })}\n`]);
    const timer = setTimeout(() => reject(new Error("initialize timed out")), 2000);
    attachMcpStdio({
      input,
      write: (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as { result?: { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } });
      },
    });
  });
}

describe("MCP handshake", () => {
  it("reports the package version and echoes a supported protocol", async () => {
    expect(pkg.version).toBe("0.1.3");
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const reply = await initialize(version);
      expect(reply.result?.protocolVersion).toBe(version);
      expect(reply.result?.serverInfo).toEqual({ name: "resolve-figma", version: "0.1.3" });
    }
    expect((await initialize("1999-01-01")).result?.protocolVersion).toBe("2025-06-18");
    expect((await initialize()).result?.protocolVersion).toBe("2025-06-18");
  });
});
