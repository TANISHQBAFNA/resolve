# Changelog

## Unreleased — accuracy scoreboard

A repeatable check that agent cards pick the right master. Offline on the fixture library, same command on a learned library later.

- **Golden set** — `scoreboard/golden/*.json`. Intent, optional screen / journey / slot, expected master by name (resolved to an id in the store), acceptable alternates, must-not cousins, or an empty card when there is no answer.
- **`resolve score`** — invent rate (must be 0), wrong-cousin rate, top-1 and top-3, empty-when-weak, deprecated or private leaks, card size against the budgets, latency. Saves `~/.resolve/<workspace>/scoreboard/<timestamp>.json` and prints the change since the last run. Exits non-zero on invent or a budget breach.
- **Rules and Overview** — read-only latest run and trend.
- **CI** — typecheck, tests, build, and `resolve score` on the fixture set.
- **Preview** — the embedded governance loader sets `ws: false`, so preview does not open a websocket on port 24678.
- **Screen type** — generic words (screen, page, frame, view, untitled, copy, v1/v2, and the like) are not a screen type. If only those words remain, scoping is skipped.

## Unreleased — SOCI v1 (usage → human-approved improvements)

SOCI turns verified-frame usage into proposals. It never auto-applies.

- **Proposal types** — besides scoped require-rules: recipe slot updates, variant candidates (REST overrides / extra nested instances only), deprecation candidates (unused master while a cousin is strong), wrong-cousin hotspots (verify corrections). List-only verifies never count. Same proposal merges evidence. Cap keeps the top handful per workspace.
- **Approve** — same gated flow (`confirmedBy` / `--who` + audit). Recipe update writes `recipes.json` atomically. Variant and deprecation record a design-team decision only — no Figma, no masters. Wrong-cousin can write a prefer-over bind rule when files differ.
- **Surface** — `list_soci` stays advanced. Verify/recipe cards include `pending improvements: N`. Rules tab groups by type with evidence. `/api/governance` is read-only on Vite dev and preview.
- **Quarantine warnings** count toward the agent card budget (`and K more warnings`).
- **Docs** — [docs/SOCI.md](docs/SOCI.md). MCP metadata has no override payload; Plugin `detachedInfo` is not in REST — those signals are skipped, never guessed.

## Unreleased — thin bet C (why line, bind rules, approve)

Human rules stay human. SOCK still records usage. SOCI only proposes.

- **Why line** — every recommend / recipe / named-lookup hit includes one line built only from SOCK facts (real-screen count, confidence, freshness, deprecated/removed, pack/journey, bind-rule hit). No facts: `no usage yet`. Never invented. Recommend/verify cards stay under ~600 chars; recipe cards stay trimmed.
- **Bind rules** — `.graphify/bind-rules.json` (template: `src/data/bind-rules.example.json`). Shapes: require this master for a screen/slot, forbid deprecated/removed/name, prefer library A over B. Schema validated. Unknown ids fail loudly. CLI and MCP reload on change. Optional `bindRules` on a context pack. Recommend ranks and filters; verify names the rule and returns the correct master id + place hint.
- **Approve flow** — rules never auto-change. `resolve approve` / `resolve reject` (MCP `approve_proposal` / `reject_proposal` on the advanced surface) write the rules file and append an audit line (who, when, proposal id, before/after). Default MCP stays six tools.
- **Human view** — Rules tab in the web app: rules, pending proposals, why for a chosen master. Read-only.
- **Docs** — [docs/BIND-RULES.md](docs/BIND-RULES.md) in plain English.

## Unreleased — Resolve for Figma MCP (plug-and-play + SOCK)

## Unreleased — Resolve for Figma MCP (plug-and-play + SOCK)

Agent with only Figma MCP + Resolve MCP can learn a library and stay current. No clone, no hand-built JSON.

- **Install** — `npx -y -p github:TANISHQBAFNA/resolve resolve-mcp` (the `-p` form starts the MCP server, not the CLI). Config snippet next to Figma MCP: [docs/SETUP-MCP.md](docs/SETUP-MCP.md). Learning needs a paid Figma MCP seat (Dev/Full) or a REST token. View/free seats: low quota; progress saves and resumes.
- **One store** — `~/.resolve/<workspace>` (or `GRAPHIFY_HOME`). Auto-reload on change. Empty state says `learn_library`.
- **learn_library** — primary path: Figma MCP `get_metadata` XML + optional `search_design_system` / `get_libraries`. Incremental, checkpointed across sessions (`learned X of Y pages; next: …` / `library complete`). Masters recorded per frame subtree; removed-by-absence only after every home frame is re-learned. Secondary: REST token ingest. Published keys match exact `fileKey` + `nodeId` + master type only. No Figma plugin in the user story (`figma-plugin/` is internal/unsupported).
- **Place-ready cards** — `fileKey`, `nodeId`, published `componentKey` when known; otherwise `local-only`. Removed-by-absence masters are never recommended.
- **Live usage** — verify pass writes SOCK facts. Only a real frame (`fileKey` + frame node id) counts toward the N=3 strong threshold; list-only verifies are observations. Freshness.stale includes a delta of pages/frames to re-fetch. Crossing strong vs an existing recipe writes a pending SOCI proposal (`list_soci` stays advanced).
- **Ingest 429** — honor `Retry-After`, or exponential backoff when that header is missing. Variables go through the same retry. Checkpoints are tied to file version/lastModified so resume never mixes versions.
- **Default tools** — `learn_library`, `recipe`, `recommend`, `resolve`, `verify_frame`, `check_cousins`. `RESOLVE_MCP_ADVANCED=1` for the rest. Instructions ship on MCP initialize.

