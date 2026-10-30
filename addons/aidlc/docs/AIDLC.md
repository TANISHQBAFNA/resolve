# AIDLC hook: the Resolve contract

Resolve hands a designed screen to AIDLC as one JSON file. It is opt-in: nothing is sent or written unless you run the export.

```
resolve handoff "Confirm payment" --out handoff     # writes handoff.json + decision.json
resolve export aidlc handoff --out aidlc.json        # the contract below
```

MCP (advanced surface): `export_aidlc` with `folder`.

The export only reads the two files a handoff wrote. It never runs a handoff, never asks Figma, and never guesses code. `handoff --out` writes `decision.json` + `decision.md` by default (`--no-record` skips them); without a record the export says `recorded: false`.

Before exporting, Resolve checks both files and refuses (exit 1, `ok:false` with `--json`) when:

- `handoff.json` is not JSON, was refused, or has no screens;
- `decision.json` is not JSON, is not `schemaVersion` 1, is not a `handoff` record, or is for other screens;
- a pick in `decision.json` is not a part that `handoff.json` lists on that screen (same name, file key and Figma id), is listed twice, or differs from what Resolve builds from `handoff.json` (id, match, why); or picks or rejections were added or dropped.

A write that fails (a missing folder, `--out` naming a folder) says which file and why.

It never needs the current folder: the handoff folder is required.

## Shape

`kind` is `resolve.aidlc` and `schemaVersion` is `1`. The JSON Schema is [`schema/aidlc-handoff.schema.json`](../schema/aidlc-handoff.schema.json). It is generated from `src/contract.ts`, and a test fails if the two drift. Any change to the shape, including an added field, gets a new `schemaVersion`. Both `screens` lists have at least one item.

### requirementsContext (into AIDLC)

What the screen was asked for, as given. Nothing is filled in by guess.

| Field | Meaning |
|---|---|
| `request` | The words of the request, when a record has them |
| `screens` | Screen names in the handoff (at least one) |
| `product`, `journey`, `audience`, `a11y` | Context the person passed (or a context pack), only when set |
| `answers` | Briefing answers as option ids: `shape`, `platform`, `states` (values below) |
| `assumptions` | What Resolve assumed instead of asking |
| `openQuestions` | What still needs a person, for example a part with no code link |

### designHandoff (out of Resolve)

| Field | Meaning |
|---|---|
| `draft` | `true` means not for build |
| `codeMap` | Whether a code map was loaded |
| `screens[]` | `name`, `fileKey`, `figmaNodeId`, `recipe` (`id`, `title`, `matchedBy`), `parts`, `verify`, `openItems` |
| `parts[]` | `name`, `variant`, `fileKey`, `figmaNodeId`, `count`, `identity`, `status`, `slot`, `codeStatus`, `code`, `angular` (the code selector entry: `selector`, `importPath`, `module` or `standalone`), `states` (other values to build) |
| `verify` | `pass`, `retired`, `unresolved` |
| `decisions` | `recorded` (was a decision.json there), `picks`, `rejected`, the same lists as the decision record |

`code` is the code-map text: a component and import when `codeStatus` is `mapped`, else `unmapped` or `unknown`. An unmapped part is an open item: stop and ask.

### Picks and rejected (in `decisions`)

| Field | Meaning |
|---|---|
| `name` | The part's name in the library |
| `id` | Graph id, when the result had one |
| `fileKey`, `figmaNodeId` | Where the part is in Figma |
| `source` | Where the pick came from (values below) |
| `match` | How sure it is (values below) |
| `why` | One line, for example its code link |
| `screen`, `slot` | Where it is used |
| `rejected[]` | `what`, `reason`, `screen`. Reasons: `weak, check` · `no match in the learned library` · `retired` · `not a library component` · `not found in the learned files` · `saved recipe <title> already covers this` |

### Allowed values

| Field | Values |
|---|---|
| `match` | `fit` every word matched · `bound` a stored id (recipe or answer) · `placed` on the screen · `to-add` an answer adds it · `weak` check it · `name-guess` from a layer name, check it |
| `source` | `brief` · `answer` · `recipe` · `decision` · `compose` · `placed` |
| `identity` | `confirmed` · `name-guess` · `not-found` · `to-add` |
| `status` | `current` · `retired` · `not-found` · `other-library` |
| `codeStatus` | `mapped` · `unmapped` · `unknown` |
| `recipe.matchedBy` | `asked` · `screen name` |
| `answers.shape` | `table` · `cards` · `form` · `summary` · `counts` |
| `answers.states` | `empty` · `loading` · `error` · `pending` |
| `answers.platform` | `desktop` · `mobile` · `phone` · `compact` · `comfortable` |

