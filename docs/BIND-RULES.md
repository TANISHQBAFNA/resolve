# Bind rules and proposals

**You write the rule. You say yes to a proposal. Resolve never changes a rule on its own.**

This is the short designer page. Agents read the cards. You own the file.

---

## Write a rule

1. Copy [`src/data/bind-rules.example.json`](../src/data/bind-rules.example.json) into the **active store** as `bind-rules.json`. That is `~/.resolve/<workspace>/bind-rules.json` in plug-and-play, or repo `.graphify/bind-rules.json` when a local `.graphify` store is present (`resolve where` prints the folder).
2. Keep the three shapes. Delete the ones you do not need.
3. Save. CLI and MCP reload the file on the next recommend or verify. No restart.

### Require — this slot must use this master

Use this when payment always uses one Primary button, not a cousin.

```json
{
  "screenType": "payment",
  "slot": "primary-action",
  "require": "Pay CTA"
}
```

`require` is an **exact master name or id** already in the ingested library. If the name is missing or matches two masters, Resolve refuses the file. It will not guess an id.

After ingest, “Pay CTA” is stored as that master’s id. Recommend for a payment primary action returns that master. Verify on a payment screen **fails** if it is missing, names this rule, and tells the agent which id to place.

### Forbid — do not place this

```json
{ "forbid": "deprecated" }
```

Also allowed: `{ "forbid": "removed" }` or `{ "forbid": "Old Pay CTA" }` (exact name or id).

Recommend drops those masters. Verify fails if one was placed.

### Prefer — this library over that one

```json
{ "prefer": "Shared DS", "over": "Storefront" }
```

Names are the **labels or file keys** in `.graphify/workspace.json`. Recommend ranks Shared DS above Storefront. Verify does not fail on prefer — ranking only.

You can also write `{ "prefer": "Shared DS over Storefront" }`.

### Optional: rules for one context pack

In `.graphify/context-packs.json`, add `bindRules` on a pack with the same `{ "rules": [ ... ] }` shape. Those rules apply when that pack is active, on top of the workspace file.

---

## Approve a proposal

SOCK (verified usage) can **suggest** a rule after a master is strong on three real screens. That suggestion is a **pending proposal**. It does not edit your file.

See them:

```bash
npm run resolve -- soci
```

Each row has an id, a type, a one-line summary, and the evidence (which frames). Same suggestion again? Evidence merges. The list stays capped.

There are more types than “require this master”: recipe slot changes, variant candidates, deprecation review, and wrong-cousin hotspots. Plain examples: [SOCI — suggestions from real usage](SOCI.md).

**Approve a require-rule** (writes `bind-rules.json` and an audit line: who, when, proposal id, before/after):

```bash
npm run resolve -- approve soci:require-rule:pay-cta-payment --who "Tanishk"
```

**Approve a recipe update** (writes `recipes.json` overlay, not Figma):

```bash
npm run resolve -- approve soci:recipe-update:checkout-summary-header-node-stepper --who "Tanishk"
```

**Reject** (keeps the files as-is, still writes an audit line):

```bash
npm run resolve -- reject soci:require-rule:pay-cta-payment --who "Tanishk"
```

`--who` is required on the CLI. Resolve will not fall back to your user name.

In an AI tool, these actions live on the **advanced** MCP surface (`RESOLVE_MCP_ADVANCED=1`): `approve_proposal` and `reject_proposal`. Both also need `confirmedBy: "<human name>"`. Everyday agents only get the six tools; `callTool` refuses advanced names when the flag is unset.

---

## Why this master

Every recommend, recipe, and named-lookup card includes **one line** of why. It is built only from facts Resolve already has:

- counted **real-screen** usage (list-only checks do not count)
- confidence (strong vs low)
- stale / deprecated / removed
- this product/journey pack
- a bind-rule hit

If none of those exist and the master has instances in the file: **`used N× in file`**. If it has no instances either: **`not verified on a screen yet`**. Resolve will not invent a verified-screen count from the Figma file tree.

In the browser map, open the **Rules** tab. It lists live rules, pending proposals grouped by type with evidence, and the why line for a master you pick (`/api/governance` from the active store, including `vite preview`). It is a reading page, not the design app.

---

## What this is not

- Not a way to invent a Figma id.
- Not auto-governance. A proposal is a suggestion until you approve it.
- Not the old `{ allow, deny }` file. That still works as `.graphify/library-rules.json` for a simple name list.
