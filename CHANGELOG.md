# Changelog

## Unreleased — finder gaps

Oct 7, 2026 IST. New `resolve gaps [--json]` lists what designers asked `recommend` for (MCP tool or CLI) that came back empty or as a weak match, most asked first, with a count and the last date. Asks are kept in `<store>/scoreboard/gaps.jsonl`, which setup's gitignore block already keeps out of git. `score phrases`, `recipe` and `resolve` do not add to it, and a failed write never breaks `recommend`. Ranking is unchanged. Default MCP tools stay 7.

## Unreleased — Markdown cards

Oct 7, 2026 IST. MCP tools return a Markdown card by default. `format: "json"` returns the same card as compact JSON. Both drop filler: the `cost` block, rank `score`, duplicate `node:` ids, the "Do not Read graph.json" hint, learn's save-state dump, and the handoff parts list sent twice. Cards keep `fileKey`, `figmaNodeId`, `componentKey`, the `ex` example id, a PASS/FAIL line, replacements for invented, deprecated and retired names, slot status with the next `recommend`, `textChecked`, name-guess and other-library flags, the context echo, and code-map statuses with their sentences and exit codes. A part from another library in the screen's parts card is `code: "unknown"`, `status: "other-library"`. The CLI prints compact JSON; `--pretty` indents it. Exit codes are unchanged. On the Acme set (14 cards) tokens go from 4,434 to 3,269. Ranking is unchanged. Default MCP tools stay 7.

## Unreleased — name check and context-pack check

Oct 7, 2026 IST. `resolve code-map --check` reads the committed handoff and code map only (no learned cache). It matches file key and node id, never a shared package alone, and answers ok, retired, not in this handoff, unmapped, other-library (exit 6), or not-found. A draft handoff is refused. `--check` needs `status: retired` on the map entry unless the sheet itself says retired. `resolve pack validate` stays strict (slug, accessibility, recipe ids, no file key, token, or node id; unknown fields warn). Loading a pack skips a bad pack or field and warns once, so a command does not fail because of the pack file. Ranking is unchanged. Audience, a11y, and density are echoed and do not change the pick.

## Unreleased — context-pack slot fill and cache ignore

Oct 7, 2026 IST. A context pack linked to a recipe no longer empties that recipe's slots in handoff or in the recipe card. The pack phrase is not pasted into the component query. An extra intent is ranked with the slot words. A product name that is itself a component name can outrank the slot words; the pack is not only a tie-break. A slot with a stored default master still uses that master. Setup's `.gitignore` block ignores the learned cache and scoreboard run history (`.resolve/scoreboard/*`). Phrase sets (`scoreboard/phrases/`) and golden files (`scoreboard/golden/`, including the file from `score --init`) stay committable, with recipes, context packs, the code map, decisions (`sock.json`), bind rules and synonyms. A user line such as `.resolve/*` is treated as ignoring the whole folder, same as `.resolve/`. Resolve's ticket add-on for AIDLC, if your team uses it, uses `design-handoff`. It calls `/handoff`. Ranking of a plain recommend is unchanged.

## Unreleased — slash commands

Oct 7, 2026 IST. `resolve-setup` installs `/design-system`, `/find`, `/check`, `/parts`, `/handoff` and `/resolve-status` as Claude Code commands (`.claude/commands/`) and Cursor commands (`.cursor/commands/`), plus the same six as MCP prompts. Resolve-owned files carry begin/end markers; a file you wrote is kept, and `resolve-setup --uninstall` removes only Resolve's own. No shared hash manifest. New `resolve status` (libraries, when learned, version, token, always-on rule, next step). `/design-system` reports components, retired items, icon libraries and where it was saved, and is safe to run again. `/find` shows a weak match as weak. `/parts` is what's on a screen and its code twin (or unmapped); `/handoff` is the developer build sheet. Failures are one plain sentence (bad link, token, View-only seat, nothing learned, not installed), never a stack trace. Setup's `.gitignore` block ignores only the learned cache. A pasted Figma link with `node-id` works as a frame. Handoff: selector-pinned attributes no longer contradict a variant's suggested input, recipe slots are `placed` / `inside` / `missing` (one copy per slot), a not-found part inside a library component's definition refuses, and other-library or not-found parts are `code: "unknown"`. Ranking is unchanged.

## Unreleased — context from the requirements

