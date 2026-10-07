import { describe, expect, it } from "vitest";
import { DESIGNER, designerFailure } from "@/server/designerMessages";
import { missingGraphMessage } from "@/server/store";

describe("designer failures", () => {
  it("maps the five slash-command failures to one plain sentence and drops a stack", () => {
    expect(designerFailure("Not a Figma file URL or file key: hello")).toBe(DESIGNER.badLink);
    expect(designerFailure("Give a Figma file URL or file key.")).toBe(DESIGNER.badLink);
    const token = "Set FIGMA_ACCESS_TOKEN to ingest a live Figma file.\n    at Module._compile (node:internal/modules/cjs/loader:1364:14)";
    expect(designerFailure(token)).toBe(DESIGNER.token);
    expect(designerFailure(token)).not.toMatch(/at Module|node:internal/);
    expect(designerFailure("Figma authentication failed")).toBe(DESIGNER.token);
    expect(designerFailure("token expired")).toBe(DESIGNER.token);
    expect(designerFailure("Figma authorization failed: View seat cannot call this API")).toBe(DESIGNER.viewSeat);
    expect(designerFailure("Figma authorization failed for ACMEUI: Forbidden")).toBe(DESIGNER.viewSeat);
    expect(designerFailure("No file at /tmp/nope.json. Pass a JSON path, a Figma URL, or a file key (with FIGMA_ACCESS_TOKEN).")).toContain("No file at /tmp/nope.json");
    expect(designerFailure("No file at /tmp/nope.xml.")).toContain("No file at /tmp/nope.xml");
    expect(designerFailure("This account is on a free seat")).toBe(DESIGNER.viewSeat);
    expect(designerFailure(missingGraphMessage())).toBe(DESIGNER.nothingLearned);
    expect(designerFailure("Resolve MCP is not built. In this repo: npm run build:server")).toBe(DESIGNER.notInstalled);
    expect(designerFailure("Error: ENOENT no such file")).toBe(DESIGNER.notInstalled);
  });

  it("leaves a plain refusal alone and never returns a stack frame", () => {
    const plain = 'Unknown handoff option "--bogus"';
    expect(designerFailure(plain)).toBe(plain);
    const noisy = `${plain}\n    at runCli (node_modules/resolve-figma/dist-server/cli.mjs:1:1)`;
    expect(designerFailure(noisy)).toBe(plain);
    expect(designerFailure("    at only a stack (node:internal/modules/cjs/loader:1:1)")).toBe(DESIGNER.generic);
  });
});
