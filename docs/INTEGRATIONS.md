# Integration guide

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

Everything below plugs into an existing seam. None of it requires changing the
graph model, the query layer or the UI.

## The two seams

```
                      ┌──────────────────────────────┐
  new data source ───▶│ IngestionSource.load()        │──▶ SourceDocument ──▶ (unchanged)
                      └──────────────────────────────┘

```

- To add a **data source**, implement `IngestionSource` (`core/ingestion/types.ts`).
- Bounded graph context for a node lives in `core/ai/context.ts`. There is no LLM client in this repo.

---

## 1. Figma REST API — shipped

Parsing was already in `adaptFigmaRestFile`. Live fetch is
`FigmaRestIngestionSource` / `fetchFigmaRestDocument`.

**Agent path (preferred).** Ingest each linked Figma file into one workspace — not one giant `graph.json`. Shared design system: `--role library`. Product and client files next (`--role product` / `--role client`). That writes `.resolve/workspace.json` and `.resolve/files/<key>.json`. Optional `recipe` for a screen pack, then `recommend` unbound slots, then Figma on those `figmaNodeId`s (cards also stamp `fileKey`; ids collide across files), then `verify_frame`. When a library file and a product/client file are linked, `cousins` / `check_cousins` flags wrong-cousin drift. `workspace` lists linked files. Do not Read graph.json. Re-run ingest for a file to refresh.

Designer walkthrough: [GUIDE.md](GUIDE.md).

```bash
export FIGMA_ACCESS_TOKEN=figd_…
npm run build:server
npm run resolve -- ingest 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2' --role library --label "Shared DS"
npm run resolve -- ingest 'https://www.figma.com/design/<productKey>/<name>?node-id=1-2' --role product --label "Storefront"
npm run resolve -- workspace
```

Roles are `library` | `product` | `client`. First ingest with no `--role` is the library; later files default to product. An unknown `--role` fails (no silent fallback). Or copy `src/data/workspace.example.json` to `.resolve/workspace.json` and ingest each row.

Paste the shared screen/frame/section URL. `node-id` is the ingest scope. No `node-id`: each top-level FRAME/SECTION/COMPONENT/COMPONENT_SET, one request at a time. `--scope file` is one request — safer on a low API tier. Section walks honor `Retry-After` (bounded) and checkpoint completed sections so a re-run resumes. Changing `--role` on a file already in the workspace is refused unless `--force-role`.

**Human path.** Dev UI **Load Figma** — PAT + URL. Token stays in
`sessionStorage`. Vite proxies `/api/figma` → `https://api.figma.com` so the
browser can call REST at all.

**Tokens.** Never commit a PAT. Never write it into the store. CLI reads
`FIGMA_ACCESS_TOKEN` (or `FIGMA_TOKEN`). UI never puts the token in the bundle.

**Scope.** Shared links hit `GET /v1/files/:key/nodes?ids=`. Whole-file ingest
outlines with `?depth=2`, then fetches each top-level FRAME/SECTION/COMPONENT/
COMPONENT_SET. Empty outline falls back to one `GET /v1/files/:key`. Prefer
`--scope file` on a low API tier. 429 responses honor `Retry-After`; completed
sections stay on disk under `.resolve/ingest/` so the next run resumes.

**Thumbnails.** `GET /v1/images/:key?ids=a,b,c&format=png&scale=1` in batches;
write the URLs onto `GraphNode.thumbnailUrl`. Rate-limited — do it lazily for
nodes that are actually rendered or inspected.

---

## 2. Figma plugin — internal / unsupported

`figma-plugin/` is **internal and unsupported** for users. Do not import the
manifest through **Plugins → Development**. The supported user path is Figma
MCP `get_metadata` + Resolve `learn_library`, or REST ingest with a token.
The plugin is not a shipped product feature.

It emits a `SourceDocument` directly (for maintainers), so
`JsonIngestionSource` validates it against `SourceDocumentSchema` and skips
the adapter layer. Running in-document closes gaps the other two sources have:

