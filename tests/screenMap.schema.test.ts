import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import type { ScreenMapDocument } from "@/core/screenMap/types";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "schemas/screen-map.schema.json"), "utf8")) as object;
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function loadFixture(): ScreenMapDocument {
  return JSON.parse(readFileSync(join(root, "fixtures/acme-screen-map/input-field.json"), "utf8")) as ScreenMapDocument;
}

function errorsOf(data: unknown): string {
  if (validate(data)) return "";
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`).join("\n");
}

describe("screen map schema", () => {
  it("validates the Acme input-field tree, including a hidden helper controlled by showHelper", () => {
    const doc = loadFixture();
    expect(errorsOf(doc)).toBe("");
    const helper = doc.nodes["node:instance:helper"];
    expect(helper?.flags?.hidden).toBe(true);
    expect(helper?.controlledBy?.property).toBe("showHelper");
    expect(helper?.text).toEqual({ present: true, lines: 1 });
    const input = doc.nodes["node:instance:input"];
    expect(input?.ds?.componentProperties).toMatchObject({ size: "md", state: "error", required: true, showHelper: false });
    expect(input?.childIds).toContain("node:instance:helper");
    expect(JSON.stringify(doc)).not.toMatch(/characters|thumbnailUrl/);
  });

  it("rejects a characters field and a thumbnailUrl field", () => {
    const withCharacters = loadFixture();
    (withCharacters.nodes["node:text:label"] as { characters?: string }).characters = "Amount due";
    expect(errorsOf(withCharacters)).toMatch(/additional properties|characters/i);

    const withThumb = loadFixture();
    (withThumb.nodes["node:screen:payment"] as { thumbnailUrl?: string }).thumbnailUrl = "https://example.invalid/thumb.png";
    expect(errorsOf(withThumb)).toMatch(/additional properties|thumbnailUrl/i);
  });

  it("allows the reserved meaning fields only when they are null", () => {
    const doc = loadFixture();
    doc.nodes["node:instance:input"]!.partJob = null;
    doc.nodes["node:instance:input"]!.slot = null;
    expect(errorsOf(doc)).toBe("");
    (doc.nodes["node:instance:input"] as { partJob?: unknown }).partJob = "label";
    expect(errorsOf(doc)).not.toBe("");
  });
});