## Unreleased — harden agent loop (Material 3 live gate)

No new product bets. Recommend + verify no longer invent on a real library.

- **verify** — component lists approve only an exact name or exact id (including stamped `fileKey:nodeId`). A near match is unresolved with a did-you-mean, never `pass`. The card echoes each given name and what it resolved to. Private masters (name starts with `.` or `_`) fail rather than approve.
- **recommend / recipe** — private `.` / `_` masters are not candidates or slot fills. `search` is a real recommend term. New starter `search-results` recipe; “search results list” no longer routes to empty-state. “no results” still does. Recipe cards drop fields that do not help an agent place.
- **ingest** — 429 honors `Retry-After` with a bounded wait (and a clear message when the wait is too long). Completed sections checkpoint so a re-run resumes. Page-level COMPONENT / COMPONENT_SET are collected. Unnamed sections get `page name + index`. `--scope file` is documented as the safer low-tier choice. Same-file `--role` change is refused unless `--force-role`.
- **MCP** — tool results are compact JSON. The server reloads `graph.json` when the file changes (no restart). Store path is the same as the CLI: `GRAPHIFY_HOME` wins, else nearest `.graphify` walking up from cwd. Missing-graph errors name the exact path. `list_graphs` / `get_health` / `workspace` include `store.path` + `builtAt`.
- **resolve by name** — exact master always returns `id` + `fileKey` + `figmaNodeId`, even with zero instances. A miss says so and points at `recommend`, not an empty list that looks like success.
- **ingest `--from-metadata`** — raw Figma MCP `get_metadata` XML (no REST token). Same adapter as a `{ metadataXml }` JSON capture.

## Unreleased — Michigan UAT Ready-with-minor

Low defects after bet B. No new product bets.

- **Docs** — [INTEGRATIONS.md](docs/INTEGRATIONS.md) matches the multi-file workspace (`ingest --role`, `.graphify/workspace.json`, `workspace`, `cousins` / `check_cousins`). Designers still start at [GUIDE.md](docs/GUIDE.md).
- **verify_frame** — result cards stamp `fileKey` next to `figmaNodeId` when the graph or workspace knows the file (frame, invents, deprecated, unresolved).
- **ingest --role** — unknown roles fail with a clear error and a non-zero exit. Valid: `library` | `product` | `client`. No silent fallback.

## Unreleased — multi-file workspace + wrong-cousin report

One shared design system is the system of record. Resolve holds one knowledge workspace, not one giant Figma file.

- **Workspace** — designer JSON at `.graphify/workspace.json` (template: `src/data/workspace.example.json`). Files list: role `library` | `product` | `client`, key/url, label. `ingest --role` writes it. Per-file graphs in `.graphify/files/`.
- **Provenance** — every master/node card stamps `fileKey` + `figmaNodeId` (ids collide across files).
- **Remote stubs** — when the library file is ingested, remotes link to that FILE (and to the real master on exact id/key match), not only the synthetic “source unknown” bucket.
- **Recommend** — prefers DS library masters when a library-role file is linked. Context packs may name `files` and optional `client` (same pack schema).
- **Wrong cousin** — CLI `resolve cousins` + MCP `check_cousins`. Same role / weak name, different master family than the shared DS. Unsure → says so. Never invents a master.
- **Guide** — [docs/GUIDE.md](docs/GUIDE.md) how to add the library + product files and run the cousin check. Happy path still never `Read` graph.json.

## Unreleased — designer guide

Plain-language how-to for designers and product people: [`docs/GUIDE.md`](docs/GUIDE.md). README points there first. Context-pack example `howToAdd` clarified. Technical pages keep a one-line pointer. Agent docs and `verify --help` list `--pack` / `--product` / `--journey` / `--domain` (same flags the CLI actually reads).

## Unreleased — product + journey context packs

Shared libraries need *this* product and *this* journey step, not a generic name match.