| | REST | MCP `get_metadata` | Plugin |
|---|---|---|---|
| Instance → main component | exact | layer name only (guess) | **exact** |
| Variables | Enterprise endpoint | names only | **`figma.variables`, no plan gate** |
| Prototype interactions | one per node | none | **every reaction** |
| Dev-mode annotations | inconsistent | none | **`node.annotations`** |
| Auth | access token | Figma desktop | **none** |

See `figma-plugin/README.md` for scope options and the local POST receiver.

## 2b. Plugin internals (maintainers only — unsupported for users)

A plugin runs inside Figma with the full document in memory, which fixes three
of the REST limitations at once: real `reactions` (multi-action prototyping),
dev-mode annotations, and — via `figma.variables` — variables without an
Enterprise plan.

The plugin's job is to emit a `SourceDocument`, not to know anything about the
graph:

```ts
// plugin/code.ts (runs in Figma)
figma.ui.postMessage({ type: "source-document", payload: buildSourceDocument() });
```

```ts
// src/core/ingestion/adapters/pluginSource.ts (runs in the app)
export class FigmaPluginIngestionSource implements IngestionSource {
  readonly kind = "figma-plugin" as const;
  /* resolves on the postMessage above; validate with SourceDocumentSchema */
}
```

Because the plugin can set `libraryId` on remote components and styles,
limitation #3 in `ARCHITECTURE.md` disappears and `SOURCED_FROM_LIBRARY` starts
grouping by real library instead of one catch-all node — with no change to the
transform.

---

## 3. Figma MCP — shipped

`core/ingestion/adapters/figmaMcp.ts` turns the Dev Mode MCP server's
`get_metadata` XML and `get_variable_defs` map into a `SourceDocument`. It needs
no token and no Enterprise plan — just the Figma desktop app with
**Preferences → Enable Dev Mode MCP Server** turned on.

`get_metadata` is the cheapest structural view Figma exposes: ids, layer types,
names, positions, sizes, nothing else. That is precisely the trade this product
is built on — enough to construct a traversable graph, at a fraction of the
cost of a design payload.

### Capturing a file

```bash
curl -s -X POST http://127.0.0.1:3845/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"get_metadata","arguments":{"nodeId":"14430:56021"}}}'
```

Save the XML (the tool result, including the prose Figma wraps around it) and ingest it:

```bash
npm run resolve -- ingest screen.xml --from-metadata --file-key KEY --name "Library" --role library
```

No REST token. JSON captures with a `metadataXml` field still work the same way. The adapter is `adaptFigmaMcpMetadata({ fileKey, fileName, metadataXml, variableDefs })`. `CapturedMcpIngestionSource` wraps a stored capture so the same path runs in tests and in the browser.

MCP and CLI must read the same store. `RESOLVE_HOME` wins. Else Resolve walks up from the process working directory (then `INIT_CWD`) looking for `.resolve/graph.json` or `workspace.json`. After a CLI ingest, the next MCP call reloads from disk — no server restart. If a tool says “No graph stored,” the message includes the exact path it looked in. `list_graphs` and `get_health` include `store.path` and `store.builtAt`.

### What MCP metadata cannot tell you

| Gap | Handling |
|---|---|
| No `componentId` on instances | Layer name is only a label. Identity is tagged `identity: "inferred-from-name"` and cards say **guess from layer name, not confirmed**. Never counted as verified, never a confirmed wrong-cousin. Re-ingest via REST (`FIGMA_ACCESS_TOKEN`), the plugin, or pass `get_design_context` (real `componentId` / `componentKey` / `data-component-id`, or JSON `"componentId"`) for exact ids. If `get_metadata` XML includes `componentId`, `componentKey`, or `data-component-id`, that id is trusted only when it matches a real library master; an unknown id stays a guess and does not mint a master. |
| No per-node variable bindings | `get_variable_defs` returns subtree-wide tokens keyed by name. They attach to the queried root rather than being invented onto children. |
| No file or page context | The graph roots at the queried node. Page/section context arrives with a REST or plugin ingest. |
| No prototype data | `PROTOTYPES_TO` needs REST or the plugin API. |
| Variables and styles arrive in one flat map | Split by value shape: `Effect(…)` → effect style, `Font(…)` → text style, `""` → paint style, `#rrggbb` → colour variable, numeric → float, else string. |

