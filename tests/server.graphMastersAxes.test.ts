import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphMasters } from "@/server/graphMasters";
import { learnLibrary } from "@/server/learn";
import { clearCache } from "@/server/store";

const KIT = `<frame id="1:1" name="Kit">
  <component-set id="10:0" name="Table cell">
    <component id="10:1" name="Data type=Text, Align=Left" />
    <component id="10:2" name="Data type=Amount, Align=Right" />
    <component id="10:3" name="Data type=Email, Align=Left" />
  </component-set>
</frame>`;

const saved = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
afterEach(() => {
  for (const [key, value] of [["RESOLVE_HOME", saved.home], ["RESOLVE_MODE", saved.mode]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearCache();
});

describe("Figma masters for the code catalog keep property names", () => {
  it("lists each variant axis with its values, next to the flat list", () => {
    const store = join(mkdtempSync(join(tmpdir(), "resolve-axes-")), ".resolve");
    mkdirSync(store, { recursive: true });
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "both";
    clearCache();
    learnLibrary({ fileKey: "PROPLAB", role: "library", fileName: "Props Lab", metadataXml: KIT });
    const cell = graphMasters().find((m) => m.name === "Table cell");
    expect(cell?.properties).toEqual({ "Data type": ["Text", "Amount", "Email"], Align: ["Left", "Right"] });
    expect(cell?.variants).toEqual(["Amount", "Email", "Left", "Right", "Text"]);
  });
});
