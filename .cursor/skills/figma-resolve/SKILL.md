---
name: figma-resolve
description: >-
  Query a Figma relationship graph for component instances, variants, blast
  radius, and screen structure. Use when a Figma URL is shared, before reading
  a Figma file or calling Figma MCP get_design_context. Call recipe, recommend,
  or resolve — never Read graph.json. Product is Resolve.
---

# Resolve

Ingest the **shared node**. Graph stays on disk (`.resolve/graph.json`).
**Do not Read that file. Do not invent components.**

Forced path: ingest (refresh if the library changed) → `recipe` if the screen job matches → `recommend` unbound slots → Figma on returned `figmaNodeId`s only → `verify_frame`.

Prefer `npm run resolve` (product **Resolve**). `keyline` is a deprecated alias.

## When a Figma link appears

1. Keep the URL **exactly** — `node-id` is the ingest scope (screen, frame, or section).
2. Ingest once if no graph is stored (re-run to refresh):

```bash
export FIGMA_ACCESS_TOKEN=figd_…
npm run build:server   # first time / after pull
npm run resolve -- ingest '<pasted-figma-url>'
```

3. **`recipe "<job>"`** — screen pack. After ingest, slots bind to live `figmaNodeId`s. Unbound: `recommend`.
   **`recommend "<intent>"`** — ranked masters (name, variants, where-used, co-occur, live over stale). Cap ~2000 chars.
   **`resolve "<component>"`** — usage card when you already know the name.

Do **not**:

- Invent components, names, or node ids
- Read `.resolve/graph.json` or dump REST JSON
- Strip `?node-id=` and fetch the whole file
- Map every screen unless the user asked for the whole file
- Call `get_design_context` on a FRAME or SECTION until `recipe`/`recommend`/`resolve` returns an id
- Start from `orient` / `explain` / `get_subgraph`

## Create / recreate a screen (Figma or code)

1. `recipe "pay now"` or `recommend "pay now with primary button"` (or `resolve "Main Card"` if you already know the name).
2. `use_figma` / `get_design_context` on **that** `figmaNodeId` only.
3. `verify_frame` on the new frame or placed names. Do not invent primitives the card already lists.
4. Reuse names from the card.

Frame name (`resolve "Portfolio"`) returns a screen inventory (each component once, with a count). Analog shortcut: `check_frame "pay now buttons"`. Prefer `recipe` for a known screen job, `recommend` when the family is unknown.

Skill tools: `list_recipes`, `recipe`, `recommend`, `resolve`, `verify_frame`, `get_screen_inventory`, `check_frame`.

## Whole file

No `node-id`, or user said "map the file": ingest walks **each top-level FRAME/SECTION**, one REST call at a time. Slow. Expected.

```bash
npm run resolve -- ingest '<file-url>'              # screen-by-screen
npm run resolve -- ingest '<file-url>' --scope file # one dump (escape hatch)
```

## Commands

```bash
npm run resolve -- ingest '<figma-url>'
npm run mcp
```