## Versioned component ids

A component can carry one id that says which design system it is from, which version, which tier and which component:

```
<prefix>@<major>.<minor>[.<patch>].<tier>.<name>
ds@1.2.ingredients.button
ds@1.2.1.ingredients.button
```

| Part | Rule |
|---|---|
| `prefix` | Lowercase letters, digits or hyphens, starting with a letter. Set it with `idPrefix` in `.resolve/aidlc.json`; the default is `ds` |
| version | `major.minor` or `major.minor.patch`. A missing patch counts as 0 |
| `tier` | `base`, `ingredients` or `recipes` (`recipe` is read as `recipes`) |
| `name` | kebab-case: lowercase words joined by hyphens |

A malformed id is listed as a problem with the reason (for example `the tier "widgets" must be base, ingredients or recipes`). It is never joined.

### Where ids are read

- **Figma:** the component and variant names of each part in `handoff.json`, including the parts inside it. Put the id in the component name, for example `Button ds@1.2.ingredients.button`. Component descriptions are not in `handoff.json` yet, so an id written only in a description is not seen.
- **Code:** the code-map text of each part in `handoff.json`, and `resolveId` in each `component.json` under `codeRepo`:

```json
{ "id": "acme-button", "figma": { "name": "Button" }, "resolveId": "ds@1.2.ingredients.button" }
```

`.resolve/aidlc.json` (Resolve reads `RESOLVE_HOME` first, then the nearest `.resolve` folder above the current folder or the handoff folder):

```json
{ "idPrefix": "ds", "codeRepo": "../design-system" }
```

`codeRepo` is relative to the project folder that holds `.resolve`. It is a path on your machine, so keep `.resolve/` in `.gitignore`. A bad file or a bad `idPrefix` is a problem in the report, and the default prefix is used.

### Join and drift

Figma and code join on `<tier>.<name>` when both have the configured prefix, never on the whole id: `ds@1.3.ingredients.button` in Figma joins `ds@1.2.ingredients.button` in code. An id with another prefix is listed under `otherPrefix` and not joined. The two versions are then compared:

| Change | Meaning | Code behind Figma |
|---|---|---|
| same | Nothing to do | `ok` |
| patch | A small visual tweak, such as padding or radius | `info` |
| minor | A design change, or a new variant or property | `warning` |
| major | Breaking: a removed variant, a renamed property, or changed behaviour | `warning`, with the strongest wording (`MAJOR: … Do not map this part to the old code without checking`) |

Code ahead of Figma is `info`. A key seen at two versions on one side is a problem, and the newest is compared.

### Advisory only

The id report is a guide for developers mapping Figma components to code. It never blocks: no drift level, malformed id or bad config changes an exit code, refuses a handoff, or changes the `resolve.aidlc` export. The report says `"blocks": false`.

```
resolve export aidlc handoff --ids                   # summary, strongest drift first
resolve export aidlc handoff --ids --json            # the report as JSON
resolve export aidlc handoff --ids --out ids.json    # write the report
```

MCP (advanced surface): `export_aidlc` with `folder` and `ids: true`.

The report is its own document: `kind` `resolve.aidlc.ids`, `schemaVersion` 1, with `prefix`, `blocks`, `summary` (counts), `pairs` (`key`, `figma`, `code`, `change`, `direction`, `level`, `message`, `figmaFrom`, `codeFrom`), `figmaOnly`, `codeOnly`, `otherPrefix` and `problems`. The `resolve.aidlc` contract above is unchanged.

## Sample

[`fixtures/acme-sample.json`](../fixtures/acme-sample.json): the Acme `Confirm payment` screen with the Acme example code map. A test rebuilds it and checks it is the same and passes the schema.

## Not in version 1

- Pushing to AIDLC. The export writes a file; the AIDLC side reads it.
- Approved records skipping future brief questions (a follow-up).
