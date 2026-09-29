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
| 10 | **Figma MCP `get_metadata` omits `componentId`.** It returns ids, types, names and geometry only. A layer can be renamed, so that name is not the component. | Instance identity is tagged `identity: "inferred-from-name"` and cards say **guess from layer name, not confirmed**. Never verified, never a confirmed cousin. REST, the plugin, and `get_design_context` (`componentId` / `componentKey` / `data-component-id` / JSON `"componentId"`) supply real ids. The parser also accepts `componentId` / `componentKey` on metadata XML if they appear; other attribute names are unconfirmed. |
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
Plugin API ─┼─▶ SourceDocument ─▶ buildGraph ─▶ DesignGraph ─▶ GraphIndex ─▶ subgraph ─▶ UI
Figma MCP  ─┤                                                              └─▶ AI context
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

## 4. Graph visualisation library — recommendation

**Use React Flow (`@xyflow/react`), with the layout kept behind our own
functions.**

The deciding factor is what a node has to *say*. Every node in this product
carries a name, a semantic type, a shape, an origin badge (local vs library), a
usage count, an unresolved-main warning, and an expand affordance. That is a
component, not a circle with a label — and React Flow renders nodes as real
React components with full CSS, which none of the canvas/WebGL libraries do
well.

The usual objection to React Flow is scale: it renders DOM, and it degrades
somewhere around 1–2k visible nodes. **That ceiling is not the binding
constraint here**, because the product never renders the file — it renders a
capped subgraph (default 300 nodes) chosen by level, view mode and expansion.
If a design required drawing 50k nodes at once, the right answer would be
different; this design deliberately says that view is not useful to a human.

| Option | Strengths | Why not the default here |
|---|---|---|
| **React Flow** ✅ | React-native custom nodes, handles/edges/labels, minimap + controls + fitView built in, first-class TypeScript, controlled state fits Zustand | DOM rendering caps around 1–2k visible nodes — bounded by progressive disclosure |
| Cytoscape.js | Canvas rendering, strong graph theory built in (centrality, clustering), 10k+ nodes | Node rendering is style-driven, not React; rich node cards are painful; an imperative API to bridge |
| Sigma.js | WebGL, 100k+ nodes effortlessly | Built for large homogeneous networks; poor fit for heterogeneous, information-dense nodes; weakest custom-node story |
| G6 / vis-network | Batteries-included layouts | Heavier, less idiomatic in a React + TS codebase |
| D3 by hand | Total control | We would rebuild pan/zoom, minimap, edge routing and hit-testing for no gain |

**Layout** stays ours (`ui/graph/layout/layouts.ts`) so it can be swapped
independently:

- *hierarchical* — dagre, for containment and prototype flow.
- *radial* — concentric rings by hop distance from the focus node, for
  dependency and usage views. Deterministic (no simulation, no jitter, no
  settling animation), which matters when the same selection must produce the
  same picture twice.

