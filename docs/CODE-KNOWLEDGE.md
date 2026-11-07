# Coded component knowledge

An AI tool can write what it read in a code repo. Resolve checks that writing. The scanner still scans. This does not replace it.

Two files:

| File | What it is | Schema |
|---|---|---|
| DSCK | Ingredients. One coded component: id, props, variants, parts, slots, tokens, aliases. | `schemas/dsck.schema.json` |
| DSCI | Recipes. Which components are composed together. | `schemas/dsci.schema.json` |

The id is `ds@semver.tier.name`, for example `ds@1.0.0.core.button`. Every claim has evidence: a `file` path from the repo root and a 1-based `line` that exists. Templates: `templates/code-knowledge/dsck.json` and `templates/code-knowledge/dsci.json`.

## How the AI reads the repo

A local folder is read as it stands. A git URL plus a ref is cloned, that ref is checked out, and only that checkout is read.

```bash
git clone <url> <folder>
git -C <folder> checkout <ref>
```

Vanilla HTML, CSS, and JS count. So do class names, `data-ds-id`, modifiers (`--`), parts (`__`), tokens (`var(--name)`), slot attributes, and components that sit in the same file.

Set `source` to `ai` and `status` to `proposed`. Do not set `confirmed`.

## Check

```bash
resolve code knowledge
resolve code knowledge check dsck.json --repo <folder> --usage dsci.json
resolve code knowledge check dsck.json --repo <git URL> --ref <rev> --usage dsci.json
```

The check does three things:

1. The file matches the schema.
2. Each cited file and line exists in the repo.
3. The claims are compared with a fresh scanner run. Each pair is marked `source` `ai` or `scanner`. Agreements are claims both sides share. Disagreements are the rest.

Warnings do not stop the command. Each one ends with `next:`. The exit code is 0.

`figma` on a DSCK component is a mapping draft. It is written as `proposed` with tier `suggested` and reason `AI draft`, in the same component map scanner drafts use. It is not a link.

## A person confirms

Nothing is approved by the check.

```bash
resolve code knowledge confirm --who "Tanishk" --repo <folder>
resolve code-map --confirm "Acme Button=button" --who "Tanishk"
```

The first confirms the knowledge draft. The second confirms one mapping row, the same review a scanner draft uses. `--confirm-evidence` does not confirm these rows: their tier is `suggested`, not `evidence`.

Running the check again writes a new proposed draft.

## Acme

A small Acme sample (a button, a field, and a pay form, plus draft files) is not in this checkout.
