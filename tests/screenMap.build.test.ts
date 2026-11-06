import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata, adaptFigmaRestFile } from "@/core/ingestion";
import { buildScreenMap, mapIdentityHash, readScreenMap, stableStringify, writeScreenMap } from "@/core/screenMap/document";
import { buildGraph } from "@/core/transform";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN = "2026-11-05T00:00:00.000Z";
const schema = JSON.parse(readFileSync(join(root, "schemas/screen-map.schema.json"), "utf8")) as object;
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

function restFile() {
  return {
    name: "Acme Checkout",
    version: "9",
    document: {
      id: "0:0",
      name: "Acme Checkout",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Checkout",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Payment",
            type: "FRAME",
            layoutMode: "VERTICAL",
            children: [
              { id: "1:2", name: "Hero", type: "RECTANGLE", fills: [{ type: "IMAGE", imageRef: "img", scaleMode: "FILL" }] },
              { id: "1:3", name: "Label", type: "TEXT", characters: "Pay Acme 411122" },
              {
                id: "1:4",
                name: "Helper text",
                type: "TEXT",
                visible: false,
                characters: "Hidden note",
                componentPropertyReferences: { visible: "showHelper#4:1" },
              },
            ],
          },
          { id: "1:9", name: "Review", type: "FRAME", children: [{ id: "1:10", name: "Other", type: "TEXT", characters: "Other screen" }] },
        ],
      }],
    },
  };
}

function graph() {
  return buildGraph(adaptFigmaRestFile({ fileKey: "acme checkout", file: restFile(), kind: "figma-rest", ingestedAt: FROZEN }), { builtAt: FROZEN });
}

describe("screen map builder", () => {
  it("is byte-identical for one file version and stores no words or images", () => {
    const built = graph();
    const first = buildScreenMap(built, { builtAt: FROZEN });
    const second = buildScreenMap(built, { builtAt: "2026-12-01T00:00:00.000Z" });
    expect(mapIdentityHash(first)).toBe(mapIdentityHash(second));
    expect(stableStringify(first)).toBe(stableStringify(buildScreenMap(built, { builtAt: FROZEN })));
    expect(validate(first)).toBe(true);
    const json = stableStringify(first);
    expect(json).not.toContain("Pay Acme");
    expect(json).not.toContain("411122");
    expect(json).not.toContain("Hidden note");
    expect(json).not.toContain("thumbnailUrl");
    expect(json).not.toContain("imageRef");
    const hero = Object.values(first.nodes).find((node) => node.name === "Hero");
    expect(hero?.flags?.hasImageFill).toBe(true);
    const label = Object.values(first.nodes).find((node) => node.name === "Label");
    expect(label?.text).toEqual({ present: true, lines: 1 });
    const helper = Object.values(first.nodes).find((node) => node.name === "Helper text");
    expect(helper?.flags?.hidden).toBe(true);
    expect(helper?.controlledBy).toEqual({ property: "showHelper", type: "BOOLEAN" });
    const payment = Object.values(first.nodes).find((node) => node.name === "Payment");
    expect(payment?.childIds).toContain(helper?.id);
  });

  it("writes under .resolve/private/screen-map and leaves the path gitignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-map-"));
    const doc = buildScreenMap(graph(), { builtAt: FROZEN });
    const written = writeScreenMap(dir, doc);
    expect(written.path).toContain(`${join(".resolve", "private", "screen-map")}`);
    expect(written.rebuilt).toBe(false);
    expect(writeScreenMap(dir, doc).rebuilt).toBe(true);
    expect(mapIdentityHash(readScreenMap(dir, "acme checkout")!)).toBe(mapIdentityHash(doc));
    const ignored = spawnSync("git", ["check-ignore", "-q", ".resolve/private/screen-map/acme@9.json"], { cwd: root });
    expect(ignored.status).toBe(0);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".resolve/private/screen-map/");
  });

  it("marks MCP name guesses as guessed and never extracted", () => {
    const doc = adaptFigmaMcpMetadata({
      fileKey: "acme-checkout",
      fileName: "Acme Checkout",
      ingestedAt: FROZEN,
      metadataXml: `<frame id="1:1" name="Payment" x="0" y="0" width="400" height="800"><instance id="1:2" name="Input field" x="0" y="0" width="120" height="40" /></frame>`,
    });
    const map = buildScreenMap(buildGraph(doc, { builtAt: FROZEN }), { builtAt: FROZEN });
    const guessed = Object.values(map.nodes).filter((node) => node.identity === "guessed");
    expect(guessed.length).toBeGreaterThan(0);
    expect(Object.values(map.nodes).some((node) => node.identity === "extracted")).toBe(false);
    expect(validate(map)).toBe(true);
  });

  it("limits a build to one screen when a frame is passed", () => {
    const map = buildScreenMap(graph(), { builtAt: FROZEN, frameId: "1:1" });
    expect(Object.values(map.nodes).some((node) => node.name === "Payment")).toBe(true);
    expect(Object.values(map.nodes).some((node) => node.name === "Review")).toBe(false);
    expect(Object.values(map.nodes).some((node) => node.name === "Other screen")).toBe(false);
  });
});
