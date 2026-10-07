# Screen recipes

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

## Plain English

A **recipe** is a shopping list for a common screen — checkout summary, sign-in, empty state, and so on. Each item on the list is a **slot** (header, Primary button, optional input). After you ingest the library, Resolve tries to fill those slots with **live masters** (the main components in Figma), not new ones.

A **context pack** is a second small file that says *this product* and *this journey step*. Use it when one library serves more than one product, so “Primary button” means Storefront checkout, not admin settings.

You edit JSON. Agents get a short card with real Figma component ids. They never invent ids. The step-by-step walkthrough, including a line-by-line context pack, is in the [designer guide](GUIDE.md).

The rest of this page is the JSON shape if you are adding or replacing a recipe.

---

## Who edits what

| You | You do |
|-----|--------|
| **Designer** | Add or edit recipes in JSON. Optionally bind a slot to a master that already exists after ingest. Drop a product + journey pack in `.resolve/context-packs.json` and bind it with `recipeIds`. |
| **Agent** | `list_recipes` → `recipe "checkout summary"` → pick any open slot → open the real example (`get_example`; `ex` is on the top pick) → clone → fill → `verify_frame`. Never dump the stored library map. |

Recipes do **not** create components. Never invent a Figma component id.

## After ingest (what a slot means)

When a library map exists, **list** and **get** match each slot against live masters:

| Slot status | Meaning |
|-------------|---------|
| **bound** | You already named a master; it is still in the library and not retired. Place that id. |
| **filled** | No stored id (or it was skipped); recommend picked a live master. Place that id. |
| **missing** | The master you named is not in the library. The card includes `nextRecommend`. Do not invent a replacement id. |
| **deprecated** | That master is marked retired. The card includes `nextRecommend` for a live stand-in. |
| **unbound** | No live match. The card includes `nextRecommend`. Call `recommend` with that query. |

Your file **`.resolve/recipes.json` still wins** over the starter pack (same `id` replaces). Binding never writes invented ids into your overlay.

A matching **context pack** (product + journey) is mixed into slot fills and `nextRecommend` so ranking is for *this* product and *this* step, not a generic name match. See [Context packs](#context-packs) or the [guide](GUIDE.md).

You can list recipes with no library map yet. Slots stay `unbound` and each one still returns `nextRecommend`. Filling ids needs ingest first.

## Files

| File | Role |
|------|------|
| [`src/data/recipes.json`](../src/data/recipes.json) | Starter pack shipped with Resolve (8 common screens). |
| `.resolve/recipes.json` | Your overlay. Same shape. Matching `id` replaces a starter recipe; new ids append. |
| [`.resolve/context-packs.json`](#context-packs) | Product + journey context. Bind to recipes via `recipeIds` or `contextPackId`. |
| [`src/data/context-packs.example.json`](../src/data/context-packs.example.json) | Copy-paste template. Not loaded until you drop it in `.resolve/`. |

## Add a recipe

1. Copy `src/data/recipes.json` to `.resolve/recipes.json`, or create a small overlay that only contains the recipes you are adding.
2. Append an object:

```json
{
  "version": 1,
  "recipes": [
    {
      "id": "promo-banner",
      "title": "Promo banner",
      "intentAliases": ["promo", "campaign strip"],
      "notes": "Optional. Shown on the recipe card.",
      "slots": [
        { "role": "message", "required": true, "hints": ["banner", "message"] },
        { "role": "primary-cta", "required": true, "hints": ["button", "primary"] },
        { "role": "input", "required": false, "hints": ["input"] }
      ]
    }
  ]
}
```

3. Leave `defaultMasterId` off unless that master is already in the ingested library (library id, Figma component id, or exact master name). Never invent an id.
4. `hints` are what `recommend` searches. Use words that match your library names (button, input, card, row).

To replace a starter recipe, reuse its `id` (for example `checkout-summary`) in your overlay.

Optional: bind a context pack from the recipe side with `"contextPackId": "storefront-checkout-summary"`. Prefer listing `recipeIds` on the pack so one product/journey file owns the bind.

## Context packs

Designers that share one Figma library across products add a **product + journey** pack so `recipe` / `recommend` pick masters for *this* product and *this* step — not a generic name match.

Copy [`src/data/context-packs.example.json`](../src/data/context-packs.example.json) to `.resolve/context-packs.json` (or write a smaller file). Human-editable. **Never add Figma component ids.** Line-by-line meaning: [designer guide](GUIDE.md#how-to-write-a-context-pack).

```json
{
  "version": 1,
  "active": "storefront-checkout-summary",
  "packs": [
    {
      "id": "storefront-checkout-summary",
      "product": { "id": "storefront", "name": "Storefront" },
      "domain": "checkout",
      "journey": { "step": "summary", "screenJob": "checkout summary" },
      "audience": "returning shopper",
      "constraints": { "density": "compact", "a11y": "wcag-aa" },
      "recipeIds": ["checkout-summary"],
      "libraryRules": { "deny": ["Banner"] }
    }
  ]
}
```

`product` and `journey` also accept a string (`"Storefront"`, `"summary"`). `libraryRules` is the same `{ allow, deny }` shape as `.resolve/library-rules.json`.

**Bind order:** a named `--pack` / MCP `pack` when that id exists and its product does not fight `--product`. Otherwise a pack whose product matches `--product` exactly, and whose journey matches when `--journey` was passed. One shared word is not a match. With no product in the document: recipe `contextPackId`, then a single `recipeIds` bind, then `active` (only if the document named no product). `--audience` and `--a11y` are echoed (`AA` is stored as `wcag-aa`) and do not change the pick.

`recommend` uses a matched pack's product and journey **on top of** existing ranking: name/intent, variants, where-used, live over stale, retired last. Audience, density, and a11y do not. Empty match still means do not invent.

`verify_frame` stays invent / retired / unmatched. Pack `libraryRules` can deny a master. Wrong-cousin drift (same role, different family than the shared DS) is `resolve cousins` / `check_cousins` when `.resolve/workspace.json` has a library-role file.

Optional pack fields: `files` (product/client file keys or labels from the workspace) and `client` (same shape as `product`, when product ≠ client). Same pack schema — not a second model. Recommend still prefers library-role masters.

## Try it

```bash
npm run build:server
npm run resolve -- ingest '<figma-url>'
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout primary button"
npm run resolve -- recommend "primary button" --pack storefront-checkout-summary
npm run resolve -- recommend "primary button" --product Storefront --journey summary --domain checkout
npm run resolve -- example "Button"
# clone that instance, fill it, place only the returned Figma component ids (fileKey + figmaNodeId)
npm run resolve -- verify "Checkout Summary"
npm run resolve -- cousins "Checkout Summary" --job "checkout summary"
```

MCP: `list_recipes`, `recipe` / `get_recipe` (query = id, title, or intent), `recommend` (optional `pack` / `product` / `journey` / `domain`). After ingest, recipe slots bind to live masters. Context packs scope those fills.
