<!-- caveman-begin -->
Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
<!-- caveman-end -->

## Resolve — forced path (copy this)

Use Resolve before any Figma screen build or design-from-brief work.

**Tagline:** Figma rules. Agents resolve.

### Do this, in order

```bash
npm run build:server
# Everyday: Figma MCP get_metadata → learn_library (paid Dev/Full MCP seat)
npm run resolve -- learn --file-key KEY --from-metadata screen.xml --role library
npm run resolve -- ingest '<figma-url>' --role library   # secondary: REST token
npm run resolve -- ingest '<product-url>' --role product
npm run resolve -- recipe list             # after ingest, slots bind to live ids
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout with primary button"   # unbound slots only
npm run resolve -- example "Main Card"        # full config for the ex pointer
# clone that instance, replace content, do not start from the default variant
# place ONLY the returned figmaNodeIds (use_figma / get_design_context)
# before verify, fetch the frame's design context so Resolve can read the text
npm run resolve -- verify "Checkout Summary"
npm run resolve -- cousins "Checkout Summary"   # when a library + product file are linked
```

| Step | When | Tool |
|------|------|------|
| 1. Ingest | No graph, or a linked Figma file changed | `ingest '<url>'` (`--role library\|product\|client`). Each linked file as needed. |
| 2. Context / recipe | Screen job matches a pack (checkout, sign-in, empty state, …). Optional `.graphify/context-packs.json` scopes product + journey + domain. Packs may name `files` and optional `client`. | `recipe list` then `recipe "<job>"` (optional `--pack` / `--product` / `--journey` / `--domain`) |
| 3. Recommend | Slot is unbound / missing / deprecated. Prefers DS library masters when workspace has a library-role file. | `recommend "<nextRecommend>"` (optional `--pack` / `--product` / `--journey` / `--domain`). Card field `ex` is a real instance, or says no real example is known. |
| 4. Example | After a pick | `get_example` / `resolve example` for the full config. Clone that instance and replace content. Do not start from the default variant. |
| 5. Place | Drawing in Figma | returned `figmaNodeId`s **only** (cards also stamp `fileKey`). A different file needs the library published and `search_design_system` output passed as `libraries`; otherwise build inside the library file. |
| 6. Verify | After the draw | Before verify, fetch the frame's design context so Resolve can read the text. Pass it to `verify_frame` (`designContext` or `texts`). `get_metadata` has no characters; `textChecked` is false until they arrive. Then leftover default copy warns and known placeholder text fails. Optional `--pack` / `--product` / `--journey` / `--domain`. |
| 7. Cousins | Multi-file workspace exists (library + product/client) | `cousins` / `check_cousins` on the product frame or `--job` |

MCP: `list_recipes` → `recipe` → `recommend` → `get_example` → clone → fill → `verify_frame` → `check_cousins` when a library file is linked.

CLI and MCP share one store. `GRAPHIFY_HOME` wins; else nearest `.graphify` walking up from cwd. After ingest, the next MCP call reloads from disk (no restart). `list_graphs` / `workspace` / `resolve where` print `store.path` + `builtAt`. If a tool says “No graph stored,” the message names the exact path.

Know the name, need the id: `resolve "Main Card"` (CLI or MCP). Exact master always returns `id` + `fileKey` + `figmaNodeId`, even with zero usage. A miss says so and points at `recommend`.

No REST token: save Figma MCP `get_metadata` XML and `ingest screen.xml --from-metadata --file-key KEY --name "Library"`.

### Forbidden

- Invent components, names, or node ids.
- `Read` `.graphify/graph.json` (or any `graph.json`). Cards/CLI/MCP only.
- Dump the graph, REST JSON, or a whole-file metadata tree into context.
- `get_design_context` / `use_figma` on a FRAME or SECTION until recipe/recommend/resolve returned that id. Exception: before verify, fetch the frame you just drew so Resolve can read the text.
- Skip ingest when the library changed. Re-ingest is the refresh path.

`.graphify/recipes.json` overlay still wins over the starter pack. Optional `.graphify/context-packs.json` binds product + journey + domain to recipes so recommend is not a generic name match. Optional `.graphify/workspace.json` lists linked Figma files (`library` / `product` / `client`). Optional `.graphify/bind-rules.json` require/forbid/prefer (unknown ids fail validation; rules never auto-change). Do not invent `defaultMasterId`s or Figma node ids in packs. See `docs/GUIDE.md`, `docs/RECIPES.md`, and `docs/BIND-RULES.md`.

Prefer **resolve** over any `keyline` / `graphify` alias.

### Caps

- **Level-1** (default): single component / local edit
- **Level-2**: only for large blast radius
- **Whole-file**: only if the user explicitly asks
