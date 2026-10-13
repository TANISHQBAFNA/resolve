import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { handoffSheet, indexGraph, recommendMasters, verifyFrame } from "@/core/query";
import { topLevelMasterIds } from "@/core/query/soci";
import type { GraphIndex } from "@/core/query/GraphIndex";

function indexFrom(xml: string): GraphIndex {
  return indexGraph(
    buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "FILE",
        fileName: "File",
        metadataXml: xml,
        ingestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
}

const SCREEN = `
<frame id="1:1" name="Details">
  <instance id="1:2" name="page-shell">
    <slot id="1:3" name="content-area">
      <instance id="1:4" name="input-field" />
    </slot>
  </instance>
  <instance id="1:5" name="top-bar" />
  <instance id="1:6" name="unused-button" hidden="true" />
</frame>`;

const KIT = `
<frame id="1:1" name="Kit">
  <component id="10:1" name="ingredients/input-field" />
  <component id="10:2" name="base/text-area" />
  <component id="10:3" name="ingredients/text-area" />
  <frame id="10:4" name="ingredients/button">
    <symbol id="10:41" name="Type=Primary" />
    <symbol id="10:42" name="Type=Tertiary" />
  </frame>
  <component id="10:5" name="bottom-action-bar" />
</frame>`;

describe("slots, hidden layers, and tier prefixes", () => {
  it("treats an instance in a slot as placed and leaves a hidden instance out", () => {
    const index = indexFrom(SCREEN);
    const slot = index.allNodes.find((node) => node.name === "content-area");
    expect(slot?.metadata?.["slot"]).toBe(true);
    const frame = index.getNodesByType("FRAME").find((node) => node.name === "Details");
    expect(frame).toBeDefined();
    const names = topLevelMasterIds(index, frame!.id).map((id) => index.getNode(id)?.name);
    expect(names).toEqual(expect.arrayContaining(["page-shell", "input-field", "top-bar"]));
    expect(names).not.toContain("unused-button");

    const sheet = handoffSheet(index, ["Details"], { draft: true });
    expect(sheet.ok).toBe(true);
    if (!sheet.ok) return;
    const placed = sheet.screens[0]?.components.map((component) => component.name) ?? [];
    expect(placed).toContain("input-field");
    expect(placed).not.toContain("unused-button");

    const verified = verifyFrame(index, { frame: "Details" });
    expect(JSON.stringify(verified)).not.toContain("unused-button");
  });

  it("reads a tier prefix as a path and prefers ingredients over base", () => {
    const index = indexFrom(KIT);
    const input = recommendMasters(index, "input field");
    expect(input.candidates[0]?.name).toBe("ingredients/input-field");
    expect(input.match).not.toBe("weak match");

    const area = recommendMasters(index, "text area");
    expect(area.candidates[0]?.name).toBe("ingredients/text-area");
    expect(area.candidates.map((row) => row.name)).not.toContain("base/text-area");

    const primary = recommendMasters(index, "primary button");
    expect(primary.candidates[0]?.name).toMatch(/button/i);
    expect(primary.match).not.toBe("weak match");

    const tertiary = recommendMasters(index, "tertiary button");
    expect(tertiary.candidates[0]?.name).toMatch(/button/i);
    expect(tertiary.candidates[0]?.name).not.toMatch(/bottom-action-bar/);
  });
});
