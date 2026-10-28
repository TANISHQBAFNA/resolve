import { describe, expect, it } from "vitest";
import { engineShortlist, stableShortlist } from "@/core/query/meaning/sock";
import type { MeaningPack, SockComponent } from "@/core/query/meaning/sock";

function component(id: string, name: string, description: string): SockComponent {
  return {
    id,
    name,
    aliases: [],
    description,
    job: "",
    properties: [],
    propOptions: {},
    retired: false,
    thin: [],
  };
}

const button = component("button", "Button", "Primary action that submits the form.");
const pack: MeaningPack = {
  library: "Acme",
  vocab: "acme",
  builtAt: "2026-01-01T00:00:00.000Z",
  components: [
    button,
    component("link", "Link", "Text link that navigates to another page."),
    component("badge", "Badge", "Small status label."),
    component("form", "Form", "Form that submits the fields."),
  ],
};

describe("stable AI-pick shortlist", () => {
  it("keeps the lead first and sorts the other offered ids", () => {
    expect(stableShortlist("button", ["link", "button", "badge"])).toEqual(["button", "badge", "link"]);
    expect(stableShortlist("button", ["link", "button", "badge", "button"])).toEqual(["button", "badge", "link"]);
    expect(stableShortlist("missing", ["zeta", "alpha"])).toEqual(["alpha", "zeta"]);
    expect(stableShortlist(undefined, ["b", "a", "c", "d"])).toEqual(["a", "b", "c"]);
  });

  it("fills slots 2 and 3 from the pack, independent of the model's order", () => {
    const ask = "submit the form";
    const forward = engineShortlist(pack, button, ask, ["badge", "link"]);
    const backward = engineShortlist(pack, button, ask, ["link", "badge"]);
    expect(forward).toEqual(backward);
    expect(forward[0]).toBe("button");
    expect(forward).toContain("form");
    expect(forward).toHaveLength(3);
  });
});
