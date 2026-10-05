# Resolve — architecture

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

## 1. The problem, restated

A Figma file is a tree that nobody can see. The structure that matters —
which screens belong to which journey, which screens are built from real
components, which component a given instance points at, what breaks if you
change that component — is buried inside nested pages, sections, frames,
groups and instances, and is only visible by clicking through the canvas one
layer at a time.

Meanwhile the same file is already machine-readable: the REST API, the plugin
API and Figma MCP all expose it as a structured node tree with component,
style, variable and prototype metadata.

So the product is a translation layer with a UI on top: **take any Figma file,
turn its entities and relationships into an explicit graph, and let a person or
an agent traverse that graph** — down from a product area to a page, a frame, an
instance, and across from an instance to its main component and back out to
every other place that component is used.

Two constraints shape everything below.

1. **Universal.** No assumption about domain, team, naming scheme or design
   system. A file with no design system must still produce a useful graph; a
   file with a great one must produce a better graph. The only conventions the
   code relies on are conventions *Figma itself* defines (node types, the
   `Prop=Value` variant name format, `componentId` on instances).
2. **Never a hairball.** A real file has tens of thousands of nodes. The
   product renders a *chosen subgraph*, never the file. Progressive disclosure
   is a core mechanic, not a performance workaround — and it is the same
   mechanism that keeps AI payloads small.

## 2. Assumptions and Figma data limitations

These are the things that constrain what the graph can honestly contain. Each
one is handled explicitly in code rather than being papered over.

| # | Reality | Consequence in this codebase |
|---|---|---|
| 1 | **Variables need a different, Enterprise-gated endpoint.** `GET /v1/files/:key` does not return variable definitions; `/variables/local` is Enterprise-only. Nodes *do* carry `boundVariables`. | Variables are a separate optional input to the adapter. When a binding resolves to no definition we still create a placeholder `VARIABLE` node marked `unresolved` plus a warning, so "this node is token-bound" survives even without Enterprise access. |
| 2 | **Remote (library) components are not in the file payload.** An instance of a library component has a `componentId` that resolves to nothing in the tree; the `components` map still names it. | `ensureComponentNode` materialises a remote `MAIN_COMPONENT` stub from the components map, marks it `isRemote`, and links it to a library node. Its internals are genuinely unknowable from this file — the graph says so rather than guessing. |
| 3 | **The file endpoint never says *which* library a remote entity came from.** | All remote entities are grouped under one synthetic `EXTERNAL_LIBRARY` node ("External libraries (source unknown)"). Sources that do know (Plugin API, MCP, the library-analytics endpoints) can set `libraryId` on the source entity and get real per-library grouping with no other change. When the workspace lists an ingested library-role file, merge relinks remotes to that `FILE` (and to the real master on exact `figmaNodeId` / component key). No fuzzy merge. |
| 4 | **REST exposes one prototype transition per node** (`transitionNodeID`), while the Plugin API exposes full `reactions` with multiple triggers and actions. | The ingestion contract models transitions as an array. The REST adapter fills it with 0–1 entries and also reads `reactions` when a richer source provides them. |
| 5 | **Dev-mode annotations are not consistently available over REST.** | `ANNOTATION` exists in the schema and annotations are carried on node metadata when present, but no annotation nodes are materialised in Phase 1. |
| 6 | **Thumbnails need a second, rate-limited call** (`GET /v1/images/:key`). | `thumbnailUrl` exists on `GraphNode` and is left empty in Phase 1. Phase 3 fills it in batches. |
| 7 | **Style ids, node ids and variable ids live in different id spaces and can collide.** | Every graph node has a namespaced internal id (`node:1:23`, `style:S:abc,1`, `var:VariableID:1:1`), with the original kept in `figmaNodeId` for deep links. |
| 8 | **Node ids are `1:23` in the API and `1-23` in URLs.** | One place builds deep links (`core/transform/figmaUrl.ts`). |
| 9 | **Figma adds node types over time.** | Unknown types degrade to `LAYER`; ingestion never fails on an unrecognised type. |
| 10 | **Figma MCP `get_metadata` omits `componentId`.** It returns ids, types, names and geometry only. A layer can be renamed, so that name is not the component. | Instance identity is tagged `identity: "inferred-from-name"` and cards say **guess from layer name, not confirmed**. Never verified, never a confirmed cousin. An instance `componentId` / `componentKey` / `data-component-id` is trusted only when it matches a real library/`<symbol>` master; an id that matches nothing stays a name-only guess and does not mint a master. REST, the plugin, and `get_design_context` (HTML/JSON, including `data-component-id` and quoted `"componentId"`) supply real ids. |
| 11 | **Figma MCP `get_variable_defs` returns subtree-wide tokens keyed by name** — no ids, no collections, no per-node attribution, variables and styles in one flat map. | Tokens are split by value shape and attached to the queried root with subtree scope. |
| 12 | **Rate limits and file size.** A large file's REST response is tens of MB. | Ingestion is a streaming-friendly seam (a `SourceDocument` producer), the transform has a node cap that reports truncation, and the query layer is built so a page can be loaded and indexed incrementally. |

