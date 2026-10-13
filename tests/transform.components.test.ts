import { describe, expect, it } from "vitest";
import { graph, hasEdge, ids, index, node } from "./fixture";

describe("instance to main component linking", () => {
  it("links an instance to the exact variant it references", () => {
    const instance = node(ids.instanceWelcomeButton);
    expect(instance.isInstance).toBe(true);
    expect(instance.mainComponentId).toBe(ids.buttonPrimaryMedium);
    expect(hasEdge("INSTANCE_OF", instance.id, ids.buttonPrimaryMedium)).toBe(true);
  });

  it("emits USED_IN as the reverse of INSTANCE_OF", () => {
    expect(hasEdge("USED_IN", ids.buttonPrimaryMedium, ids.instanceWelcomeButton)).toBe(true);
    const instanceOf = graph.edges.filter((edge) => edge.type === "INSTANCE_OF").length;
    const usedIn = graph.edges.filter((edge) => edge.type === "USED_IN").length;
    expect(usedIn).toBe(instanceOf);
  });

  it("copies variant identity from the main component onto the instance", () => {
    const instance = node(ids.instanceWelcomeButton);
    expect(instance.variantProperties).toEqual({ Variant: "Primary", Size: "Medium" });
    expect(instance.componentSetId).toBe(ids.buttonSet);
  });

  it("connects variants to their component set", () => {
    expect(node(ids.buttonPrimaryMedium).componentSetId).toBe(ids.buttonSet);
    expect(hasEdge("VARIANT_OF", ids.buttonPrimaryMedium, ids.buttonSet)).toBe(true);
    expect(index.getVariantsOf(ids.buttonSet).map((variant) => variant.id).sort()).toEqual([
      ids.buttonPrimaryMedium,
      ids.buttonPrimaryLarge,
      ids.buttonSecondaryMedium,
      ids.buttonDanger,
    ].sort());
  });

  it("materialises a remote main component that is not in the file tree", () => {
    const remote = node(ids.remoteBrandMark);
    expect(remote.type).toBe("MAIN_COMPONENT");
    expect(remote.isRemote).toBe(true);
    expect(remote.name).toBe("Brand mark");
    expect(hasEdge("INSTANCE_OF", ids.instanceBrandMark, ids.remoteBrandMark)).toBe(true);
    expect(hasEdge("SOURCED_FROM_LIBRARY", ids.remoteBrandMark, ids.libraryUnknown)).toBe(true);
    expect(node(ids.instanceBrandMark).isRemote).toBe(true);
  });

  it("flags an instance whose main component is missing from the payload", () => {
    const unresolved = node(ids.instanceUnresolved);
    expect(unresolved.isInstance).toBe(true);
    expect(unresolved.mainComponentId).toBeUndefined();
    expect(unresolved.metadata?.["unresolvedMainComponentId"]).toBe("40:99");
    expect(
      graph.warnings.some(
        (warning) =>
          warning.code === "UNRESOLVED_MAIN_COMPONENT" && warning.nodeId === ids.instanceUnresolved,
      ),
    ).toBe(true);
  });

  it("records nesting from the enclosing component definition", () => {
    // The Card component contains an Avatar and a Button instance.
    expect(hasEdge("NESTS", ids.card, ids.instanceCardButtonInComponent)).toBe(true);
    expect(index.getNestedInstances(ids.card).map((n) => n.name).sort()).toEqual([
      "Avatar",
      "Button",
    ]);
  });

  it("records nesting from the enclosing screen frame at any depth", () => {
    const nested = index.getNestedInstances(ids.framePaymentMethods);
    // Two rows, each with a nested avatar and button, plus the brand mark.
    expect(nested).toHaveLength(7);
    expect(hasEdge("NESTS", ids.framePaymentMethods, ids.instanceRowAvatar)).toBe(true);
  });
});

describe("design system relationships", () => {
  it("links style consumers with the slot as the label", () => {
    expect(hasEdge("USES_STYLE", ids.frameWelcome, ids.styleSurface)).toBe(true);
    const edge = graph.edges.find(
      (candidate) =>
        candidate.type === "USES_STYLE" &&
        candidate.source === ids.frameWelcome &&
        candidate.target === ids.styleSurface,
    );
    expect(edge?.label).toBe("FILL");
    expect(node(ids.frameWelcome).styleIds).toContain(ids.styleSurface);
  });

  it("links variable consumers and collection membership", () => {
    expect(hasEdge("USES_VARIABLE", ids.autoLayoutForm, ids.variableSpace4)).toBe(true);
    expect(hasEdge("BELONGS_TO_COLLECTION", ids.variableSpace4, ids.collectionPrimitives)).toBe(
      true,
    );
    expect(index.getVariablesInCollection(ids.collectionSemantic)).toHaveLength(3);
  });

  it("treats a semantic variable alias as a variable dependency", () => {
    expect(hasEdge("USES_VARIABLE", ids.variableActionPrimary, ids.variableBlue)).toBe(true);
  });

  it("attaches remote styles to the external library", () => {
    expect(node(ids.styleRemote).isRemote).toBe(true);
    expect(hasEdge("SOURCED_FROM_LIBRARY", ids.styleRemote, ids.libraryUnknown)).toBe(true);
  });

  it("builds prototype edges between frames and from an interactive instance", () => {
    expect(hasEdge("PROTOTYPES_TO", ids.frameWelcome, ids.frameCreateAccount)).toBe(true);
    expect(hasEdge("PROTOTYPES_TO", ids.frameVerifyEmail, ids.framePaymentMethods)).toBe(true);
    expect(hasEdge("PROTOTYPES_TO", "node:20:24", ids.frameReceipt)).toBe(true);
    expect(graph.edges.filter((edge) => edge.type === "PROTOTYPES_TO")).toHaveLength(6);
  });

  it("does not turn a documentation link from another Figma file into an internal edge", () => {
    expect(hasEdge("LINKS_TO", ids.card, ids.frameUsageGuide)).toBe(false);
  });

  it("keeps external URLs on the node instead of inventing a target node", () => {
    const legalText = node("node:10:26");
    expect(legalText.metadata?.["externalLinks"]).toEqual([
      { url: "https://demo.example.com/legal/terms" },
    ]);
  });
});
