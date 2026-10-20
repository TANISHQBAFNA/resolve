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
- a pick in `decision.json` is not a part that `handoff.json` lists on that screen (same name, file key and Figma id).

It never needs the current folder: the handoff folder is required.

## Shape

`kind` is `resolve.aidlc` and `schemaVersion` is `1`. The JSON Schema is [`schemas/aidlc-handoff.schema.json`](../schemas/aidlc-handoff.schema.json). It is generated from `src/core/query/aidlcContract.ts`, and a test fails if the two drift. Any change to the shape, including an added field, gets a new `schemaVersion`. Both `screens` lists have at least one item.

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
| `parts[]` | `name`, `variant`, `fileKey`, `figmaNodeId`, `count`, `identity`, `status`, `slot`, `codeStatus`, `code`, `angular` (`selector`, `importPath`, `module` or `standalone`), `states` (other values to build) |
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
| `rejected[]` | `what`, `reason` (weak, no match, retired, not a library component), `screen` |

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

## Sample

[`fixtures/aidlc/acme-sample.json`](../fixtures/aidlc/acme-sample.json): the Acme `Confirm payment` screen with the Acme Angular code map. A test rebuilds it and checks it is the same and passes the schema.

## Not in version 1

- Pushing to AIDLC. The export writes a file; the AIDLC side reads it.
- Approved records skipping future brief questions (a follow-up).
