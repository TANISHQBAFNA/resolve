import { withCost } from "@/public";
import { aidlcFromFolder, idsFromFolder } from "./exportCommand";

/** Advanced MCP tool for the AIDLC export. Default tools do not change. */
export const EXPORT_TOOL = {
  name: "export_aidlc",
  description:
    "Opt-in AIDLC hook. Turns a handoff --out folder (handoff.json + decision.json) into the resolve.aidlc schemaVersion 1 contract: requirementsContext in, designHandoff out. Reads files only; never runs a handoff. Advanced surface. ids:true returns the versioned component id report instead (advisory, never blocks).",
  inputSchema: {
    type: "object",
    properties: {
      folder: { type: "string", description: "A folder written by resolve handoff --out." },
      ids: { type: "boolean", description: "Return the versioned component id and version drift report for this handoff." },
    },
    required: ["folder"],
  },
};

/** Same call the core MCP server used: advanced surface only, folder required, cost block attached. */
export function callTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== EXPORT_TOOL.name) throw new Error(`Unknown tool \`${name}\`.`);
  if (process.env["RESOLVE_MCP_ADVANCED"] !== "1") {
    throw new Error(`Tool "${name}" is not on the default MCP surface. Set RESOLVE_MCP_ADVANCED=1 to enable it. Agents cannot call advanced tools.`);
  }
  const folder = typeof args["folder"] === "string" ? args["folder"] : "";
  if (!folder.trim()) throw new Error("export_aidlc needs folder: the folder resolve handoff --out wrote. It never uses the current folder by itself.");
  return withCost(args["ids"] === true ? idsFromFolder(folder) : aidlcFromFolder(folder));
}