Oct 7, 2026 IST. Context from the requirements or FSD sets the product and journey before a designer agent picks a component. A context pack is used only on an exact product match, and an exact journey match when the document gives one. Audience, a11y and density are echoed with their source and do not change the pick.

## Unreleased — RESOLVE_HOME

Oct 3, 2026 IST. `RESOLVE_HOME` is now the documented name of the store-folder setting. The old setting name and the old project store folder still work as fallbacks, and the new names win when both exist (see the upgrade note in the README). Nothing is moved or deleted. The old names are gone from commands, help text, cards and docs.

## Unreleased — live text in verify, example caching

Sep 28, 2026 IST. `verify_frame` reads text characters from Figma `get_design_context`. Pass that same design context to `learn_library`, or the component default stays unknown: `textChecked` is `partial` with `default text unknown; pass design context to learn_library`, and leftover-text stays silent. `textChecked` is `true` only when instance text and the default were both read. Partial layer coverage reports `partial: N of M text layers read`. A frame with no text layers is `n/a`. A component list with no frame is `false` / `no frame`. The field is kept even when the card is tight (drop the reason or trim the hint first). A `texts` map only fills empty layers inside the verified frame; it does not replace stored copy and does not rewrite component defaults. Design context may replace stored copy and the card reports `textOverrides`. Supplied text is capped at 2000 entries and 2000 characters each. Layer names are never text. Instance descriptions and the chosen example are computed once per request. The fixed-height peer check stops at the first matching peer. `npm run bench`: 73k-node recommend is 59–114 ms and `get_example` 42–65 ms (uncached baseline 763 ms and 571 ms); verify is 11–16 ms. The bench heavy file (40 components × 900 instances, 75,682 nodes) recommends in 296–465 ms. On a reviewer's generated heavy 73k-node graph: recommend about 0.69 s (510 ms before #21, 3.6 s on #21); verify about 33 ms. `npm run bench` rebuilds the bench fixtures.

## Unreleased — real example with every pick

Sep 28, 2026 IST. The top recommend pick includes `ex`: a real populated instance (file key when it differs, node id, screen, compact config) or `none` plus a short reason. `get_example` / `resolve example` returns the full config for that pick and for the others. Clone that instance and replace content; do not start from the default variant. A populated shape verified on 3 screens becomes the preferred example (SOCK), and a variant pick only learns that variant. Bind rules still change only through human-approved SOCI suggestions.

`verify_frame` fails lorem-ipsum filler. Leftover default copy warns, and fails only when that default is also listed in `.resolve/placeholders.json`. An oversized fixed height warns unless real examples use the same height. Recommend and verify cards stay within 600 characters. Resolve and recipe cards stay within 2000.

## Unreleased — component picking

Recommend leads with name, token, and synonym. Screen, journey, and usage only break ties among those matches, so a busy screen cannot outrank a master the words actually name. A multi-word master matches as a phrase before a single generic token (`button`, `bar`) counts. A typo is checked only when nothing else matched: the whole name with spaces removed, at least 5 letters, one missing letter or a neighbouring swap, and only when a single master wins. `scoreboard/regression` locks those ranking bugs. It is not a measure of unseen phrasing. A slot such as `primary-cta` is the component role when the intent does not already name a master (`sign in`). A journey step such as `summary` stays context. A 600-character recommend card keeps the place-ready top hit (score included) and up to two shorter options that still carry `fileKey` and `figmaNodeId`. Synonyms live in `src/data/synonyms.json`. Asking for a deprecated name returns the live replacement (`replaces Legacy Banner (deprecated)`); resolve returns the exact-case master, flagged, plus that replacement. A different casing returns the live replacement. Private `_` / `.` masters return only on an exact-case name. Resolve accepts the same screen, journey, and domain context as recommend. The checkout recipe's primary button slot defaults to Pay CTA. A `tools` object overrides that tool only. `["recipe"]` still scores recommend and resolve. A first-run delta is null.

## Unreleased — accuracy scoreboard

A repeatable check that agent cards pick the right master. Offline on the fixture library, same command on a learned library later.

