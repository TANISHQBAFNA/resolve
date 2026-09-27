## Resolve — forced path (copy this)

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

Use Resolve before any Figma screen build or design-from-brief work. **Never Read `graph.json`.** Never invent components.

Tagline: **Figma rules. Agents resolve.**

### Do this, in order

```bash
npm run build:server
npm run resolve -- ingest '<url>' --role library   # re-run if that file changed
npm run resolve -- ingest '<product-url>' --role product
npm run resolve -- recipe list             # after ingest, slots bind to live ids
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout with primary button"
# place ONLY the returned figmaNodeIds (cards also stamp fileKey)
npm run resolve -- verify "Checkout"
npm run resolve -- cousins "Checkout"      # when a library + product file are linked
```

CLI and MCP share one store (`GRAPHIFY_HOME`, else nearest `.graphify`). After ingest, the next MCP call sees the graph — no restart. `list_graphs` prints `store.path` + `builtAt`. Know the name: `resolve "Main Card"` always returns the id, even unused. No REST token: `ingest screen.xml --from-metadata --file-key KEY`.

1. **Ingest** — each linked file as needed (`--role library|product|client`). Refresh if that Figma file changed.
2. **Context / recipe** — if the screen job matches a pack. Overlay `.graphify/recipes.json` still wins. Optional `.graphify/context-packs.json` scopes product + journey + domain. Packs may name `files` and optional `client`. Optional `--pack` / `--product` / `--journey` / `--domain`.
3. **Recommend** — unbound / missing / deprecated slots (`nextRecommend` on the card). Prefers DS library masters when the workspace has a library-role file. Optional `--pack` / `--product` / `--journey` / `--domain`.
4. **Place** — `use_figma` / `get_design_context` on returned ids only.
5. **Verify** — `verify_frame` (invents / deprecated / unresolved). Same optional `--pack` / `--product` / `--journey` / `--domain`.
6. **Cousins** — `check_cousins` when a library file and a product/client file are linked. Unsure means do not invent.

### Forbidden

- Invent components, names, or node ids.
- `Read` `.graphify/graph.json` or dump the graph.
- `get_design_context` on a FRAME until recipe/recommend/resolve returned that id.

Designers add recipes in JSON (`src/data/recipes.json` or `.graphify/recipes.json`), product+journey+domain packs in `.graphify/context-packs.json`, and linked files in `.graphify/workspace.json`. See [GUIDE.md](GUIDE.md).

Prefer **resolve** over any `keyline` / `graphify` alias.

### Caps

- **Level-1** (default): single component / local edit
- **Level-2**: only for large blast radius
- **Whole-file**: only if explicitly asked
