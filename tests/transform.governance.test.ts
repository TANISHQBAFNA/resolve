import { describe, expect, it } from "vitest";
import { parseGovernance } from "@/core/model";
import { graph, ids, index, node } from "./fixture";

describe("parseGovernance", () => {
  it("reads front-matter over keywords", () => {
    const parsed = parseGovernance("Banner", "status: deprecated\nowner: payments\nplatform: web, ios");
    expect(parsed.status).toBe("deprecated");
    expect(parsed.statusSource).toBe("front-matter");
    expect(parsed.owner).toBe("payments");
    expect(parsed.platforms).toEqual(["web", "ios"]);
  });

  it("treats [deprecated] in the name as EXTRACTED-from-name", () => {
    expect(parseGovernance("Alert [deprecated]").statusSource).toBe("name");
  });

  it("does not treat 'not yet adopted' as deprecated", () => {
    expect(parseGovernance("Banner", "Inline message. Not yet adopted.").status).toBeUndefined();
  });

  it("treats do not use, retired, and legacy in the description as deprecated", () => {
    expect(parseGovernance("Banner", "do not use this banner").status).toBe("deprecated");
    expect(parseGovernance("Alert", "retired in favour of Toast").status).toBe("deprecated");
    expect(parseGovernance("Chip", "legacy control").status).toBe("deprecated");
  });
});

describe("graph governance", () => {
  it("marks Banner deprecated from its Figma description", () => {
    const banner = node(ids.banner);
    expect(banner.status).toBe("deprecated");
    expect(banner.owner).toBe("payments");
    expect(banner.metadata?.["statusSource"]).toBe("front-matter");
  });

  it("materialises a GOVERNS edge from documentation links", () => {
    const edge = graph.edges.find(
      (item) => item.type === "GOVERNS" && item.target === ids.banner,
    );
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe("EXTRACTED");
    const note = index.getNode(edge!.source);
    expect(note?.type).toBe("ANNOTATION");
  });

  it("tags name-matched instance edges INFERRED", () => {
    expect(
      graph.edges.some((edge) => edge.type === "INSTANCE_OF" && edge.confidence === "INFERRED"),
    ).toBe(false);
  });
});
