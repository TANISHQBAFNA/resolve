---
name: resolve
description: Use Resolve before any Figma screen build or design-from-brief work in Cursor. Forced path: ingest each linked file → (optional context pack / recipe) → recommend unbound slots → get_example → clone that instance and fill → verify_frame → cousins when a multi-file workspace exists. Never Read graph.json. Never invent components.
---

# Resolve

**Figma rules. Agents resolve.** Never `Read` `graph.json`. Never invent components.

## Forced path (do this, in order)

1. **Ingest** — store each linked Figma file. Shared DS: `--role library`. Product/client files next. Re-run when that file changed.
2. **Recipe** — if the screen job matches a pack (`recipe list` / `recipe "<job>"`). After ingest, slots bind to live `figmaNodeId`s. Overlay `.graphify/recipes.json` still wins. Optional `.graphify/context-packs.json` scopes product + journey + domain (slot fills + `nextRecommend`). Packs may name `files` and optional `client`. Optional `--pack` / `--product` / `--journey` / `--domain`.
3. **Recommend** — every unbound / missing / deprecated slot. Use that slot’s `nextRecommend` query. Prefers DS library masters when `.graphify/workspace.json` has a library-role file. Optional `--pack` / `--product` / `--journey` / `--domain` (or the active pack). Each pick has `ex`: a real instance node id, or the sentence that no real example is known.
4. **Example** — `get_example` / `resolve example "<name>"` for file key, screen, variant, structure, and sizing. Clone that instance and replace content. Do not start from the default variant. A missing example means ask the designer or open a screen that uses it.
5. **Place** — Figma MCP (`use_figma` / `get_design_context`) on returned ids **only**. Cards stamp `fileKey` + `figmaNodeId` (ids collide across files). Placing into a different file needs the library published and `search_design_system` output passed as `libraries`; otherwise build inside the library file.
6. **Verify** — `verify_frame` on the new frame or placed names. Same optional `--pack` / `--product` / `--journey` / `--domain`. Known placeholder text fails. Leftover default copy and an oversized fixed height warn.
7. **Cousins** — when a library file and a product/client file are linked, `cousins` / `check_cousins` on the product frame or screen job. Unsure means stop. Do not invent a master.
8. **Human taste** — stop. Do not over-generate.

Prefer **resolve** over any `keyline` / `graphify` alias. `npm run keyline` is a deprecated alias this release.

## Commands (copy-paste)

```bash
npm run build:server
npm run resolve -- ingest '<url>' --role library --label "Shared DS"
npm run resolve -- ingest '<product-url>' --role product --label "Storefront"
npm run resolve -- workspace
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout with primary button and input"
npm run resolve -- recommend "primary button" --pack storefront-checkout-summary
npm run resolve -- recommend "primary button" --product Storefront --journey summary --domain checkout
npm run resolve -- resolve "Main Card"            # only if you already know the name
npm run resolve -- example "Main Card"            # full config for the ex pointer
npm run resolve -- verify "Checkout Summary"
npm run resolve -- verify --components "Button,MadeUpCard"
npm run resolve -- cousins "Checkout Summary" --job "checkout summary"
```

## Forbidden

- Invent a component, name, or node id.
- `Read` `.graphify/graph.json` or any `graph.json`. Cards are the source of truth.
- Dump the graph / REST / whole-file metadata into context.
- Call `get_design_context` on a FRAME or SECTION until recipe/recommend/resolve returned that id.
- Place a deprecated or missing master. Call `recommend` for a live one.
- Guess a cousin. If `check_cousins` is unsure, say so.

Optional allow/deny: `.graphify/library-rules.json` `{ "allow": ["Button"], "deny": ["Banner"] }`. Bind rules (require / forbid / prefer): `.graphify/bind-rules.json` — unknown ids fail validation, never guess. If missing, approved = in-graph MAIN_COMPONENT / VARIANT (or COMPONENT_SET) and not deprecated. Rules never auto-change; `approve_proposal` is advanced MCP / CLI `resolve approve`.

Designers edit `src/data/recipes.json` or overlay `.graphify/recipes.json`. Product + journey + domain: `.graphify/context-packs.json`. Linked files: `.graphify/workspace.json` (see `docs/GUIDE.md`). Do not invent `defaultMasterId`s or Figma node ids in packs.

Skill tools: `list_recipes`, `recipe` / `get_recipe`, `recommend`, `resolve`, `get_example`, `verify_frame`, `check_cousins`, `get_screen_inventory`, `check_frame` (analog shortcut).

## Caps

| Level | When |
|-------|------|
| **Level-1** (default) | Single component / local edit — recipe or recommend + example + clone + verify |
| **Level-2** | Only when blast radius is large (shared masters, multi-screen impact) |
| **Whole-file** | Only if the user explicitly asks |

Stay at Level-1 unless the change clearly needs broader scope.
