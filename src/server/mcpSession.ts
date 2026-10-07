import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { MCP_INSTRUCTIONS, listResources, readResource } from "./instructions";
import { getPrompt, listPrompts } from "./commands";
import { listToolDefinitions, ToolError, callTool, encodeToolResult, toolCardFormat } from "./tools";
import { designerFailure } from "./designerMessages";

/**
 * MCP JSON-RPC for one stdio session. Importing this file does not read stdin.
 * dist-server/mcp.mjs calls startMcpStdio() so a chat client can connect.
 */

const SERVER_INFO = { name: "resolve-figma", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

interface Request {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface McpStreams {
  input: Readable;
  write: (line: string) => void;
  onClose?: () => void;
}

export function attachMcpStdio(streams: McpStreams): void {
  const send = (message: unknown): void => {
    streams.write(JSON.stringify(message));
  };
  const reply = (id: string | number, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };
  const fail = (id: string | number, code: number, message: string): void => {
    send({ jsonrpc: "2.0", id, error: { code, message: designerFailure(message) } });
  };

  const handle = (request: Request): void => {
    const { id, method, params } = request;
    if (id === undefined) return;

    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        });
        return;

      case "ping":
        reply(id, {});
        return;

      case "tools/list":
        reply(id, { tools: listToolDefinitions() });
        return;

      case "prompts/list":
        reply(id, { prompts: listPrompts() });
        return;

      case "prompts/get": {
        const p = (params ?? {}) as { name?: string; arguments?: unknown };
        const prompt = p.name ? getPrompt(p.name, p.arguments) : undefined;
        if (!prompt) {
          fail(id, -32602, `Unknown prompt \`${p.name ?? ""}\`. Known: ${listPrompts().map((x) => x.name).join(", ")}.`);
          return;
        }
        reply(id, prompt);
        return;
      }

      case "resources/list":
        reply(id, { resources: listResources() });
        return;

      case "resources/read": {
        const uri = params && typeof params === "object" && "uri" in params ? String((params as { uri?: unknown }).uri ?? "") : "";
        const resource = readResource(uri);
        if (!resource) {
          fail(id, -32002, `Unknown resource \`${uri}\`. Known: resolve://workflow.`);
          return;
        }
        reply(id, resource);
        return;
      }

      case "tools/call": {
        const call = (params ?? {}) as { name?: string; arguments?: unknown };
        if (!call.name) {
          fail(id, -32602, "tools/call requires a tool name.");
          return;
        }
        try {
          const args = (call.arguments ?? {}) as Record<string, unknown>;
          const format = toolCardFormat(args["format"]);
          const result = callTool(call.name, call.arguments);
          reply(id, {
            content: [{ type: "text", text: encodeToolResult(result, format, call.name) }],
          });
        } catch (error) {
          const message = designerFailure(error instanceof Error ? error.message : String(error));
          if (error instanceof ToolError) {
            reply(id, { content: [{ type: "text", text: message }], isError: true });
          } else {
            process.stderr.write(`[resolve] ${message}\n`);
            reply(id, { content: [{ type: "text", text: message }], isError: true });
          }
        }
        return;
      }

      default:
        fail(id, -32601, `Unknown method \`${method}\`.`);
    }
  };

  const input = createInterface({ input: streams.input });
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: Request;
    try {
      request = JSON.parse(trimmed) as Request;
    } catch {
      process.stderr.write("[resolve] ignored malformed JSON-RPC line\n");
      return;
    }
    try {
      handle(request);
    } catch (error) {
      process.stderr.write(`[resolve] ${designerFailure(String(error))}\n`);
    }
  });
  input.on("close", () => streams.onClose?.());
}

/** Process entry. stdout is protocol only. */
export function startMcpStdio(): void {
  attachMcpStdio({
    input: process.stdin,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    onClose: () => process.exit(0),
  });
  process.stderr.write(`[resolve] MCP server ready — ${listToolDefinitions().length} tools\n`);
}
