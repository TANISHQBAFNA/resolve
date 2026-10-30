import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnLibrary } from "@/server/learn";
import { clearCache, loadGraph, loadLearnCheckpoint, saveLearnCheckpoint } from "@/server/store";
import { hashLearnPayload, LEARN_PARSER_VERSION } from "@/core/ingestion/learnLibrary";

const XML = `<frame id="1:1" name="Kit"><component_set id="5:1" name="Button"><component id="5:2" name="Type=Primary, Size=L" /><component id="5:3" name="Type=Ghost, Size=S" /></component_set></frame>`;

describe("re-learn skip includes the parser version", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-parser-"));
    clearCache();
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    clearCache();
  });

  it("the hash depends on the parser version, not only on the payload", () => {
    const payloadOnly = createHash("sha256").update(XML).digest("hex").slice(0, 16);
    expect(LEARN_PARSER_VERSION).toBeGreaterThanOrEqual(2);
    expect(hashLearnPayload(XML)).not.toBe(payloadOnly);
    expect(hashLearnPayload(XML)).toBe(hashLearnPayload(XML));
  });

  it("a library learned by an older parser is learned again, not skipped", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: XML });
    const checkpoint = loadLearnCheckpoint("LIB")!;
    const olderHash = createHash("sha256").update(XML).digest("hex").slice(0, 16);
    saveLearnCheckpoint({ ...checkpoint, completedHashes: [olderHash] });
    clearCache();

    const again = learnLibrary({ fileKey: "LIB", role: "library", metadataXml: XML, resume: true });
    expect(again.skippedDuplicate).toBe(false);
    expect(loadLearnCheckpoint("LIB")?.completedHashes).toContain(hashLearnPayload(XML));
    expect(loadGraph()?.graph.nodes.some((node) => node.name === "Button")).toBe(true);

    const third = learnLibrary({ fileKey: "LIB", role: "library", metadataXml: XML, resume: true });
    expect(third.skippedDuplicate).toBe(true);
  });
});