Because every inference is tagged, an agent reading the graph can tell exactly
which relationships are load-bearing and which are best-effort.

### Serving the graph *to* MCP

The more interesting direction: expose this graph as MCP tools so an agent can
traverse it instead of re-reading the file. Each tool is a thin wrapper over
`GraphIndex` and returns already-small payloads.

| Tool | Implementation |
|---|---|
| `list_recipes()` | starter pack + `.resolve/recipes.json` overlay |
| `recipe(query)` / `get_recipe` | `recipeCard` — slots with `fileKey` + `figmaNodeId`, unbound → recommend query |
| `recommend(intent)` | `recommendMasters(index, intent)` — ranked library masters, deprecated demoted. Prefers library-role files when the workspace has one. `ex` points at a real instance. |
| `get_example(name)` | Full config for that instance: screen, variant, structure, sizing. |
| `resolve(name)` | `componentUsageCard(index, name)` — usage card when the name is known |
| `verify_frame(frame\|components)` | `verifyFrame(index, …)` — invents / deprecated / unresolved. Cards stamp `fileKey` + `figmaNodeId` when known. |
| `check_cousins(frame\|job)` | `checkCousins` — wrong-cousin report. Needs a library-role file in `.resolve/workspace.json`. |
| `list_graphs()` | Linked workspace files (`library` / `product` / `client`) |
| `check_frame(intent)` | `checkFrame(index, intent)` — analog variant on similar screens |
| `find_nodes(query)` | `searchNodes(index, query)` — the same query language as the UI |
| `get_node(id)` | `index.getNode(id)` + `usageSummaryFor` |
| `get_component_usage(id)` | `computeComponentUsage(index, node)` |
| `get_subgraph(id, level, viewMode)` | `extractSubgraph(index, {...})` — deprecated; use `recommend` |

`get_subgraph` stays callable for a quarter, then goes. The why line on a `recommend` card is the brief agents should read.

### Why this is the point of the product

Measured on a captured Portfolio screen (87 instances, 224 graph nodes):

| Question | Without the graph | With the graph |
|---|---|---|
| "What components are on this screen, and how often?" | re-read 14,394 chars of `get_metadata`, then derive it | **586 chars** — an index lookup that already contains the answer |
| "Where is `Main Card` used?" | re-read 14,394 chars, then derive it | **4,124 chars** of bounded subgraph, answer included |
| Whole graph as JSON | — | 174,332 chars, **never sent** |

An agent that re-reads the file pays the full cost on every question and
re-derives the same relationships each time. An agent that traverses the graph
pays once at ingest, then answers from indexes. A regression test asserts a
targeted answer never costs more than half of the source it came from.

---

## 4. No LLM client

`core/ai` only builds a bounded subgraph (`buildAiGraphContext`) and a markdown brief (`toMarkdownPrompt`). There is no provider, no action catalogue, and no AI panel. Agents read the why line on `recommend` and `resolve` cards.

## 5. Cursor / Claude Code

Use `recommend`, `resolve`, and `verify_frame`. Do not paste a graph canvas export. Code twins live in `.resolve/code-map.json`.

## 6. Adding a node type or an edge type

1. Add the literal to `NODE_TYPES` / `EDGE_TYPES` in `core/model`.
2. Add its category in `NODE_CATEGORY_BY_TYPE` (colour follows automatically).
3. Emit it in `buildGraph`.
4. If it needs a reverse index, add it in `GraphIndex`'s constructor switch.

Levels, filters, search, the browser and the AI payload all pick it up without
further changes.
