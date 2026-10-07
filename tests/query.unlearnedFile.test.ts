import { describe, expect, it } from "vitest";
import acmeFile from "../docs/examples/acme-ui.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { checkCousins, handoffSheet, indexGraph, screenPartsCard, verifyFrame } from "@/core/query";
import { ingredientCard } from "@/core/query/agentSurface";

const FROZEN = "2026-01-01T00:00:00.000Z";
const OTHER = "https://www.figma.com/design/OTHERKEY/x?node-id=20-40";
const MISSING = "https://www.figma.com/design/ACMEUI/Acme-UI?node-id=99-99";
const NO_NODE = "https://www.figma.com/design/ACMEUI/Acme-UI";

function acmeIndex() {
  const graph = buildGraph(
    adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }),
    { builtAt: FROZEN },
  );
  return indexGraph(graph);
}

describe("H1 a link to a file that is not learned", () => {
  const index = acmeIndex();

  it("verify does not pass a frame from another file", () => {
    const card = verifyFrame(index, { frame: OTHER });
    expect(card.pass).toBe(false);
    expect(card.frame?.name).not.toBe("Send money");
    expect(JSON.stringify(card)).toContain("not learned");
    expect(JSON.stringify(card)).toContain("OTHERKEY");
  });

  it("handoff refuses a link to a file that is not learned", () => {
    const pack = handoffSheet(index, [OTHER]);
    expect(pack.ok).toBe(false);
    if (pack.ok) return;
    expect(pack.refused[0]?.message).toContain("not learned");
    expect(pack.refused[0]?.message).toContain("OTHERKEY");
  });

  it("cousins refuses a link to a file that is not learned", () => {
    const report = checkCousins(index, {
      frame: OTHER,
      workspace: { version: 1, files: [{ key: "ACMEUI", role: "library" }] },
    });
    expect(report.checked).toBe(false);
    expect(report.reason).toBe("file-not-learned");
    expect(report.hint).toContain("OTHERKEY");
  });

  it("a learned file with a missing node is not found, and a link with no node-id is a bad link", () => {
    const missing = handoffSheet(index, [MISSING]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refused[0]?.message).not.toContain(MISSING);
    const bare = handoffSheet(index, [NO_NODE]);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.refused[0]?.message).toContain("figma.com/design/");
    const parts = ingredientCard(index, MISSING);
    expect(parts.found).toBe(false);
    if (!parts.found) expect(parts.hint).toContain("99:99");
  });

  it("parts lists the retired Old Button on Send money instead of refusing", () => {
    const card = screenPartsCard(index, "Send money");
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    const retired = card.parts.find((part) => part.retired);
    expect(retired?.name).toContain("Old Button");
    expect(retired?.replacement).toBeTruthy();
    expect(card.parts.every((part) => part.code === "unmapped" || part.code.length > 0)).toBe(true);
  });
});
