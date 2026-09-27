# Resolve — how to use it

**Figma rules. Agents resolve.**

This is the guide to start with if you set Figma library rules and want AI agents to pick the right components.

You do not need to read the code. You need a Figma library, a short list of screen packs, and (when one library serves more than one product) a context pack that says *this product* and *this step in the journey*. If that library is used in more than one Figma file, you also list those files in one Resolve **workspace**.

---

## What Resolve is

Resolve is one shared **design system brain**. It is one knowledge workspace — not one giant Figma file. The shared library file is the system of record. Product and client files sit next to it.

You already have main components in Figma — a Primary button, an Input, a checkout card. Agents are good at drawing screens. They are also good at inventing a new button every time.

Resolve’s job is to make the agent **ask first, then place a real library component**. It does not replace Figma. It does not judge taste. You still review the screen.

Think of it as a map of what already exists, plus a few rules you write in plain files, plus a checker after the draft.

---

## Who it is for

**You (designer or product).** You decide which masters may be used, which screen jobs exist (checkout summary, sign-in, empty state), which Figma files belong in the workspace (shared library, product, client), and — if several products share one library — which product and journey step this screen belongs to.

**The AI agent.** It builds the screen in Figma. It must use the component ids Resolve returns. It must not invent a new system.

If you can paste a Figma link and copy a small JSON file, you can run this.

---

## What you need

- A **Figma library or file** (a shared screen or frame link is enough to start — you do not have to dump the whole file).
- **Resolve** connected in the same AI tool as Figma. One config line — see [Resolve next to Figma MCP](SETUP-MCP.md).
- **A paid Figma seat with MCP access (Dev or Full)**, *or* a **Figma access token** for command-line REST ingest. View or free seats can still learn, but Figma’s read quota is low — Resolve saves progress and resumes across sessions.

Do the install once (only if you want the repo locally):

```bash
git clone https://github.com/TANISHQBAFNA/resolve.git
cd resolve
npm install
npm run build:server
```

That needs Node 22.12 or newer. Then open this folder in your AI tool and turn on Figma.

