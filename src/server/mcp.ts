import { createInterface } from "node:readline";
import { listToolDefinitions, ToolError, callTool, encodeToolResult } from "./tools";

/**
 * MCP server over stdio.
 *
 * Newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol traffic
 * and nothing else — every diagnostic goes to stderr, because one stray
 * console.log corrupts the stream and the client just sees a dead server.
 *
 * Deliberately dependency-free: this process is what a chat session talks to,
 * and it should start instantly and never break on an SDK upgrade.
 */

const SERVER_INFO = { name: "resolve-figma", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

interface Request {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(request: Request): void {
  const { id, method, params } = request;

  // Notifications carry no id and expect no response.
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Resolve is for AI tools (Cursor, Claude) with Figma MCP. Learning needs a paid Figma seat with MCP access (Dev or Full), or a Figma access token for REST ingest. " +
          "View or free seats have a low read quota — learn a few frames, stop; SOCK saves progress and resumes next session. Big libraries: checkpointed multi-pass learn_library, not a whole-file dump. " +
          "Forced path: learn_library (get_metadata XML + fileKey + role=library; pass search_design_system / get_libraries as libraries to stamp published keys) → recipe if the screen job matches → recommend unbound slots → place only returned fileKey + nodeId (and componentKey when published) via Figma use_figma → verify_frame. " +
          "On verify pass, SOCK records usage automatically. Rules never auto-change (SOCI proposals stay pending). " +
          "If freshness.stale, learn_library only the changed frames. " +
          "resolve \"<name>\" is I-know-the-name-give-me-the-id. " +
          "Do not invent components. Do not Read or dump graph.json. Do not hand-build capture JSON. " +
          "Default tools: learn_library, recipe, recommend, resolve, verify_frame, check_cousins. Set RESOLVE_MCP_ADVANCED=1 for the rest.",
      });
      return;

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, { tools: listToolDefinitions() });
      return;

    case "tools/call": {
      const call = (params ?? {}) as { name?: string; arguments?: unknown };
      if (!call.name) {
        fail(id, -32602, "tools/call requires a tool name.");
        return;
      }
      try {
        const result = callTool(call.name, call.arguments);
        reply(id, {
          content: [{ type: "text", text: encodeToolResult(result) }],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A tool-level failure is reported inside the result, not as a
        // protocol error, so the model can read it and correct itself.
        if (error instanceof ToolError) {
          reply(id, { content: [{ type: "text", text: message }], isError: true });
        } else {
          process.stderr.write(`[resolve] ${message}\n`);
          reply(id, { content: [{ type: "text", text: `Internal error: ${message}` }], isError: true });
        }
      }
      return;
    }

    default:
      fail(id, -32601, `Unknown method \`${method}\`.`);
  }
}

const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: Request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    process.stderr.write("[resolve] ignored malformed JSON-RPC line\n");
    return;
  }
  try {
    handle(request);
  } catch (error) {
    process.stderr.write(`[resolve] ${String(error)}\n`);
  }
});

input.on("close", () => process.exit(0));

process.stderr.write(`[resolve] MCP server ready — ${listToolDefinitions().length} tools\n`);
