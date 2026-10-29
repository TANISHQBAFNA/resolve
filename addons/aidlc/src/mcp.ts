import { withCost } from "@/public";
import { aidlcFromFolder } from "./exportCommand";

/** Advanced MCP tool for the AIDLC export. Default tools do not change. */
export const EXPORT_TOOL = {
  name: "export_aidlc",
  description:
    "Opt-in AIDLC hook. Turns a handoff --out folder (handoff.json + decision.json) into the resolve.aidlc schemaVersion 1 contract: requirementsContext in, designHandoff out. Reads files only; never runs a handoff. Advanced surface.",
  inputSchema: { type: "object", properties: { folder: { type: "string", description: "A folder written by resolve handoff --out." } }, required: ["folder"] },
};

/** Same call the core MCP server used: advanced surface only, folder required, cost block attached. */
export function callTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== EXPORT_TOOL.name) throw new Error(`Unknown tool \`${name}\`.`);
  if (process.env["RESOLVE_MCP_ADVANCED"] !== "1") {
    throw new Error(`Tool "${name}" is not on the default MCP surface. Set RESOLVE_MCP_ADVANCED=1 to enable it. Agents cannot call advanced tools.`);
  }
  const folder = typeof args["folder"] === "string" ? args["folder"] : "";
  if (!folder.trim()) throw new Error("export_aidlc needs folder: the folder resolve handoff --out wrote. It never uses the current folder by itself.");
  return withCost(aidlcFromFolder(folder));
}