- **Golden set** — `scoreboard/golden/*.json`. Intent, optional screen / journey / slot, expected master by name (resolved to an id in the store), acceptable alternates, must-not cousins, or an empty card when there is no answer.
- **`resolve score`** — invent rate (must be 0), wrong-cousin rate, top-1, top-3 only on cards with three or more candidates (`x/N`, or `n/a` when that count is 0), empty-when-weak (`n/a` when a tool has no empty cases), leaks only when a retired or private master is offered as a pick, card size against the budgets, latency. Run-level top-1, top-3, cousin, empty-ok, and leak leave verify out. Recipe is scored on cases marked `tools: ["recipe"]`; a missing card is a miss. Verify’s hit is did-you-mean, only for name-like asks, and the suggestion is a component master. Workspace names reject `.`, `..`, and slashes (`/api/scoreboard?workspace=..` is 400). Saves `~/.resolve/<workspace>/scoreboard/<timestamp>.json`. The delta and the trend compare only a previous run of the same golden set and workspace. Top-3 stays off the delta line until at least 10 cards qualify. Exits non-zero on invent or a budget breach.
- **Rules and Overview** — read-only latest run and trend. The page shows the newest run across workspaces, or the workspace you pick.
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

- **Why line** — every recommend / recipe / named-lookup hit includes one line built only from SOCK facts (real-screen count, confidence, freshness, deprecated/removed, pack/journey, bind-rule hit). No verified screen but instances exist: `used N× in file`. No instances: `not verified on a screen yet`. Never invented. Recommend/verify cards stay under ~600 chars; recipe cards stay trimmed.
- **Bind rules** — `.resolve/bind-rules.json` (template: `src/data/bind-rules.example.json`). Shapes: require this master for a screen/slot, forbid deprecated/removed/name, prefer library A over B. Schema validated. Unknown ids fail loudly. CLI and MCP reload on change. Optional `bindRules` on a context pack. Recommend ranks and filters; verify names the rule and returns the correct master id + place hint.
- **Approve flow** — rules never auto-change. `resolve approve` / `resolve reject` (MCP `approve_proposal` / `reject_proposal` on the advanced surface) write the rules file and append an audit line (who, when, proposal id, before/after). Default MCP stays six tools.
- **Human view** — Rules tab in the web app: rules, pending proposals, why for a chosen master. Read-only.
- **Docs** — [docs/BIND-RULES.md](docs/BIND-RULES.md) in plain English.

## Unreleased — Resolve for Figma MCP (plug-and-play + SOCK)

## Unreleased — Resolve for Figma MCP (plug-and-play + SOCK)

Agent with only Figma MCP + Resolve MCP can learn a library and stay current. No clone, no hand-built JSON.

- **Install** — `npx -y -p github:TANISHQBAFNA/resolve resolve-mcp` (the `-p` form starts the MCP server, not the CLI). Config snippet next to Figma MCP: [docs/SETUP-MCP.md](docs/SETUP-MCP.md). Learning needs a paid Figma MCP seat (Dev/Full) or a REST token. View/free seats: low quota; progress saves and resumes.
- **One store** — `~/.resolve/<workspace>` (or `RESOLVE_HOME`). Auto-reload on change. Empty state says `learn_library`.
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
- **MCP** — tool results are compact JSON. The server reloads `graph.json` when the file changes (no restart). Store path is the same as the CLI: `RESOLVE_HOME` wins, else nearest `.resolve` walking up from cwd. Missing-graph errors name the exact path. `list_graphs` / `get_health` / `workspace` include `store.path` + `builtAt`.
- **resolve by name** — exact master always returns `id` + `fileKey` + `figmaNodeId`, even with zero instances. A miss says so and points at `recommend`, not an empty list that looks like success.
- **ingest `--from-metadata`** — raw Figma MCP `get_metadata` XML (no REST token). Same adapter as a `{ metadataXml }` JSON capture.

## Unreleased — Michigan UAT Ready-with-minor

Low defects after bet B. No new product bets.

- **Docs** — [INTEGRATIONS.md](docs/INTEGRATIONS.md) matches the multi-file workspace (`ingest --role`, `.resolve/workspace.json`, `workspace`, `cousins` / `check_cousins`). Designers still start at [GUIDE.md](docs/GUIDE.md).
- **verify_frame** — result cards stamp `fileKey` next to `figmaNodeId` when the graph or workspace knows the file (frame, invents, deprecated, unresolved).
- **ingest --role** — unknown roles fail with a clear error and a non-zero exit. Valid: `library` | `product` | `client`. No silent fallback.

## Unreleased — multi-file workspace + wrong-cousin report

One shared design system is the system of record. Resolve holds one knowledge workspace, not one giant Figma file.