**Escape hatch.** The visualisation layer only consumes `Subgraph`
(`{nodes, edges}`). A future "whole-file overview" mode can render the same
structure with Sigma.js behind the same interface without touching ingestion,
transform, query or AI.

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
│     ├─ serialize.ts         # JSON + markdown prompt
│     └─ provider.ts          # LlmProvider interface + action catalogue
├─ state/                     # Zustand store + selectors (the only glue)
├─ ui/
│  ├─ graph/                  # canvas, custom node, layouts, legend
│  ├─ panels/                 # search, filters, browser, inspector, AI panel
│  ├─ common/                 # breadcrumbs, toolbar
│  └─ nodeVisuals.ts          # the visual grammar
├─ mock/                      # REST-shaped fixture + variables fixture
└─ styles/                    # tokens.css, app.css
tests/                        # vitest, core only
docs/
```

The dependency rule is one-directional: `ui` → `state` → `core`, and within
core `ai`/`query` → `transform` → `ingestion` → `model`. Nothing in `core`
imports React.

## 6. Progressive disclosure

Four levels, chosen automatically from the focused node's type and overridable
in the toolbar:

| Level | Focus | Shows |
|---|---|---|
| **L1 Product map** | File | File, pages, sections, top-level frames and component definitions |
| **L2 Page map** | Page / section | Sections, screens, prototype navigation, and the main components those screens use |
| **L3 Frame composition** | Frame, group, instance | Direct children, every nested instance, their main components, styles and variables, prototype destinations |
| **L4 Component dependencies** | Component set, main component, variant | The set, its variants, every instance, the frames and pages those instances live on, nested components, foundations, library source |

Four view modes filter the edges over the same node set: **hierarchy**
(`CONTAINS`, `INSTANCE_OF`, `PROTOTYPES_TO`), **dependency**, **usage**,
**prototype flow**. Outside hierarchy view, nodes with no edge are dropped —
an unconnected node in a dependency map is noise.

On top of that: manual expand/collapse (double-click), a node cap that reports
what it hid, and filters applied before layout.

## 6b. The atlas — whole-file view

Progressive disclosure answers "what is this one thing made of". It cannot
answer "what does this file look like", and that question needs the opposite
treatment: everything at once, no detail per node, structure carried by
clustering.

**Projection** (`core/query/projection.ts`). At file scale, 87 separate `Button`
instance nodes are 87 copies of one fact. Every instance folds onto the
component it references, and the repetition becomes edge weight: one node per
component, one `USED_IN` edge per container that holds it, carrying how many
times. An instance whose main component could not be resolved has nothing to
fold into and stays a node of its own — which is exactly the anomaly you want
visible at this zoom.

**Communities** (`core/query/communities.ts`). Louvain with a resolution
parameter, plus Graphify's `--exclude-hubs` idea: a node touching everything
drags unrelated clusters together, so the highest-degree nodes can be held out
of the partitioning pass and assigned afterwards to whichever community they
lean into. Communities are named after their highest-degree member, the same
convention Graphify's legend uses, with no LLM involved.

> Graphify uses Leiden, not Louvain. Leiden's refinement phase guarantees every
> community is internally connected; Louvain can rarely violate that. On design
> graphs, where communities are anchored by containment, it has not come up. If
> it does, the fix is a refinement pass inside `communities.ts` and nothing
> else changes.

**Layout** (`core/layout/force.ts`). Fruchterman-Reingold with three additions:
spatial-grid repulsion so a few thousand nodes stay interactive, a pull toward
each community's centroid so clusters read as clusters, and per-community seeded
initial placement so it converges fast. Fully deterministic — same graph, same
picture, every time.

**Rendering** (`ui/graph/AtlasCanvas.tsx`). Canvas 2D rather than React Flow.
The focused levels need information-dense React nodes; the atlas needs a
thousand dots, hover highlighting and pan/zoom. Layouts under 700 nodes settle
synchronously — `requestAnimationFrame` is paused outright in a background tab,
and correctness should not depend on frame cadence. Larger graphs tick against
a per-frame time budget.

## 7. Visual grammar

- **Colour = semantic category**, never decoration. Structure (blue),
  component system (purple), foundations (green), interaction (orange).
- **Shape = role.** Rounded root, page card, dashed section cluster,
  square-cornered screen, pill instance, token pill, stacked component set.
- **Edge style = relationship kind.** Solid for containment, dashed for
  dependency, animated for prototype navigation, arrowheads everywhere.
- Focus and selection are separate states, both explicit.

## 8. What Phase 1 ships, and what it does not

**Shipped:** mock ingestion through the real REST adapter, the full graph model
and transform, reverse indexes, traversal, the query language, filters, the
four levels and four view modes, the node browser, the inspector, deep links,
back/forward history, minimap and fit controls, and the exportable AI subgraph
payload.

**Deliberately not shipped:** live Figma calls, thumbnails, annotation nodes,
any LLM network call, and a dedicated design-system analytics dashboard. The
analytics *engine* exists (usage, unused components, orphaned frames,
unresolved instances, blast radius) and is surfaced through search macros,
filters and the inspector rather than a separate dashboard — that dashboard is
Phase 2.