- **Context packs** — designer JSON at `.graphify/context-packs.json` (template: `src/data/context-packs.example.json`). Fields: product, domain, journey step / screen job, audience, constraints, `recipeIds`, optional `libraryRules`. Never Figma node ids.
- **Recipe bind** — `recipe` list/get apply the matching pack to slot fills and `nextRecommend`. Bind via `recipeIds`, recipe `contextPackId`, `--pack` / `--product` / `--journey` / `--domain`, or file `active`.
- **Recommend** — CLI + MCP accept `pack` / `product` / `journey` / `domain` (or load the active pack) and rank that context on top of name/intent, variants, where-used, live over stale, deprecate demotion. Empty match still does not invent.
- **verify_frame** — still invent / deprecated / unresolved. Pack `libraryRules` are a light hook, not a cross-product cousin report.
- **Skill path** — ingest → (optional context pack / recipe) → recommend unbound → place returned ids only → verify_frame. See `docs/RECIPES.md`.

## Unreleased — agent-output (ranking, skill path, bound recipes)

AI drafting from the library gets better picks and a forced happy path — not invented one-offs.

- **Recommend ranking** — name/intent, variant props, where-used and sibling co-occurrence, live over stale, deprecated demoted. Cards still cap ~2000 chars. A realistic brief prefers the live used master over a weak name match or deprecated twin.
- **Skill path** — AGENTS.md + resolve skill: ingest (refresh if library changed) → recipe if the job matches → recommend unbound slots → place returned ids only → verify_frame. Forbidden: invent components, Read/dump graph.json.
- **Bound recipes** — after ingest, `recipe` list/get resolve slots against live masters. Overlay `.graphify/recipes.json` still wins. Unbound slots return `nextRecommend`. Never invent node ids. See `docs/RECIPES.md`.

## Unreleased — screen recipes

Named composition packs so agents draw common screens from library masters, not invented one-offs. Designers edit JSON; agents never Read `graph.json`.

- **Recipes** — ordered slots (role, required/optional, recommend hints, optional bound master id). Starter pack in `src/data/recipes.json`. Overlay: `.graphify/recipes.json` (same id replaces a starter). See `docs/RECIPES.md`.
- **`list_recipes` / `recipe` / `get_recipe`** — MCP + CLI `npm run resolve -- recipe …`. Unbound slots use the same ranking path as `recommend`. Missing or deprecated bound ids are flagged. No invented Figma node ids.
- **Happy path** — ingest → (optional) recipe → recommend unbound slots → Figma with returned ids → `verify_frame`.

## Unreleased — recommend + verify_frame

Closed loop so reuse is measurable. Designers still set the library; agents draft from stored Figma masters.

- **`recommend`** — free-text intent → ranked masters/variants (`figmaNodeId`, where-used, slots, deprecated demoted). MCP, CLI `npm run resolve -- recommend "…"`, skill docs.
- **`verify_frame`** — after a draw, pass/fail invents / deprecated / unresolved. Optional `.graphify/library-rules.json` allow/deny. Else in-graph master + not deprecated = approved. Deterministic, no LLM.
- **Refresh** — re-run `resolve ingest` before recommend/verify if the Figma library changed. No live-sync rewrite.

Happy path: ingest → (optional) recipe → recommend(intent) → Figma with returned ids → verify_frame. Do not Read `graph.json`.

## Unreleased — toolchain upgrade (2026-09-20)

Framework and test-runner bump only. No UI redesign, no Figma API rewrite, no graph-library swap.

### Upgraded

| Package | Before | After |
| --- | --- | --- |
| vite | 5.4.x | 8.3.0 |
| @vitejs/plugin-react | 4.3.x | 6.1.1 |
| typescript | 5.6.x | 5.9.3 (latest 5.x) |
| vitest | 2.1.x | 5.0.1 |
| @playwright/test | 1.62.x | 1.63.0 |
| react / react-dom | 18.3.x | 19.3.0 |
| @types/react / react-dom | 18.3.x | 19.3.0 |
| @xyflow/react | 12.3.x | 12.11.6 |
| zustand | 5.0.1 | 5.0.15 |
| zod | 3.23.x | 3.25.76 |
| @dagrejs/dagre | 1.1.4 | 1.1.8 |
| @types/node | 22.20.1 | 22.20.4 |

React 19 kept: `@xyflow/react@12.11.6` peers `react`/`react-dom` `>=17`. `npm run typecheck`, `npm test`, and `npm run build` all passed on 19.3.0.

Node requirement is now `^22.12.0 || >=24.0.0` (Vitest 5). This environment: Node 22.14.

### Deferred

| Item | Why |
| --- | --- |
| TypeScript 6 / 7 | Request was latest **5.x** |
| Zod 4 | `z.record()` now needs key + value schemas; not a compatible-range bump |
| @dagrejs/dagre 2/3 | Layout still uses `graphlib.Graph()` + `dagre.layout()` from 1.x |
| Vite 6 as a stop | Current stable is Vite 8 (Rolldown). App config still uses `build.rollupOptions`; Vite 8 compatibility layer accepted it |

### How to run

```bash
# Node ^22.12 or >=24
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e   # optional; needs Playwright browsers
npm run dev
```