- **Workspace** — designer JSON at `.resolve/workspace.json` (template: `src/data/workspace.example.json`). Files list: role `library` | `product` | `client`, key/url, label. `ingest --role` writes it. Per-file graphs in `.resolve/files/`.
- **Provenance** — every master/node card stamps `fileKey` + `figmaNodeId` (ids collide across files).
- **Remote stubs** — when the library file is ingested, remotes link to that FILE (and to the real master on exact id/key match), not only the synthetic “source unknown” bucket.
- **Recommend** — prefers DS library masters when a library-role file is linked. Context packs may name `files` and optional `client` (same pack schema).
- **Wrong cousin** — CLI `resolve cousins` + MCP `check_cousins`. Same role / weak name, different master family than the shared DS. Unsure → says so. Never invents a master.
- **Guide** — [docs/GUIDE.md](docs/GUIDE.md) how to add the library + product files and run the cousin check. Happy path still never `Read` graph.json.

## Unreleased — designer guide

Plain-language how-to for designers and product people: [`docs/GUIDE.md`](docs/GUIDE.md). README points there first. Context-pack example `howToAdd` clarified. Technical pages keep a one-line pointer. Agent docs and `verify --help` list `--pack` / `--product` / `--journey` / `--domain` (same flags the CLI actually reads).

## Unreleased — product + journey context packs

Shared libraries need *this* product and *this* journey step, not a generic name match.

- **Context packs** — designer JSON at `.resolve/context-packs.json` (template: `src/data/context-packs.example.json`). Fields: product, domain, journey step / screen job, audience, constraints, `recipeIds`, optional `libraryRules`. Never Figma node ids.
- **Recipe bind** — `recipe` list/get apply the matching pack to slot fills and `nextRecommend`. Bind via `recipeIds`, recipe `contextPackId`, `--pack` / `--product` / `--journey` / `--domain`, or file `active`.
- **Recommend** — CLI + MCP accept `pack` / `product` / `journey` / `domain` (or load the active pack) and rank that context on top of name/intent, variants, where-used, live over stale, deprecate demotion. Empty match still does not invent.
- **verify_frame** — still invent / deprecated / unresolved. Pack `libraryRules` are a light hook, not a cross-product cousin report.
- **Skill path** — ingest → (optional context pack / recipe) → recommend unbound → place returned ids only → verify_frame. See `docs/RECIPES.md`.

## Unreleased — agent-output (ranking, skill path, bound recipes)

AI drafting from the library gets better picks and a forced happy path — not invented one-offs.

- **Recommend ranking** — name/intent, variant props, where-used and sibling co-occurrence, live over stale, deprecated demoted. Cards still cap ~2000 chars. A realistic brief prefers the live used master over a weak name match or deprecated twin.
- **Skill path** — AGENTS.md + resolve skill: ingest (refresh if library changed) → recipe if the job matches → recommend unbound slots → place returned ids only → verify_frame. Forbidden: invent components, Read/dump graph.json.
- **Bound recipes** — after ingest, `recipe` list/get resolve slots against live masters. Overlay `.resolve/recipes.json` still wins. Unbound slots return `nextRecommend`. Never invent node ids. See `docs/RECIPES.md`.

## Unreleased — screen recipes

Named composition packs so agents draw common screens from library masters, not invented one-offs. Designers edit JSON; agents never Read `graph.json`.

- **Recipes** — ordered slots (role, required/optional, recommend hints, optional bound master id). Starter pack in `src/data/recipes.json`. Overlay: `.resolve/recipes.json` (same id replaces a starter). See `docs/RECIPES.md`.
- **`list_recipes` / `recipe` / `get_recipe`** — MCP + CLI `npm run resolve -- recipe …`. Unbound slots use the same ranking path as `recommend`. Missing or deprecated bound ids are flagged. No invented Figma node ids.
- **Happy path** — ingest → (optional) recipe → recommend unbound slots → Figma with returned ids → `verify_frame`.

## Unreleased — recommend + verify_frame

Closed loop so reuse is measurable. Designers still set the library; agents draft from stored Figma masters.

- **`recommend`** — free-text intent → ranked masters/variants (`figmaNodeId`, where-used, slots, deprecated demoted). MCP, CLI `npm run resolve -- recommend "…"`, skill docs.
- **`verify_frame`** — after a draw, pass/fail invents / deprecated / unresolved. Optional `.resolve/library-rules.json` allow/deny. Else in-graph master + not deprecated = approved. Deterministic, no LLM.
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
