# Cursor + Resolve — how-to

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

Everyday flow for using Resolve inside Cursor when building Figma screens from a brief.

Tagline: **Figma rules. Agents resolve.**

## Open the repo

1. Open the **Resolve** repo in Cursor (this workspace). GitHub: [`TANISHQBAFNA/resolve`](https://github.com/TANISHQBAFNA/resolve).
2. Work on the **box** paths under the Resolve project — do not rely on Mac-only paths for CLI runs.

## Install / build

Needs Node `^22.12` or `>=24` (Vitest 5). Then:

```bash
npm install
npm run build:server
```

Ensure `package.json` includes a resolve script:

```json
"resolve": "node dist-server/cli.mjs"
```

`keyline` remains a deprecated alias for one release.

Then:

```bash
npm run resolve -- --help
```

## Ingest a Figma file

Once per file (**re-run when the design library changes** — this is the refresh path):

```bash
npm run resolve -- ingest '<figma-file-or-design-url>'
```

## Pick → open the real example → clone → fill → verify (everyday)

Forced path. Agent does not invent components. Cards stay the interface — **do not** `Read` `.graphify/graph.json`.

```bash
npm run resolve -- ingest '<figma-url>' --role library    # re-run if that file changed
npm run resolve -- ingest '<product-url>' --role product
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout summary with primary button and input"
npm run resolve -- example "Button"            # top pick carries ex; call example for the others
# clone that instance, replace the content, place only the returned figmaNodeIds
# before verify, fetch the frame's design context so Resolve can read the text
# pass design context to learn as well, so the component default is stored
npm run resolve -- verify "Checkout Summary" --design-context ./frame-context.txt
npm run resolve -- verify --components "Button,MadeUpCard"
npm run resolve -- cousins "Checkout Summary"
```

After ingest, `recipe list` / `recipe "<job>"` bind slots to live `figmaNodeId`s. Overlay `.graphify/recipes.json` still wins. Unbound slots include the next `recommend` query. Bound ids that are missing or deprecated are flagged.

`recommend` ranks by name/intent, variant props, where-used, sibling co-occurrence; live over stale; deprecated last. Optional product/journey/domain context pack (`.graphify/context-packs.json`, or `--pack` / `--product` / `--journey` / `--domain`) ranks on top of that. The same flags bind `recipe` list/get and `verify`. Cap ~2000 chars. Empty match still means do not invent.

When you already know the master name (give me the id):

```bash
npm run resolve -- resolve "Main Card"
npm run resolve -- resolve "Input Field"
```

Exact name always returns `id` + `fileKey` + `figmaNodeId`, even with zero usage. A miss says so and points at `recommend`. Prefer **resolve** over any keyline / graphify alias.

Resolve is case-sensitive for deprecated and private masters. `Legacy Banner` and `_Private Note` return that master. `legacy banner` returns the live replacement. Any other casing of a private name returns an empty card.

CLI ingest and the MCP server must share one store. Set `GRAPHIFY_HOME` to the `.graphify` folder, or run both from the same project root. `npm run resolve -- where` and MCP `list_graphs` print the path and `builtAt`. After ingest, the next MCP call sees the new graph without a restart.

Primary learn: Figma MCP `get_metadata` → `learn_library` (paid Dev/Full seat). Pass `get_design_context` as `designContext` on that learn so master default text is stored. Secondary: REST token ingest. Big libraries: several checkpointed passes. View/free seats: low quota; Resolve resumes.

Optional allow/deny file: `.graphify/library-rules.json` with `{ "allow": [...], "deny": [...] }`. If missing, approved = in-graph master and not deprecated.

Designers add screen packs in JSON — see [`docs/RECIPES.md`](RECIPES.md). Overlay: `.graphify/recipes.json`. Product + journey + domain: `.graphify/context-packs.json`. Linked files: `.graphify/workspace.json` (see [GUIDE.md](GUIDE.md)).

## Everyday screen flow

1. **Ingest** — (refresh) each linked file (`--role library|product|client`)
2. **Context / recipe** — (optional) named pack for the screen job; optional product + journey + domain context pack (`--pack` / `--product` / `--journey` / `--domain`). Packs may name `files` / `client`.
3. **Recommend** — unbound slots / free-text brief → ranked masters (library preferred when a library-role file is linked; context-scoped when a pack is bound)
4. **Draw** — `use_figma` / `get_design_context` on those `figmaNodeId`s only (cards stamp `fileKey`)
5. **Verify** — before verify, fetch the frame's design context so Resolve can read the text (`--design-context` / `designContext`). Pass design context to `learn_library` too, or the default stays unknown. Invents / deprecated / unresolved (same optional `--pack` / `--product` / `--journey` / `--domain`)
6. **Cousins** — when a library + product/client file are linked (`cousins` / `check_cousins`)
7. **Human taste** — review before expanding scope

**Do not** `Read` `.graphify/graph.json`. Resolve cards are the cheap path.

## Cursor wiring

- Skill: `skills/resolve/SKILL.md`
- Always-on rule: `rules/resolve.mdc`
- Drop into `AGENTS.md`: copy from `AGENTS-RESOLVE-SECTION.md`
