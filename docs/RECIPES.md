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

### Compose a recipe

When no saved recipe fits, ask Resolve to compose one. It only does this when you ask.

```bash
npm run resolve -- recipe "profile page with an avatar, a text field and a save button" --compose
```

- Words before "with" name the screen. Each part after it ("an avatar", "a text field", "a save button") becomes a slot. Place words ("next to", "under", "beside") join two parts: "a toast next to the header bar" is two slots. Words after "on", "in", "inside" or "within" are a part only when they hold a full part name ("on a summary card") or are one word that names exactly one part ("inside a modal"). A generic word that several parts share, or none ("on a card", "in a row", "on the map"), stays context. Otherwise, and always for device, theme and density words ("on mobile", "in dark mode"), they are context, listed under `readAsContext`. When every part is weak, the hint says so instead of No match. "A set of chips" or "a list of badges" names the chips or badges.
- Each slot is filled by `recommend`, the same way a saved recipe's slot is. It never invents a part or an id.
- A part with no fit stays in the card as **No match**, with the `recommend` to try. Every such part is listed, in the one-part answer too.
- Every main word of the part must be in the part found: its name, one of its variant names, or a synonym (a save button fits Save CTA; a danger button fits Button, which has a Danger variant). Container words (list, group, set, stack, collection) and density words (compact, dense, condensed, spacious) do not count, so a radio list fits Radio and a compact toast fits Toast. If any main word is missing ("payee search field" finds Search Field, "header image" finds Header Bar), the slot says **weak, check**, names the missing words, and is not counted as a fit.
- Briefing answers fill slots too: `--answer states=empty --answer states=error` (MCP `answers`) adds Empty Message and the error part as slots, bound to those real parts. A part you already named is not added twice. `brief` offers to compose (`composeOffer`) only when compose would build a recipe and no saved recipe covers it; when a saved recipe has the same title or parts, brief says `savedRecipe` instead, the same answer compose gives. It never composes by itself.
- If a saved recipe has the same title or the same parts, the card warns and names it, and `--propose` files nothing.
- Fewer than 2 parts fit: no recipe. One part says "use recommend". None says "No match".
- A saved recipe with that exact name wins, and nothing is composed.
- Nothing is saved. `--propose` files a pending proposal; a person runs `resolve approve <id> --who <name>` to add it to `.resolve/recipes.json`. The proposal id includes the parts, so different parts are a different proposal. Proposing again after approve or reject files nothing and says why.
- Approve refuses a private part, a variant inside a set, anything that is not a library component, a recipe with no id, fewer than 2 parts (also when trimmed by hand), and a recipe whose id or title is already saved.
- An empty request, or a `compose` that is not true or false, is an error (`ok:false`, exit 1 in the CLI).
- MCP: `recipe` with `compose: true` (and `propose: true`), on the advanced surface only (`RESOLVE_MCP_ADVANCED=1`). The default MCP tools do not change.

## Context packs

Designers that share one Figma library across products add a **product + journey** pack so `recipe` / `recommend` pick masters for *this* product and *this* step — not a generic name match.

Copy [`src/data/context-packs.example.json`](../src/data/context-packs.example.json) to `.resolve/context-packs.json` (or write a smaller file). Human-editable. The pack id is a slug. `constraints.a11y` is `wcag-a`, `wcag-aa`, or `wcag-aaa`. **Never add a Figma file key or component id.** Do not set `active`. `resolve pack validate` checks the file and names the field to fix. Loading a pack skips a bad pack or a bad field and warns once; the command still runs. Line-by-line meaning: [designer guide](GUIDE.md#how-to-write-a-context-pack).

```json
{
  "version": 1,
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

Optional pack fields: `files` (workspace labels, not Figma file keys) and `client` (same shape as `product`, when product ≠ client). Same pack schema — not a second model. Recommend still prefers library-role masters.

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

MCP: `list_recipes`, `recipe` (query = id, title, or intent), `recommend` (optional `pack` / `product` / `journey` / `domain`). `get_recipe` was removed; call `recipe`. After ingest, recipe slots bind to live masters. Context packs stay: they are where a team adds its own words and property hints, and they scope those fills.
