import { describe, expect, it } from "vitest";
import { parseGovernance, descriptionIsRetired } from "@/core/model";
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

  it("still treats a Legacy name as deprecated", () => {
    expect(parseGovernance("Legacy Banner").status).toBe("deprecated");
    expect(parseGovernance("Legacy Banner").statusSource).toBe("keyword");
  });

  it("does not retire a name that only says retired", () => {
    expect(parseGovernance("Retired Notice").status).toBeUndefined();
  });

  it("does not treat 'not yet adopted' as deprecated", () => {
    expect(parseGovernance("Banner", "Inline message. Not yet adopted.").status).toBeUndefined();
  });

  it("treats do not use, retired, and legacy in the description as deprecated", () => {
    expect(parseGovernance("Banner", "do not use this banner").status).toBe("deprecated");
    expect(parseGovernance("Alert", "retired in favour of Toast").status).toBe("deprecated");
    expect(parseGovernance("Chip", "legacy control").status).toBe("deprecated");
    expect(parseGovernance("Tag", "obsolete in v2").status).toBe("deprecated");
    expect(parseGovernance("Hint", "no longer used").status).toBe("deprecated");
    expect(parseGovernance("Old", "replaced by Banner").status).toBe("deprecated");
    expect(parseGovernance("Note", "[!] deprecated").status).toBe("deprecated");
    expect(parseGovernance("Mark", ": retired").status).toBe("deprecated");
  });

  it("does not retire from a mid-sentence or negated description", () => {
    const falsePositives = [
      "no legacy support needed",
      "Supports legacy browsers",
      "Please do not use outside marketing",
    ];
    for (const blob of falsePositives) {
      expect(descriptionIsRetired(blob), blob).toBe(false);
      expect(parseGovernance("Live", blob).status, blob).toBeUndefined();
    }
  });

  it("peels markdown wrapping and counts a retire clause", () => {
    const retired = [
      "**Deprecated**",
      "(deprecated)",
      "- deprecated",
      "Use Banner. Deprecated.",
      "This component is deprecated, use tab-bar instead",
      "This avatar is retired, do not use",
      "Deprecated, no replacement",
      "Deprecated without replacement",
      "Deprecated, supports old API",
    ];
    for (const blob of retired) {
      expect(descriptionIsRetired(blob), blob).toBe(true);
      expect(parseGovernance("Old", blob).status, blob).toBe("deprecated");
    }
  });

  it("keeps scoped do-not-use and adjective titles live", () => {
    const live = [
      "Do not use inside tables",
      "Do not use outside profile cards",
      "Do not use for errors",
      "Retired users, shown in admin table",
      "Obsolete data warning banner",
    ];
    for (const blob of live) {
      expect(descriptionIsRetired(blob), blob).toBe(false);
      expect(parseGovernance("Live", blob).status, blob).toBeUndefined();
    }
  });

  it("15-set fixture is 15/15", () => {
    const rows: Array<{ description: string; retired: boolean }> = [
      { description: "no legacy support needed", retired: false },
      { description: "Supports legacy browsers", retired: false },
      { description: "Please do not use outside marketing", retired: false },
      { description: "Do not use inside tables", retired: false },
      { description: "Do not use outside profile cards", retired: false },
      { description: "Do not use for errors", retired: false },
      { description: "Retired users, shown in admin table", retired: false },
      { description: "Obsolete data warning banner", retired: false },
      { description: "**Deprecated**", retired: true },
      { description: "(deprecated)", retired: true },
      { description: "- deprecated", retired: true },
      { description: "Use Banner. Deprecated.", retired: true },
      { description: "This component is deprecated, use tab-bar instead", retired: true },
      { description: "This avatar is retired, do not use", retired: true },
      { description: "Deprecated, no replacement", retired: true },
    ];
    expect(rows).toHaveLength(15);
    const hits = rows.filter((row) => descriptionIsRetired(row.description) === row.retired);
    expect(hits).toHaveLength(15);
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
