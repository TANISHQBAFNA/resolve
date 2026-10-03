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