Assumptions made without asking, all reversible:

- **Auto layout classification.** A *nested* frame with auto layout is typed
  `AUTO_LAYOUT_CONTAINER`; a frame that sits directly on a page or section is a
  screen and stays `FRAME`. This is what makes "the screens on this page"
  answerable without name heuristics. It is a single option
  (`classifyAutoLayout`) on one function.
- **`PARENT_OF` and `USED_IN` are materialised inverse edges.** Both are
  generated, both are tagged, and both are hidden from the canvas by default so
  no relationship is ever drawn twice. `PARENT_OF` runs child → parent
  (read it as "has parent").
- **`NESTS` is depth-independent.** It connects the nearest enclosing component
  definition *and* the nearest enclosing screen frame to every instance inside
  them, at any depth. That makes "which components are on this screen" a
  one-hop query instead of a subtree walk.
- **Prototype interactions are edges, not nodes.** `PROTOTYPE_INTERACTION`
  stays in the schema for Phase 3 (when multi-action reactions arrive), but a
  navigation is modelled as a `PROTOTYPES_TO` edge carrying trigger, action,
  duration and easing in metadata. Edges traverse; nodes for edges do not.
- **External URLs are not nodes.** `LINKS_TO` is emitted only when a link
  resolves to a node inside the graph. External URLs stay on node metadata and
  surface in the inspector.
- **Hidden layers are kept by default** and flagged, because "this is hidden"
  is information. A filter and a build option remove them.

## 3. Domain model

Two models, deliberately separated.

**`SourceDocument`** (`core/ingestion/types.ts`) — normalised but still a tree.
"Figma-ish, but stable." Every adapter produces this and nothing above the
ingestion layer sees a vendor payload.

**`DesignGraph`** (`core/model/graph.ts`) — flat nodes and edges, with
namespaced ids and reverse relationships materialised.

```
Figma REST ─┐
Plugin API ─┼─▶ SourceDocument ─▶ buildGraph ─▶ DesignGraph ─▶ GraphIndex ─▶ recommend / recipe / verify / SOCI
Figma MCP  ─┤                                                              └─▶ library + rules UI
JSON/mock  ─┘
```

### Node types

| Category | Types |
|---|---|
| Structure | `FILE`, `PAGE`, `SECTION`, `FRAME`, `AUTO_LAYOUT_CONTAINER`, `GROUP`, `LAYER`, `TEXT_LAYER`, `MEDIA_LAYER` |
| Component system | `COMPONENT_SET`, `MAIN_COMPONENT`, `VARIANT`, `COMPONENT_INSTANCE` |
| Foundations | `STYLE`, `VARIABLE`, `VARIABLE_COLLECTION`, `EXTERNAL_LIBRARY` |
| Interaction | `PROTOTYPE_INTERACTION`, `ANNOTATION` |

Classification (`core/transform/classify.ts`) is purely structural:

```
DOCUMENT                        -> FILE
CANVAS                          -> PAGE
SECTION                         -> SECTION
FRAME (child of page/section)   -> FRAME             (a screen)
FRAME (nested, auto layout)     -> AUTO_LAYOUT_CONTAINER
FRAME (nested, no auto layout)  -> FRAME
COMPONENT_SET                   -> COMPONENT_SET
COMPONENT (child of a set)      -> VARIANT
COMPONENT (standalone)          -> MAIN_COMPONENT
INSTANCE                        -> COMPONENT_INSTANCE
GROUP / TEXT                    -> GROUP / TEXT_LAYER
node with an IMAGE fill         -> MEDIA_LAYER
anything else                   -> LAYER
```

### Edge types

| Group | Edges |
|---|---|
| Structural | `CONTAINS`, `PARENT_OF` (materialised inverse) |
| Component | `INSTANCE_OF`, `USED_IN` (materialised inverse), `VARIANT_OF`, `NESTS` |
| Design system | `USES_STYLE`, `USES_VARIABLE`, `BELONGS_TO_COLLECTION`, `SOURCED_FROM_LIBRARY` |
| Interaction | `PROTOTYPES_TO`, `LINKS_TO` |

`GraphNode` and `GraphEdge` match the shapes in the brief, with four additions:
`isRemote` (local vs library), `libraryId`, a `warnings` array on the graph, and
a `source` descriptor recording where the data came from. Every schema is Zod,
and types are inferred from the schemas so there is exactly one definition of
each shape.

### Reverse indexes

`GraphIndex` builds these once per graph and every other read goes through it:

- children by parent, nodes by type, nodes by page, nodes by section
- **instances by main component** (the reverse of `INSTANCE_OF`)
- variants by component set
- **consumers by style**, **consumers by variable**, variables by collection
- members by library
- nested instances by container (screen frame or component definition)
- outgoing/incoming edges by node id

## 4. What the app shows

Library counts, health, the scoreboard, and the rules page. There is no graph canvas, no atlas, and no AI side panel. Agents get context from `recommend`, `recipe`, `resolve`, `verify_frame`, and SOCI — not from a canvas export.

## 5. Project structure

```
src/
├─ core/                      # zero UI dependencies, fully unit tested
│  ├─ model/                  # node types, edge types, GraphNode/GraphEdge schemas, id namespacing
│  ├─ ingestion/              # source -> SourceDocument
│  │  ├─ types.ts             # the ingestion contract + IngestionSource interface
│  │  └─ adapters/            # figmaRest.ts, mockSource.ts, jsonSource.ts
│  ├─ transform/              # SourceDocument -> DesignGraph
│  │  ├─ classify.ts          # raw Figma type -> semantic node type
│  │  ├─ figmaUrl.ts          # deep links
│  │  └─ buildGraph.ts        # nodes, edges, reverse edges, warnings
│  ├─ query/                  # read model
│  │  ├─ GraphIndex.ts        # indexes + traversal
│  │  ├─ analytics.ts         # usage, orphans, unused, blast radius
│  │  ├─ search.ts            # query language
│  │  ├─ filters.ts           # filter state + predicate
│  │  └─ subgraph.ts          # levels, view modes, progressive disclosure
│  └─ ai/                     # bounded context assembly
│     ├─ context.ts           # AiGraphContext
│     └─ serialize.ts         # JSON + markdown prompt
├─ state/                     # Zustand store
├─ ui/
│  ├─ overview/               # library counts, health, scoreboard
│  ├─ governance/             # rules page
│  └─ panels/                 # import and Figma load
├─ mock/                      # REST-shaped fixture + variables fixture
└─ styles/                    # tokens.css, app.css
tests/                        # vitest, core only
docs/
```

The dependency rule is one-directional: `ui` → `state` → `core`, and within
core `ai`/`query` → `transform` → `ingestion` → `model`. Nothing in `core`
imports React.

`query/communities.ts` and `core/layout/force.ts` still exist for tests and the deprecated `orient` summary. They do not draw a screen.
