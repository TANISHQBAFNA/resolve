import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion";
import { clearCache } from "@/server/store";

const KIT = `
<frame id="1:1" name="Kit">
  <component-set id="2:1" name="Acme Button">
    <component id="2:11" name="Kind=Primary, Size=Large" />
  </component-set>
  <frame id="2:5" name="Acme Banner">
    <symbol id="2:51" name="Tone=Promo" />
  </frame>
  <component id="2:2" name="Acme Badge" />
</frame>`;

const saved = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
afterEach(() => {
  for (const [key, value] of [["RESOLVE_HOME", saved.home], ["RESOLVE_MODE", saved.mode]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearCache();
});

describe("get_metadata learn keeps variant names", () => {
  it("reads Prop=Value names inside a set as variant properties, like REST", () => {
    const doc = adaptFigmaMcpMetadata({ fileKey: "ACMEKIT", fileName: "Acme Kit", metadataXml: KIT });
    const nodes = JSON.stringify(doc);
    expect(nodes).toContain('"variantProperties":{"Kind":"Primary","Size":"Large"}');
    expect(nodes).toContain('"variantProperties":{"Tone":"Promo"}');
  });

  it("does not read a loose component with = in its name as a variant", () => {
    const doc = adaptFigmaMcpMetadata({ fileKey: "ACMEKIT", fileName: "Acme Kit", metadataXml: `<frame id="1:1" name="Kit"><component id="3:1" name="Ratio=Wide" /><component id="3:2" name="Acme Card" /></frame>` });
    expect(JSON.stringify(doc)).not.toContain("variantProperties");
  });

});
