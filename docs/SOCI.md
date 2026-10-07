# SOCI — suggestions from real usage

**SOCI never changes a file on its own.** It watches verified screens, then asks you. You say yes or no.

SOCK is the usage log (which masters showed up on real frames). SOCI is the loop that turns that log into **pending improvements**. A proposal is a note for you, not a Figma edit.

Everyday agents do not see the list. `list_soci` stays on the advanced surface. Recipe and verify cards only say `pending improvements: N` when something is waiting.

---

## What can be suggested

Only **real verified frames** count (file key + frame id). A component-list check is an observation. It never creates these.

Each proposal has an id, a type, a scope, one plain-English line, a short evidence list (frame ids, counts, file keys), confidence, timestamps, and a status (`pending` / `approved` / `rejected`). The same suggestion merges evidence instead of duplicating. Resolve keeps the top handful per workspace so the list stays small.

### 1. Recipe update

Checkout screens keep using **Stepper** in the header, but the checkout recipe has no Stepper there.

SOCI asks: add or rebind that recipe slot. Approving writes `.resolve/recipes.json` (or the same file in `~/.resolve/<workspace>/`) atomically. It does not touch Figma.

### 2. Variant candidate

The same master is overridden the same way on three or more real screens — for example Card always picks up a Badge.

SOCI asks: consider an official variant. Approving **records the decision** for the design team. It does not create a variant in Figma and does not rewrite masters.

This only fires from data Figma actually sent:

- REST `overrides` / `componentProperties` (when a default is present to compare)
- Extra nested instances visible in the ingested tree (Badge sitting inside a Card instance)

**Gaps we skip rather than guess:** Figma MCP `get_metadata` has no override payload. Plugin-only `detachedInfo` is not on REST or MCP, so “this used to be an instance and someone detached it” is not a SOCI signal.

### 3. Deprecation candidate

Master A has **zero** verified-frame usage in the log, while a cousin (shared specific name, not a generic “button”) is strong on three or more screens.

SOCI asks: review deprecate or merge. Approving records the decision. Figma is not edited.

### 4. Wrong-cousin hotspot

Verify keeps correcting agents from cousin X to library master Y (or from product file to shared DS).

SOCI asks: prefer the library file over the cousin file, or rename X toward Y. Approving writes a prefer-over bind rule when the two live in different workspace files. Same-file naming fixes are a recorded note only.

Require-rules from strong usage (the original SOCI shape) still exist. Approving those still writes `bind-rules.json`.

---

## Screen jobs: a read, not a proposal

A designer, through the agent, says "payment screen" or "inquiry screen". `recommend` and `recipe` answer that from mapped screens in SOCK. Nobody writes a recipe, a synonym, or a part name for it.

**The job word has a meaning.** `src/data/screen-jobs.json` lists four jobs, with their words only. It holds no master ids and no slots.

| Job | Meaning | Words |
|---|---|---|
| inquiry | Look up something that already exists. | inquiry, enquiry, enquire, lookup |
| summary | Review what this flow already collected, before the commit. | summary |
| approval | Someone other than the maker decides. | approval, approve |
| payment | Move money. | payment, pay, checkout |

**The parts come only from verified frames.** When `verify_frame`, or the command-line `resolve verify` (which the AIDLC add-on's design-check runs), passes a real frame, each fact gets the frame's job: from the journey, else the domain, else the frame name. It is set only when exactly one job is named. Acme's "Send money" frame, journey `send`, domain `payments`, is a payment screen. Facts written before this change get their job the same way when read. A frame that names no job, or two, answers no screen ask. A part inside another component on the frame is marked `nested` and is not part of the screen.

**The answer.** For "inquiry screen", each master on a mapped inquiry screen ranks by how many distinct screens used it. A tie keeps the order of the screen that holds the most of them. The card gives the job, its meaning, the number of mapped screens, and confidence: `strong` from the usual threshold of 3 screens, `low` below it. Each master comes with `fileKey`, `figmaNodeId`, and `ex` when a real instance is known. Acme example: three verified inquiry frames each place Search and List, and one also has a Header. The answer is Search (3 screens), List (3), then Header (1). No master named Inquiry is needed.

- **No mapped screen of that job:** the card is empty and says so. It never falls back to a part whose name happens to contain the word, and never fills a starter recipe. `resolve gaps` lists it as "no mapped approval screen yet".
- **Two job words** ("approval summary"): both approaches, the one with more mapped screens first.
- **Starter recipes** still answer an exact recipe id, title or alias, unless the ask is a bare single job. "Checkout summary" is still the starter. "Payment screen" is not.
- **Component asks** ("primary button") rank as before. A `journey` or `screenType` on a component ask is still only a tie-break. Only the ask's own words choose the screen path.

This read never writes `recipes.json` and never waits for approve. Recipe-update proposals above still exist for when a hand-written recipe disagrees with usage. Approve stays human.

---

## How you say yes

```bash
npm run resolve -- soci
npm run resolve -- approve soci:recipe-update:checkout-summary-header-node-stepper --who "Tanishk"
npm run resolve -- reject soci:variant-candidate:node-card-nested-badge --who "Tanishk"
```

`--who` is required. In an AI tool: `RESOLVE_MCP_ADVANCED=1`, then `approve_proposal` / `reject_proposal` with `confirmedBy`.

| Type | Approve does |
|------|----------------|
| Require rule | Writes `bind-rules.json` + audit line |
| Recipe update | Writes `recipes.json` overlay + audit line |
| Variant / deprecation | Decision + note + audit line. No Figma, no masters, no extra rules |
| Wrong cousin | Scoped prefer (master + screen or slot) when files differ and the evidence has a scope; otherwise a naming note |

Reject always keeps the files as they were and still writes an audit line.

The Rules tab groups pending proposals by type and shows the evidence. `/api/governance` is read-only (dev server and `vite preview`).

---

## What this is not

- Not auto-governance. SOCI never applies a proposal.
- Not a Figma writer. Variants and deprecations stay human work in Figma.
- Not a dump of the library map. Cards stay short.
