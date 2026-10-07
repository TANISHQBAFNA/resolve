import { describe, expect, it } from "vitest";
import acmeFile from "../docs/examples/acme-ui.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import {
  fillRecipe,
  handoffSheet,
  indexGraph,
  packForRecipe,
  parseContextPackFile,
  parseRecipeFile,
  recommendMasters,
  type Recipe,
} from "@/core/query";

const FROZEN = "2026-01-01T00:00:00.000Z";

const index = indexGraph(
  buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN }),
);

function confirmRecipe(primaryDefault?: string): Recipe {
  return parseRecipeFile({
    recipes: [
      {
        id: "confirm-dialog",
        title: "Confirm dialog",
        intentAliases: ["confirm", "Confirm payment"],
        slots: [
          { role: "body", required: true, hints: ["card"] },
          {
            role: "primary-cta",
            required: true,
            hints: ["button", "primary"],
            ...(primaryDefault ? { defaultMasterId: primaryDefault } : {}),
          },
          { role: "secondary-cta", required: false, hints: ["button", "secondary"] },
        ],
      },
    ],
  })[0]!;
}

const packs = parseContextPackFile({
  packs: [
    {
      id: "acme-payments-confirm",
      product: { id: "acme-payments", name: "Acme Payments" },
      domain: "payments",
      journey: { step: "confirm", screenJob: "confirm payment" },
      recipeIds: ["confirm-dialog"],
    },
  ],
}).packs;

const confirm = confirmRecipe();
const pack = packForRecipe(confirm, { packs });

describe("a context pack linked to a recipe still fills its slots", () => {
  it("fills Button slots on the Acme confirm dialog when the payments pack points at the recipe", () => {
    expect(pack?.id).toBe("acme-payments-confirm");
    const bare = fillRecipe(index, confirm);
    const linked = fillRecipe(index, confirm, undefined, pack);
    const buttonSlots = (recipe: ReturnType<typeof fillRecipe>) =>
      recipe.slots.filter((slot) => slot.role.endsWith("cta"));

    expect(buttonSlots(bare).every((slot) => slot.status === "filled" && slot.master?.name === "Button")).toBe(true);
    expect(buttonSlots(linked).map((slot) => ({ role: slot.role, status: slot.status, name: slot.master?.name }))).toEqual(
      buttonSlots(bare).map((slot) => ({ role: slot.role, status: slot.status, name: slot.master?.name })),
    );
    expect(linked.context?.id).toBe("acme-payments-confirm");
    expect(linked.slots.find((slot) => slot.role === "body")?.status).toBe("unbound");

    const ask = "button primary";
    expect(recommendMasters(index, ask, { context: pack }).candidates[0]?.name).toBe("Button");
    expect(recommendMasters(index, ask).candidates[0]?.name).toBe("Button");
  });

  it("keeps a stored default master when the same pack is linked", () => {
    const pinned = confirmRecipe("Button");
    const filled = fillRecipe(index, pinned, undefined, packForRecipe(pinned, { packs }));
    const primary = filled.slots.find((slot) => slot.role === "primary-cta");
    expect(primary?.status).toBe("bound");
    expect(primary?.master?.name).toBe("Button");
    const avatar = confirmRecipe("Avatar");
    const pinnedAvatar = fillRecipe(index, avatar, undefined, packForRecipe(avatar, { packs }));
    const avatarSlot = pinnedAvatar.slots.find((slot) => slot.role === "primary-cta");
    expect(avatarSlot?.status).toBe("bound");
    expect(avatarSlot?.master?.name).toBe("Avatar");
  });

  it("handoff of Acme Confirm payment still names Button for the primary slot", () => {
    const sheet = handoffSheet(index, ["Confirm payment"], {
      recipe: "confirm-dialog",
      recipes: [confirm],
      context: pack,
    });
    expect(sheet.ok).toBe(true);
    if (!sheet.ok) return;
    const screen = sheet.screens[0]!;
    const primary = screen.recipe?.slots.find((slot) => slot.role === "primary-cta");
    expect(primary?.status).toBe("filled");
    expect(primary?.component?.name).toBe("Button");
    expect(screen.recipe?.coverage).toEqual({ slots: 3, covered: 2, placed: 1, inside: 1 });
  });
});