For clone flags, tokens, and the optional browser map, see [For developers](../README.md#for-developers) in the README.

---

## Core ideas (plain words)

**Master.** The main component in your library — the source of truth, not a one-off copy on a screen. Example: the Primary button in the Button set.

**Ingest.** Refresh Resolve’s knowledge from Figma. Do this when the library is new to Resolve, and **again whenever the library changes**. Until you ingest, Resolve cannot point at live components.

**Recipe (screen pack).** A named shopping list for a common screen job. “Checkout summary” might need a header, a line list, a Primary button, and an optional input. Resolve ships eight starters (checkout summary, settings form, search results, empty state, list and detail, sign-in, confirm dialog, nav and content shell). You can add your own.

**Context pack.** A note that says *this product* + *this journey step* (and who it is for). Shared libraries often have two Primary buttons that look alike. A context pack helps Resolve pick the Storefront checkout one, not the admin settings one.

**Recommend.** You (or the agent) ask in ordinary language — “checkout with primary button” — and get back a short ranked list of **live** masters, each with a Figma component id to place. An empty list means “do not invent.”

**Verify.** After the draft, Resolve checks the frame. It flags pieces that were invented, pieces marked retired in the library, and pieces it cannot match. It does **not** say the layout is beautiful. That is still you.

**Figma component id.** The address of that master in a file (`figmaNodeId`). Across files those ids can repeat, so every card also stamps the **file key**. Agents place that exact component in that file. They must not make up an id.

**Workspace.** The list of Figma files Resolve knows about for this project — usually one shared design-system library plus the product (and maybe client) files that use it. You edit `.graphify/workspace.json`, or ingest with `--role library` / `--role product` / `--role client` and Resolve writes it.

**Wrong cousin.** Same job or a similar name, but not the library master the shared DS expects. Example: a product file used a one-off button instead of the library Primary. Resolve reports that. It does not invent a replacement master.

---

## Happy path (what you do, what you get)

Use a checkout summary as the running example. Swap the words for your screen.

### 1. Refresh the library (learn / ingest)

Everyday path (Figma MCP + Resolve MCP): ask the agent to `get_metadata` on a library frame, then `learn_library` with that XML, the file key, and `role: library`. Optional: pass `search_design_system` results so cards include the published component key. SOCK lives in `~/.resolve/default` so CLI and MCP share it. A big library is several short passes — Resolve checkpoints and resumes.

Secondary path (REST token): paste a **screen or frame** link. First file is the shared design system (or pass `--role library`). Then ingest each product or client file. On a low Figma API tier, `--scope file` is safer (one request). A section-by-section walk honors rate-limit waits and can resume.

```bash
npm run resolve -- ingest 'https://www.figma.com/design/…?node-id=…' --role library --label "Shared DS"
npm run resolve -- ingest 'https://www.figma.com/design/…?node-id=…' --role product --label "Storefront"
```

Or ask the agent: “Ingest this Figma frame into Resolve as the library.” Then: “Ingest the Storefront file as a product file.”

**You get:** Resolve now knows the masters in those files. Cards stamp **file key + Figma component id**. If the product file used a library component, Resolve links that stub to the ingested library file — not only a “source unknown” bucket.

If ingest fails on a live `figma.com` link from the command line, you need `FIGMA_ACCESS_TOKEN`, or learn through Figma MCP in the AI tool (`learn_library`) instead. You do **not** need a live token to merge files that are already ingested (tests and fixtures work without one).

Re-run ingest for a file after you add, rename, or retire components in that file.

To see what is linked:

```bash
npm run resolve -- workspace
```

### 2. See the screen packs (recipes)

```bash
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
```

**You get:** A short card for Checkout summary. Each **slot** (header, line list, primary button, optional input) is either:

- already matched to a live master, with a Figma component id to place, or
- still open, with a suggested next ask for recommend.

After ingest, slots try to match real library masters. They never invent an id.

### 3. Ask for the right master (recommend)

For every slot that is still open, missing, or pointing at a retired master:

```bash
npm run resolve -- recommend "checkout with primary button"
```

If you wrote a context pack (below), you can name it:

```bash
npm run resolve -- recommend "primary button" --pack storefront-checkout-summary
```

Or skip the pack name and say which **product**, which **journey step**, and which **domain** (the area of the product — checkout, settings, onboarding) this screen is for:

```bash
npm run resolve -- recommend "primary button" --product Storefront --journey summary --domain checkout
```

`recipe` and `verify` take the same extras, so ranking and the after-draw check follow the same product and step.

**You get:** A short ranked list. Live, used masters rise. Retired ones sink. Product, journey, and domain words sit **on top of** name matching — so “Primary button” in a Storefront checkout pack prefers the checkout Primary, not a random cousin.

If the list is empty: **do not invent a component.** Change the words (use names from your library), re-ingest, or pick a different pack.

### 4. Place only those components

The agent draws in Figma using **only** the Figma component ids from the recipe and recommend cards.

It must not invent a new “Primary button.” It must not paste the whole library into chat. It must not guess an id.

### 5. Check the draft (verify)

```bash
npm run resolve -- verify "Checkout Summary"
```

You can also pass the names it placed:

```bash
npm run resolve -- verify --components "Button,MadeUpCard"
```

To apply the same product and step as recommend (including a pack’s deny list):

```bash
npm run resolve -- verify "Checkout Summary" --product Storefront --journey summary --domain checkout
```

**You get:** Pass or fail. Invented names (like `MadeUpCard`) fail. Retired masters fail. Pieces Resolve cannot match fail. A near name (`Header` vs `.Header`) is **not** approved — you get an unresolved row with a “did you mean” suggestion. Names that start with `.` or `_` (Figma’s private / unpublished parts) fail rather than pass. The card echoes each name you gave and what it resolved to. You then judge taste in Figma.

### 6. Check for the wrong cousin (when more than one file is linked)

If the workspace has a library file and a product or client file, ask Resolve whether the draft used a lookalike from the wrong family:

```bash
npm run resolve -- cousins "Checkout Summary"
npm run resolve -- cousins "Checkout Summary" --job "checkout summary" --pack storefront-checkout-summary
```

**You get:** A short card. `cousins` are placed pieces that match a role or a weak name but are not the library master. `unsure` means Resolve will not guess. An empty cousin list with `ok` placements means the draft used the shared DS. It still does not judge taste.

### 7. You review

Resolve is not the taste judge. If the Primary button is the right master but the spacing is wrong, that is a Figma note for the agent — not a Resolve bug.

---

## If you use an AI tool (short)

When Resolve is connected, the agent can call the same steps by name:

| Name | What it does |
|------|----------------|
| `list_recipes` | List screen packs |
| `recipe` | Get one pack (for example `"checkout summary"`) |
| `recommend` | Rank live masters for a brief; you can name a pack, or the product, journey step, and domain |
| `resolve` | Look up a master you already know by name (for example `"Main Card"`) |
| `verify_frame` | Check the drawn frame or the placed names; same optional pack / product / journey / domain |
| `check_cousins` | After a multi-file workspace exists: flag lookalikes that are not the shared DS master |
| `list_graphs` | Linked files (library / product / client) and their sizes |

On the Figma side, the agent may open a component **only after** one of those cards returned its id. Everyday names for that are `use_figma` and `get_design_context`.

You do not need to memorize this table. If the agent follows this repo’s Resolve instructions, it already has the order: ingest each linked file → recipe → recommend open slots → place returned ids → verify → cousin check when a library + product file are linked.

---

## How to write a context pack

Use this when **one Figma library serves more than one product**, or when a generic name like “Primary button” is not enough.

### Copy the example

1. Copy [`src/data/context-packs.example.json`](../src/data/context-packs.example.json) to **`.graphify/context-packs.json`**.
2. Edit that new file. Leave the example in `src/data/` as a template — Resolve does **not** load the example until you copy it.
3. **Never add Figma component ids** to a context pack. Recommend fills those after ingest.

A filled-in file looks like this:

```json
{
  "version": 1,
  "active": "storefront-checkout-summary",
  "packs": [
    {
      "id": "storefront-checkout-summary",
      "product": { "id": "storefront", "name": "Storefront" },
      "domain": "checkout",
      "journey": { "step": "summary", "screenJob": "checkout summary" },
      "audience": "returning shopper",
      "constraints": { "density": "compact", "a11y": "wcag-aa" },
      "recipeIds": ["checkout-summary"],
      "files": ["Storefront"],
      "client": { "id": "northwind", "name": "Northwind" },
      "libraryRules": { "deny": ["Banner"] }
    }
  ]
}
```

### What each line means

**`active`.** The pack agents should load by default when you do not name one. Here: Storefront checkout summary.

**`id`.** A stable name you choose for this pack. Use it with `--pack storefront-checkout-summary`. Keep it unique.

**`product`.** Which product this screen is for. You can write `{ "id": "storefront", "name": "Storefront" }` or a plain string `"Storefront"`. This is how Resolve prefers Storefront checkout pieces over another product that shares the same library.

**`domain`.** The area of the product, in everyday words — `checkout`, `onboarding`, `settings`.

**`journey`.** Where you are in the flow. `step` is the short label (`summary`). `screenJob` is the screen you are building (`checkout summary`) — the same kind of phrase you pass to `recipe`. You can also set `journey` to a single string like `"summary"`.

**`audience`.** Who the screen is for, in a phrase (`returning shopper`). This becomes extra context for ranking. It is not a separate audience tool.

**`constraints`.** Extra wishes in words — how dense the layout should feel (`compact`), and the accessibility bar you care about (`wcag-aa`). These help ranking. They do not run an accessibility audit.

**`recipeIds`.** Which screen packs this context applies to. Use the recipe **id**, not the title: `checkout-summary`, not `"Checkout Summary"`. This is the usual way to bind a pack. One file can list several recipes if they share the same product and journey.

**`libraryRules` (optional).** A small allow / deny list of **component names**. `"deny": ["Banner"]` means “do not pick Banner for this pack.” Same idea as the optional `.graphify/library-rules.json` file.

**`files` (optional).** Which product or client file(s) this pack applies to. Use the **file key** or the **label** from `.graphify/workspace.json` (`Storefront`). This does not invent masters. Recommend still prefers the shared DS library when a library-role file is linked.

**`client` (optional).** When the product name and the client name are not the same. Same shape as `product` — `{ "id": "northwind", "name": "Northwind" }` or a string `"Northwind"`. Same pack, not a second model.

Unknown extra keys are ignored. Invented Figma ids in this file are ignored. That is on purpose — this file is for product and journey, not for drawing.

---

## How to add the design-system library and product files

One shared design system is the system of record. Product files (and client files, when those are separate) are linked next to it.

### Option A — ingest writes the list

```bash
npm run resolve -- ingest '<library-url>' --role library --label "Shared DS"
npm run resolve -- ingest '<product-url>' --role product --label "Storefront"
```

First ingest with no `--role` is treated as the library. Later ingests default to product. Re-ingesting the same file keeps its role. Resolve refuses a silent role change (that would drop the library from cousins). Edit the JSON, or pass `--force-role`, if you really mean to switch.

### Option B — write the list yourself

1. Copy [`src/data/workspace.example.json`](../src/data/workspace.example.json) to **`.graphify/workspace.json`**.
2. Put one object per file: `role` (`library` | `product` | `client`), `key` (the Figma file key in the URL), optional `url` and `label`.
3. Ingest each file. Resolve stores that file’s knowledge and keeps the list.

A filled-in file looks like this:

```json
{
  "version": 1,
  "files": [
    {
      "role": "library",
      "key": "DsLibraryKey",
      "url": "https://www.figma.com/design/DsLibraryKey/Shared-DS",
      "label": "Shared DS"
    },
    {
      "role": "product",
      "key": "StorefrontKey",
      "url": "https://www.figma.com/design/StorefrontKey/Storefront",
      "label": "Storefront"
    }
  ]
}
```

Never add Figma component ids here. Never `Read` `.graphify/graph.json` — cards already stamp `fileKey` and `figmaNodeId`.

---

## How to bind packs to recipes

Resolve needs to know *which pack goes with which screen job*. First match wins:

1. **You name the pack** — `--pack storefront-checkout-summary` (or the same `pack` field in the AI tool).
2. **The recipe names a pack** — `"contextPackId": "storefront-checkout-summary"` on the recipe. Prefer putting `recipeIds` on the pack instead, so one product/journey file owns the bind.
3. **The pack lists the recipe** — `"recipeIds": ["checkout-summary"]`. This is the usual designer path.
4. **You pass product / journey / domain** — `--product Storefront --journey summary --domain checkout` (or the same fields in the AI tool). Resolve picks the best matching pack.
5. **The file’s `active` pack** — used when it lists this recipe, or when it lists none.

Recommend uses the same pack (or the active pack, or the product / journey / domain flags) **on top of** its usual ranking: name, variants, where it is already used, live over stale, retired last.

You can add or replace screen packs in `.graphify/recipes.json`. Matching `id` replaces a starter. Leave the stored Figma id off a slot unless that master is already in the ingested library. Details and a copy-paste recipe live in [Screen recipes](RECIPES.md).

---

## Rules agents must follow

These are the rules you should expect every agent to obey. If it breaks them, stop and point it back here.

1. **Place only returned ids.** Use the Figma component ids from recipe, recommend, or a named lookup. Cards include the file key because ids repeat across files. Never invent a component, a name, or an id.
2. **Never dump the whole file.** Do not paste the stored library map, a giant Figma export, or the whole page tree into chat. Short cards are the point.
3. **Do not open a whole frame in Figma as a “design system”** until a card returned that frame’s id. Agents draw with masters, not by cloning a random section.
4. **Re-ingest when a linked file changes.** Stale knowledge is how you get missing or retired masters. Ingest each file that changed.
5. **Empty recommend means stop.** Do not “helpfully” draw a new button.
6. **Verify after the draft.** Invented, retired, and unmatched pieces must be visible.
7. **Cousin-check a multi-file workspace.** If a library file and a product/client file are linked, run `cousins` / `check_cousins`. Unsure means stop, not guess.
8. **You still own taste.** Spacing, copy, and whether the screen feels right stay human.

Optional allow / deny for the whole library: `.graphify/library-rules.json` with `{ "allow": ["Button"], "deny": ["Banner"] }`. If that file is missing, “approved” means: it is in the ingested library, and it is not retired.

---

## What Resolve does not do yet

Be honest with yourself and with agents:

- **Not a Figma replacement.** You still design, comment, and ship in Figma.
- **Not a designer UI for “why this component.”** You do not yet get a visual card that explains the pick. Ranking still happens; the explanation UI is coming. The cousin report is a short pass/fail card, not that UI.
- **Does not create components.** Recipes and packs only point at masters that already exist.
- **Does not stay live by itself.** Changing Figma does nothing until you ingest again.

---

## Troubleshooting

**Recommend comes back empty.** The library was not ingested, the words do not match any master, or the live matches are all retired. Re-ingest. Use names from your library (“Primary button”, not “CTA widget”). Do not invent a fallback.

**The context pack does not seem to apply.** The file must live at `.graphify/context-packs.json` — the example under `src/data/` is only a template. `recipeIds` must be the recipe id (`checkout-summary`). Set `active`, or pass `--pack`, or pass the product, journey step, and domain. Then run `recipe "checkout summary"` again and look for the product and journey on the card.

**Cousin check says no library file.** `.graphify/workspace.json` needs a file with `"role": "library"`, and that file must be ingested. Product-only workspaces cannot guess the shared DS.

**Cousin check is unsure.** The name was too weak, or two library masters tied. Do not invent a master. Rename in Figma, re-ingest, or pass a tighter `--job` / pack.

**Picks feel stale after a library change.** Re-run ingest. That is the refresh path. There is no silent live sync.

**Verify says something was invented.** The agent placed a name that is not a library master (or not in this ingest). Run recommend again and place the returned id.

**Verify says not-exact / did you mean.** The name was close but not an exact master name or id. Do not treat that as approved. Use the suggestion only after you confirm it, or pass the stamped `fileKey:nodeId`.

**Ingest dies on rate limit (429).** `--scope file` is one request and is the safer choice on a low API tier. A section walk waits when Figma sends `Retry-After` (and tells you the wait if it is too long). Re-run the same ingest — completed sections are kept.

**Verify says retired or unresolved.** That master is marked don’t-use, or Resolve cannot match it in the current ingest. Recommend a live stand-in. Re-ingest if you just renamed it in Figma.

**Command-line ingest of a figma.com URL fails.** Live REST ingest needs `FIGMA_ACCESS_TOKEN`. Everyday use is Figma MCP in the AI tool (`learn_library` with `get_metadata` XML). That needs a paid Dev/Full seat with MCP access. View or free seats hit a low read quota — keep going; Resolve saves progress and resumes.

**The library is huge / quota ran out.** Do not start over. Call `learn_library` on the next frames in a later session. Checkpoints survive.

**“No graph stored.”** The error names the folder it looked in. Ingest first, into that same folder. Set `GRAPHIFY_HOME` so the command line and the AI connection share one store (otherwise they can look in different working directories). Recipe list can run with no library (slots stay open); recommend and verify cannot. `list_graphs` / `workspace` / `resolve where` print the path and `builtAt`.

**I know the component name, I just need the id.** `resolve "Main Card"` (CLI or MCP). An exact master always comes back with its id even if nothing uses it yet. If the name is not in the library, the card says so and tells you to `recommend` the job — not an empty list.

**Older command names.** Prefer `resolve`. `keyline` still works as a short-term alias.

---

## Where to go next

- **You are a designer using Resolve** — you are in the right file. Keep this tab.
- **You want to add or replace a screen pack** — [Screen recipes](RECIPES.md) (JSON details under a short plain-English intro).
- **You work mainly in Cursor** — [Cursor + Resolve](CURSOR-RESOLVE.md) is the same happy path with editor wiring.
- **You are building Resolve itself** — [Architecture](ARCHITECTURE.md) and [Integrations](INTEGRATIONS.md).
