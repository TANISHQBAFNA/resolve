# Resolve

> Figma rules. Agents resolve.

[github.com/TANISHQBAFNA/resolve](https://github.com/TANISHQBAFNA/resolve) · MIT licensed · free to use

Every example in this file is made up. "Acme" is a pretend company, the "Payments app" is a pretend product, and the components (Button, Text field, Payee picker) are pretend. None of it comes from a real design system.

## Contents

1. [What Resolve is, and what it is not](#what-resolve-is-and-what-it-is-not)
2. [The problem it solves](#the-problem-it-solves)
3. [How it works, step by step](#how-it-works-step-by-step)
4. [Quick start](#quick-start)
5. [Every command](#every-command)
6. [Team config files](#team-config-files)
7. [Retired and old components](#retired-and-old-components)
8. [Accuracy and honesty rules](#accuracy-and-honesty-rules)
9. [Limits: what is not tested yet](#limits-what-is-not-tested-yet)
10. [Version history](#version-history)
11. [FAQ](#faq)
12. [For developers](#for-developers)

---

## What Resolve is, and what it is not

**Resolve is a lookup service for AI coding and design tools.** You teach it your Figma design system once. After that, an AI tool (Cursor, Claude Code, Claude Desktop) can ask it questions such as "which component is the payee picker?" and get back the real component: its Figma file key, its node id, and (if your team says so) the code component that matches it.

**Resolve is not a Figma plugin.** You do not open it inside Figma. You do not click anything in it. It runs next to your AI tool as an MCP server (MCP is the standard way an AI tool talks to helper programs), and it also has a command line for people.

**Resolve does not draw anything.** The AI tool draws, using Figma's own connector. Resolve only says which library component to use, and checks the result afterwards.

**Resolve does not guess.** If your library has no such component, it says "No master matched". It never makes up a component name or an id.

**Resolve does not change your rules on its own.** Rules, synonyms and code maps are files your team owns. Resolve reads them. It suggests changes (see `soci`), and a person has to approve each one.

## The problem it solves

An AI tool that builds a screen in Figma often does one of three bad things:

- It draws a button from scratch, instead of using the Button from your library.
- It picks a retired component because the name looks right.
- It invents a component name that does not exist.

The result looks fine at a glance but is not built from your design system, so it drifts from it.

Resolve fixes this by giving the AI tool a short, exact answer before it draws, and a pass/fail check after it draws. Answers are small on purpose (600 characters for `recommend` and `verify`) so they fit easily in the AI tool's working memory.

## How it works, step by step

Example: the Acme team wants a "Send money" screen in the Payments app.

1. **Learn the library.** Resolve reads the "Acme UI" Figma file and stores what is in it: components, their variants, and where they are used. This is `ingest` (command line) or `learn_library` (the AI tool calls it).
2. **Ask.** The AI tool asks `recommend "payee picker"`. Resolve returns the Payee picker: file key, node id, and a real instance to copy. If the Acme team filed a code map, the answer also says `PayeePicker from '@acme/payments'`.
3. **Draw.** The AI tool places that component, using the ids Resolve gave.
4. **Check.** The AI tool runs `verify` on the new frame. Resolve checks that every placed piece is a real library component (by component id, not just by layer name), that none is retired, and that no template text is left over. It answers pass or fail.
5. **Learn from use (optional).** When a pattern appears on three screens that passed the check, Resolve can suggest a rule or recipe. A person approves or rejects it.

## Quick start

You need Node 22.12 or newer (`node -v`) and the AI tool you use. Resolve works best when the Figma connection is on in that tool, because the tool then has the library to teach Resolve.

**Step 1: install the rule, once per project.** This makes the AI tool call Resolve before design tasks.

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-setup
```

It writes `.cursor/rules/resolve.mdc`, `.claude/skills/resolve/SKILL.md`, and a marked block in `CLAUDE.md`. Run it again any time; it only changes its own block. `--dry-run` shows what it would do. `--global` writes to `~/.claude` instead (Claude only) and does nothing until you add `--yes`. `--force` replaces a file that has no Resolve markers. Setup ends with a short status: Node, Figma, library learned, rule installed, and the next step.

**Step 2: connect Resolve to your AI tool.**

Claude Code:

```bash
claude mcp add resolve -s user -- npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
claude mcp add --transport http figma https://mcp.figma.com/mcp -s user
```

Then run `/mcp` in Claude Code and log in to Figma.

Claude Desktop: add Figma under **Settings → Connectors**. Then open **Settings → Developer → Edit Config** and add Resolve:

```json
{
  "mcpServers": {
    "resolve": {
      "command": "npx",
      "args": ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
    }
  }
}
```

Quit Claude Desktop with Cmd+Q (not the window close button) and reopen. If Claude Desktop cannot start Resolve, use the full path from `which npx` as `command`. Claude Desktop does not read rule files, skills or `CLAUDE.md`; it only gets the short MCP instructions.

Cursor: Cursor reads the project rule that Step 1 wrote. Steps are in [`docs/CURSOR-RESOLVE.md`](docs/CURSOR-RESOLVE.md).

**Step 3: teach it your library.** Ask your AI tool to learn the library (it calls `learn_library`). Learning needs a paid Figma seat with MCP access (Dev or Full), or a Figma access token for command-line ingest. A view or free seat has a low read quota; Resolve saves progress and resumes on the next pass.

From the command line instead:

```bash
export FIGMA_ACCESS_TOKEN=...   # your own token; never commit it
npm run resolve -- ingest 'https://www.figma.com/design/ACMEUI/Acme-UI' --role library
```

The first file you ingest is the library by default. Later files default to `product`. Full details: [`docs/SETUP-MCP.md`](docs/SETUP-MCP.md).

**Where the data lives.** In a store folder: `GRAPHIFY_HOME` if you set it, otherwise the nearest `.graphify/` folder going up from where you run. The AI tool's MCP server and your command line must use the same folder. `resolve where` prints it.

## Every command

In a checkout of this repo, run commands as `npm run resolve -- <command>`. The installed package exposes the same command line as `resolve-figma`. The examples use the pretend Acme library: a "Button" set (Primary, Secondary, Ghost), "Text field", "Payee picker", "Amount input", and a retired "Old Button". Output below is shortened.

| Command | What it does |
| --- | --- |
| `ingest <file.json \| file.xml \| figma-url \| file-key>` | Reads a Figma file and adds it to the workspace. |
| `learn --file-key <key>` | Same as the MCP `learn_library` tool: load a file from Figma `get_metadata` XML. |
| `recipe [list \| "<name>"]` | Screen packs: the list of components a screen of that kind usually needs. |
| `recommend "<intent>"` | Ranked library components for a plain-words ask. |
| `example "<name>"` | The real, filled-in instance behind a pick, to copy. |
| `resolve "<name>"` | "I know the name, give me the id." |
| `verify "<frame>"` | Pass/fail check of a drawn frame or a list of components. |
| `code-map [--json]` | Report on your Figma-to-code map. |
| `rules` | Lists the bind rules people wrote. |
| `soci` | Lists pending improvement proposals. |
| `approve <id> --who <name>` / `reject <id> --who <name>` | A person says yes or no to a proposal. |
| `cousins ["<frame>"]` | Finds look-alike copies of library parts in product files. |
| `workspace` | Linked files and store location. |
| `orient`, `query`, `path`, `explain`, `check` | Optional exploration of the stored graph. |
| `list`, `reindex`, `rm --yes`, `where` | Look after the store. |
| `score` | Accuracy check against a golden set. |

### ingest

```bash
npm run resolve -- ingest acme-ui.json --role library --name "Acme UI"
```

Takes a REST JSON body, an MCP capture, a graph, raw `get_metadata` XML (`--from-metadata`), a Figma URL, or a file key. A URL with a `node-id` reads just that node. `--scope file` reads the whole file in one request (safer on a low Figma tier). Changing the `--role` of a file already in the workspace is refused unless you add `--force-role`. Roles: `library`, `product`, `client`.

### learn

```bash
npm run resolve -- learn --file-key ACMEUI --from-metadata acme-ui.xml --design-context acme-ui-context.txt
```

Same as `learn_library` in the MCP server. Pass the design context too, so each component's default text is stored (this lets `verify` spot leftover template text).

### recipe

```bash
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
```

A recipe is a list of slots (header, line list, primary action, input). Each slot is filled with a real component from your library, or is marked `unbound` or `missing`, with the next `recommend` to run. It never invents an id. Your own recipes go in `.graphify/recipes.json` and win over the built-in ones. See [`docs/RECIPES.md`](docs/RECIPES.md).

### recommend

```bash
npm run resolve -- recommend "payee picker"
```

```json
{
  "intent": "payee picker",
  "candidates": [
    { "id": "node:10:4", "name": "Payee picker", "figmaNodeId": "10:4", "fileKey": "ACMEUI", "deprecated": false, "why": "used 1× in file", "hint": "Place fileKey + nodeId." }
  ],
  "hint": "Place fileKey+nodeId. If stale, learn_library. Do not Read graph.json.",
  "code": "PayeePicker from '@acme/payments'",
  "cost": { "chars": 481, "approxTokens": 121 }
}
```

The name or words in the ask come first (exact name, word match, synonym). Screen and usage only break ties. The card is at most 600 characters. The `code` line appears only when your team filed a code map and the line fits. Nothing matches? You get an empty list and "No master matched. Do not invent." A loose match carries "Weak match." and up to three parts instead of one confident guess. Options: `--budget <chars>`, `--pack`, `--product`, `--journey`, `--domain`, `--screen-type`.

### example

```bash
npm run resolve -- example "Payee picker"
```

Returns the real instance (file key, node id, screen, variant, size) so the AI tool can clone it and replace the content, instead of starting from the bare default. If no real example is known, it says so.

### resolve

```bash
npm run resolve -- resolve "Text field"
```

Use this when you already know the name. An exact master always comes back with `id`, `fileKey` and `figmaNodeId`, even if it is used nowhere. Retired names come back flagged `deprecated: true` with the live replacement. Private parts (names starting with `_` or `.`) come back only on an exact name. A miss says so and points at `recommend`. If a code map covers a current part, its `code` line is added when it fits.

### verify

```bash
npm run resolve -- verify "Send money"
npm run resolve -- verify "Send money" --components Button,Gold
```

Checks a frame, or a list of component names/ids, after drawing. `pass` is true only when at least one placed piece was checked by its own component id or key and nothing failed. It reports `invents` (not in the library), `deprecated`, `unresolved` (with a "did you mean"), bind-rule misses, lorem-ipsum filler, and leftover template text. Matching by layer name alone is labelled `name-only` and is not a pass. With `--components Button,Gold`, "Gold" is reported as an invent because there is no such component. A failed check exits non-zero. If a used part is retired and your code map knows it, the card also carries a short `retired` list (see [retired components](#retired-and-old-components)).

Pass `--design-context <file>` (Figma `get_design_context` for the frame) so Resolve can read real text, and `--texts <json>` to fill empty layers.

### code-map

```bash
npm run resolve -- code-map
```

```
Code map: 8 components: 2 mapped, 1 retired (kept mapped), 5 unmapped, 0 ambiguous, 0 conflict. 1 stale, 1 ignored entries.
Unmapped: Text field [ACMEUI 10:5]; Amount input [ACMEUI 10:6]; Card [ACMEUI 10:7]; ...
Stale: entry 4 10:99 [ACMEUI] - no such component
Ignored: entry 5 - unsupported field 'key'
```

`--json` prints the same data with the same keys whether or not there is a map (`configured` is `true` or `false`). Details are in [`code-map.json`](#graphifycode-mapjson--figma-to-code-twins) below. With no map, it prints `No code map. Add .graphify/code-map.json next to synonyms.json.`

### rules, soci, approve, reject

```bash
npm run resolve -- rules
npm run resolve -- soci
npm run resolve -- approve <proposal-id> --who "Priya"
npm run resolve -- reject <proposal-id> --who "Priya"
```

`rules` lists human-written bind rules (must use / must not use / prefer; see [`docs/BIND-RULES.md`](docs/BIND-RULES.md)). `soci` lists suggestions made from real use. Nothing is ever applied automatically. `approve` and `reject` record who decided (see [`docs/SOCI.md`](docs/SOCI.md)).

### cousins

```bash
npm run resolve -- cousins "Send money"
```

A "cousin" is a product file's own copy of a library part, such as a hand-built "Price" next to the library's "Price". Needs a library-role file in the workspace. When unsure it says so.

### workspace, where, list, reindex, rm

```bash
npm run resolve -- workspace    # linked files and store path
npm run resolve -- where        # store path, graph.json, builtAt
npm run resolve -- list         # what is stored
npm run resolve -- reindex      # checks graph.json loads
npm run resolve -- rm --yes     # deletes the learned graph (asks you to confirm first)
```

### orient, query, path, explain, check

```bash
npm run resolve -- orient
npm run resolve -- query "payee"
npm run resolve -- path "Button" "Send money"
npm run resolve -- explain "Button"
npm run resolve -- check "button"
```

Optional. They look around the stored graph: a summary, a small related set, the shortest relationship between two things, a short brief on one node, and a variant to use plus retired ones to avoid. Agents should prefer `recommend` and `resolve`.

### score

```bash
npm run resolve -- score --init
npm run resolve -- score --golden scoreboard/golden --workspace fixture
```

Runs a set of asks with known right answers through `recommend`, `resolve`, `recipe` and `verify` and prints a table. It exits non-zero if anything was invented or a card is over its size. `--init` writes a starter set from the library you already learned. See [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md).

### The seven MCP tools

The same abilities are offered to AI tools as seven MCP tools: `learn_library`, `recommend`, `check_cousins`, `resolve`, `get_example`, `verify_frame` and `recipe`. They return the same cards as the command line.

## Team config files

Each team keeps its own files in its store folder (`GRAPHIFY_HOME`, or the nearest `.graphify/`). Missing files mean "use the defaults". Files are read on every ask, so an edit applies on the next ask with no rebuild. Never put your company or design-system name in this repository; keep it in your own store.

### `.graphify/synonyms.json` — your team's words

**Owner:** the design system team (whoever knows how people on the team talk).

Shape: a list of `groups`, each with `terms` (two or more words that mean the same) and an optional `reason`.

```json
{
  "groups": [
    { "terms": ["beneficiary", "payee"], "reason": "Acme says beneficiary for payee" }
  ]
}
```

Before this file, `recommend "beneficiary"` returns nothing. After it, it returns Payee picker. A broken file changes nothing. Words that are one word long are matched alone; built-in groups cover common words such as button/cta, search/find and price/amount.

### `.graphify/icon-libraries.json` — icon-only libraries

**Owner:** the design system team.

Lists Figma libraries that hold only icons, so icons never outrank a real control for a generic ask. Each entry matches a **file name, file key, or page name** (case-insensitive). An entry is a string or `{ "name" | "fileKey" | "page": ... }`.

```json
{
  "libraries": ["Acme Icons", { "fileKey": "ICONS01" }, { "page": "Acme Icons Page" }]
}
```

Icons come back when the ask is for an icon, or when you give the icon's exact distinctive name. An entry that matches nothing prints one line on stderr (once per run, never inside a card). An entry that matches your main library is ignored, with a message, because it would hide real components. With no file, Resolve falls back to a name guess (`word-NNN-word`, or a name that starts or ends with icon/glyph/symbol). Remote icon masters (published in another Figma file) are matched through a lookup that needs `FIGMA_ACCESS_TOKEN`; if that lookup fails, ingest still succeeds.

### `.graphify/code-map.json` — Figma-to-code twins

**Owner:** the engineers who own the code components. Resolve never writes or guesses this file.

It says "this Figma component is this code component". Shape:

```json
{
  "entries": [
    {
      "fileKey": "ACMEUI",
      "id": "10:1",
      "code": { "import": "import { Button } from '@acme/ui'", "component": "Button" }
    },
    {
      "fileKey": "ACMEUI",
      "name": "Payee picker",
      "code": { "import": "import { PayeePicker } from '@acme/payments'", "component": "PayeePicker" }
    },
    {
      "fileKey": "ACMEUI",
      "id": "10:9",
      "status": "retired",
      "replacedBy": "Button",
      "code": { "import": "import { OldButton } from '@acme/ui-legacy'", "component": "OldButton" }
    }
  ]
}
```

The rules, in plain words:

- **Which component.** `fileKey` plus `id` (the exact Figma node id) is the key. A whole-id match is required: `1:1` never matches `11:1`. `name` works instead only when that name is unique in the file, and the letters must match exactly. Two components with the same name are `ambiguous` and get no code line, whatever order the file lists them in. An explicit `id` entry for one of them still works.
- **Variants.** A variant (for example `Button / Primary`) uses the code twin of its set.
- **`code`.** `component` must be a plain name like `Button`. `import` must end with `from '<module>'`. Anything else is ignored with a reason (Resolve rejects a bad value rather than quietly changing it).
- **`status`** is `current` or `retired`. If you leave it out, Resolve uses the library's own flag (see the next section). `replacedBy` is optional: the Figma name or id of the part to use instead.
- **Two entries for one component** are not settled by file order. If one says current and the other says retired, the current one wins. If both say the same thing, they merge. If they disagree otherwise, the component is a `conflict` and shows no code line.
- **Unknown fields.** Any field that is not in the shape above makes that entry ignored, with the reason shown (for example `unsupported field 'key'`). `props`, `source` and `key` are not supported. A top-level `namingRule` ("auto-map a PascalCase name") is planned and not built yet; it is ignored and reported as such.
- **A missing, empty, or byte-order-mark-only file** is simply "no map", with no message. A file that is not valid JSON prints one line on stderr (`code-map.json is malformed; ignored`).
- **A file with nothing usable** says `code-map.json has no usable entries.` and lists why each entry was ignored.
- **Where the code line shows.** It is added to the `recommend` card (for the top pick only), the `resolve` card, and the MCP versions of both, only if it fits inside the card limit without dropping a candidate. It is never added to a weak match, and never to a retired part. The code line is cleaned of control characters, so a bad file cannot sneak text into an agent's prompt. Without a map, every card is byte-for-byte what it was before.

`resolve code-map` reports `mapped`, `retired`, `unmapped`, `ambiguous`, `conflict`, `stale` (an entry whose component is not in the library, with its file key) and `ignored`. Only real components and component sets are counted: variants, remote stubs and `_`/`base` parts are not.

### Other optional files

`bind-rules.json` (must use / must not use / prefer; see [`docs/BIND-RULES.md`](docs/BIND-RULES.md)), `library-rules.json` (a simple allow/deny list of names), `recipes.json` and `context-packs.json` (your own recipes and product/journey packs; see [`docs/RECIPES.md`](docs/RECIPES.md)), and `placeholders.json` (template sentences that must not be left in a final screen; see [`docs/GUIDE.md`](docs/GUIDE.md)).

## Retired and old components

Old screens still use old components, so Resolve cannot forget them. But new screens must not use them. Resolve's rule has two halves:

- **Retired parts stay known.** They stay in the graph, stay in the code map, and show their code twin when you read an existing frame.
- **Retired parts are never recommended for a new screen.** `recommend` and `resolve` never offer one as the pick and never print its code line as the pick.

How a part counts as retired:

1. **The library says so.** A name with `[deprecated]`, a description such as `status: deprecated`, or a description that starts with words like "retired" or "no longer supported". A retired set makes all its variants retired. A sentence such as "The old design is retired. This one is current." does not retire the part, and "Do not use inside forms" does not retire it either.
2. **Your code map says so.** `"status": "retired"` on an entry. This hides a part the library still calls live, from `recommend`.
3. **A map cannot bring a part back.** `"status": "current"` does not revive a part the library itself retired.

What you see, with the pretend retired "Old Button" (replaced by "Button"):

- `recommend "old button"` returns Button (never Old Button), the code line `Button from '@acme/ui'`, and, if it fits in 600 characters without dropping a candidate, a short note: `"retired": "Old Button is retired, use Button."`.
- `resolve "Old Button"` answers `deprecated: true` and shows the replacement. It has no code line.
- `verify` on a frame that uses Old Button lists it as `deprecated`. When there is room in the card, it also adds `"retired": [{ "name": "Old Button", "code": "OldButton from '@acme/ui-legacy'", "replacedBy": "Button" }]`, so the agent sees what the old part maps to. The list is cut down (drop the code, then drop the replacement) before it is dropped, and a card that is already full does not grow past 600.
- A `replacedBy` that names nothing, or names two parts, gives no "use" suggestion. Resolve never guesses a replacement.

## Accuracy and honesty rules

- **It never invents.** An id or component name in an answer is always one that exists in the stored library. "Invent rate" must be 0%.
- **It says "no match".** Asks the library cannot answer (for example "color picker" when there is none) return an empty list and "No master matched. Do not invent."
- **A loose match is labelled.** "Weak match" and up to three parts, instead of one confident guess.
- **A pass means something.** `verify` says "Verified" only when at least one placed piece was checked by its own component id or key. A layer-name match is "name-only" and a bare list or an empty frame is "nothing checked". Neither is a pass. A layer renamed on the canvas still verifies by id, and the card says the label differs.
- **Retired and private parts are not offered** as the pick.
- **Only people change rules.** Bind rules, recipes, synonyms and code maps change when a person edits them or approves a proposal.
- **Small, fixed cards.** `recommend` and `verify` stay within 600 characters, `resolve` within 2,000 and `recipe` within 2,000. The largest seen on the repo's test set: recommend 600, verify 559, resolve 978, recipe 964.
- **No token in the repo.** Never store a Figma token in files.

Numbers from the repo's own checks (run `npm test` and `score` to reproduce):

| Check | Result |
| --- | --- |
| Repo golden set (top-1) | 118/118, invent 0, leak 0 |
| Phrase set (regression) | 96/96 |
| 8-screen Material-like library, alone, and with a product screen learned | top-1 41/41, top-3 41/41, honest no-match 14/14, false no-match 0/41, synonyms 18/18, invent 0 |
| Tests | 602 passing |

**Top-1** means the first component returned is the right one. **Invent** means a component not in the library. **Leak** means a retired or private component offered as a pick. The golden and phrase sets were written alongside the code, so they are a regression guard and not proof about unseen wording. How the sets are built: [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md).

## Limits: what is not tested yet

- Not proven on a real company library over time. The checks above use a sample library and a Material-like test library. An earlier independent blind test on a sample library moved top-1 on unseen asks from 38% to 83% after PR #19.
- Code twins are only as good as the map: Resolve does not check that the code component exists or that its props match the Figma variants.
- The map has no per-variant props, no source path, and no automatic same-name rule yet (all planned).
- If both entries for one part are retired and disagree, you get "conflict"; there is no tie-break on purpose.
- `verify` adds the `retired` list only when it fits in 600 characters. On an already-full card (many failures at once), the list can be left out; the part is still reported under `deprecated`.
- SOCI does not compare journeys across products yet.
- Linking several design systems into one is a later step.
- Large-library speed is measured only on generated test graphs (`npm run bench`).

## Version history

Newest first. Dates are the day each pull request was merged on GitHub (UTC). "Tests" is the number of tests in the repo at that change (counted by running the suite on the commit). PR #28 is still a draft.

- **Oct 2, 2026 — [PR #28](https://github.com/TANISHQBAFNA/resolve/pull/28) (draft).** Map Figma components to team-owned code twins; retired parts stay mapped but are never recommended. 602 tests.
- **Oct 1, 2026 — [PR #27](https://github.com/TANISHQBAFNA/resolve/pull/27).** Prefer filled sets over same-name stubs; icon libraries file; stricter retire rules. 582 tests.
- **Sep 30, 2026 — [PR #26](https://github.com/TANISHQBAFNA/resolve/pull/26).** Treat layer names as labels, not component identity. 541 tests.
- **Sep 29, 2026 — [PR #25](https://github.com/TANISHQBAFNA/resolve/pull/25).** "Primary button" returns Button; ordinary words find the right part; honest "weak match". 517 tests.
- **Sep 29, 2026 — [PR #24](https://github.com/TANISHQBAFNA/resolve/pull/24).** Make Resolve the first step on every Figma design task (short MCP instructions, `resolve-setup`). 490 tests.
- **Sep 28, 2026 — [PR #23](https://github.com/TANISHQBAFNA/resolve/pull/23).** Docs: correct performance wording. 479 tests.
- **Sep 28, 2026 — [PR #22](https://github.com/TANISHQBAFNA/resolve/pull/22).** Live text in `verify`; example caching for speed. 479 tests.
- **Sep 28, 2026 — [PR #21](https://github.com/TANISHQBAFNA/resolve/pull/21).** A real example with every pick; leftover-text and sizing warnings. 466 tests.
- **Sep 28, 2026 — [PR #20](https://github.com/TANISHQBAFNA/resolve/pull/20).** README refresh: seven layers, honest accuracy. 449 tests.
- **Sep 28, 2026 — [PR #19](https://github.com/TANISHQBAFNA/resolve/pull/19).** Keep component picks when words describe the component (cart badge, login field). 429 tests.
- **Sep 28, 2026 — [PR #18](https://github.com/TANISHQBAFNA/resolve/pull/18).** Fix library verify, Figma metadata handling, and Claude setup. 449 tests.
- **Sep 27, 2026 — [PR #17](https://github.com/TANISHQBAFNA/resolve/pull/17).** Rank component picks by name before screen context. 428 tests.
- **Sep 27, 2026 — [PR #16](https://github.com/TANISHQBAFNA/resolve/pull/16).** An offline accuracy scoreboard for agent cards. 412 tests.
- **Sep 27, 2026 — [PR #15](https://github.com/TANISHQBAFNA/resolve/pull/15).** SOCI v1: improvement proposals from real use. 402 tests.
- **Sep 27, 2026 — [PR #14](https://github.com/TANISHQBAFNA/resolve/pull/14).** Why line, bind rules, and the approve flow. 377 tests.
- **Sep 27, 2026 — [PR #13](https://github.com/TANISHQBAFNA/resolve/pull/13).** Plug-and-play Resolve for the Figma MCP; live usage learning. 347 tests.
- **Sep 27, 2026 — [PR #12](https://github.com/TANISHQBAFNA/resolve/pull/12).** Harden the agent loop: invent gates, a live shared store, lookup by name. 314 tests.
- **Sep 26, 2026 — [PR #11](https://github.com/TANISHQBAFNA/resolve/pull/11).** Stamp the file key on verify, reject bad ingest roles, fix workspace docs. 284 tests.
- **Sep 26, 2026 — [PR #10](https://github.com/TANISHQBAFNA/resolve/pull/10).** Multi-file workspace and the wrong-cousin report. 280 tests.
- **Sep 26, 2026 — [PR #9](https://github.com/TANISHQBAFNA/resolve/pull/9).** Designer guide in plain English. 265 tests.
- **Sep 26, 2026 — [PR #8](https://github.com/TANISHQBAFNA/resolve/pull/8).** Product and journey context packs for recipe and recommend. 264 tests.
- **Sep 26, 2026 — [PR #7](https://github.com/TANISHQBAFNA/resolve/pull/7).** Better library picks and a forced happy path. 249 tests.
- **Sep 25, 2026 — [PR #6](https://github.com/TANISHQBAFNA/resolve/pull/6).** Overview landing: health, counts, cluster cards. 244 tests.
- **Sep 25, 2026 — [PR #5](https://github.com/TANISHQBAFNA/resolve/pull/5).** Screen recipes: composition packs for common jobs. 240 tests.
- **Sep 25, 2026 — [PR #4](https://github.com/TANISHQBAFNA/resolve/pull/4).** Recommend and `verify_frame`: reuse becomes measurable. 227 tests.
- **Sep 24, 2026 — [PR #2](https://github.com/TANISHQBAFNA/resolve/pull/2).** Toolchain upgrade (Vite 8, React 19, Vitest 5). 219 tests.
- **Sep 22, 2026 — [PR #3](https://github.com/TANISHQBAFNA/resolve/pull/3).** Product renamed from Keyline to Resolve. 219 tests.
- **Sep 20, 2026 — [PR #1](https://github.com/TANISHQBAFNA/resolve/pull/1).** First public release: personal and client leftovers scrubbed from the tree. 219 tests.

## FAQ

**Is Resolve a Figma plugin?** No. It runs beside your AI tool and talks to it over MCP. You never open it inside Figma.

**Does it change my Figma file?** No. It only reads (and only when you ingest or learn). The AI tool does the drawing.

**Do I need a Figma token?** Only for command-line ingest of a live Figma URL. With the Figma MCP connected, the AI tool passes Resolve what it reads and no token is needed. Never commit a token.

**What if my library has no component for the ask?** Resolve says "No master matched" and returns nothing. The AI tool should tell you, not make one up.

**What does "weak match" mean?** The words in the ask only partly matched. You get up to three possible parts instead of one confident guess. Look before you place.

**Why did `verify` say "nothing checked"?** The frame had no placed piece that carries a library component id or key (for example, a hand-drawn layer, or an empty frame). Layer names are only labels, so they are not enough for a pass.

**Why does my retired component not show in `recommend`?** Retired parts are never recommended for a new screen. They are still mapped, and you still see them when you read an old frame or ask for them by exact name with `resolve`.

**Can the code map revive a retired part?** No. If the library flags a part retired, `"status": "current"` in the map does not change that. Fix it in Figma.

**Why is there no code line on my `recommend` card?** One of: no map; the top pick is a weak match; the top pick is retired; the part is not mapped (see `resolve code-map`); the name is ambiguous or in conflict; or the line did not fit in the 600-character card without dropping a candidate.

**Where do I put team words?** `.graphify/synonyms.json`. See [team config files](#team-config-files).

**Is my data sent anywhere?** Resolve stores files in your store folder on your machine. It calls Figma only when you ingest or look up published components, using your own token.

**What Node version?** 22.12 or newer (Node 24 also works).

## For developers

```bash
git clone https://github.com/TANISHQBAFNA/resolve.git
cd resolve
npm install
npm run build:server
npm run resolve -- help
npm test          # the full test suite
npm run build     # typecheck + browser build + server build
```

`npm run dev` opens an optional map of the graph in a browser (sample data, no login). `npm run keyline` still works as a deprecated alias.

- Plug-and-play next to Figma: [`docs/SETUP-MCP.md`](docs/SETUP-MCP.md)
- Designer guide: [`docs/GUIDE.md`](docs/GUIDE.md)
- Bind rules and approving a proposal: [`docs/BIND-RULES.md`](docs/BIND-RULES.md)
- SOCI: [`docs/SOCI.md`](docs/SOCI.md)
- Screen recipes: [`docs/RECIPES.md`](docs/RECIPES.md)
- Accuracy scoreboard: [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md)
- Cursor steps: [`docs/CURSOR-RESOLVE.md`](docs/CURSOR-RESOLVE.md)
- Building Resolve: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- How tools plug in: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)
- Toolchain versions: [`CHANGELOG.md`](CHANGELOG.md)

License: [`LICENSE`](LICENSE) (MIT)
