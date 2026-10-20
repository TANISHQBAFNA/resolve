# AIDLC hook: the Resolve contract

Resolve hands a designed screen to AIDLC as one JSON file. It is opt-in: nothing is sent or written unless you run the export.

```
resolve handoff "Confirm payment" --out handoff     # writes handoff.json + decision.json
resolve export aidlc handoff --out aidlc.json        # the contract below
```

MCP (advanced surface): `export_aidlc` with `folder`.

The export only reads the two files a handoff wrote. It never runs a handoff, never asks Figma, and never guesses code.

## Shape

`kind` is `resolve.aidlc` and `schemaVersion` is `1`. The JSON Schema is [`schemas/aidlc-handoff.schema.json`](../schemas/aidlc-handoff.schema.json). It is generated from `src/core/query/aidlcContract.ts`, and a test fails if the two drift. A change that breaks a reader gets a new `schemaVersion`.

### requirementsContext (into AIDLC)

What the screen was asked for, as given. Nothing is filled in by guess.

| Field | Meaning |
|---|---|
| `request` | The words of the request, when a record has them |
| `screens` | Screen names in the handoff |
| `product`, `journey`, `audience`, `a11y` | Context the person passed (or a context pack), only when set |
| `answers` | Briefing answers: `shape`, `platform`, `states` |
| `assumptions` | What Resolve assumed instead of asking |
| `openQuestions` | What still needs a person, for example a part with no code link |

### designHandoff (out of Resolve)

| Field | Meaning |
|---|---|
| `draft` | `true` means not for build |
| `codeMap` | Whether a code map was loaded |
| `screens[]` | `name`, `fileKey`, `figmaNodeId`, `recipe` (`id`, `title`, `matchedBy`), `parts`, `verify`, `openItems` |
| `parts[]` | `name`, `variant`, `fileKey`, `figmaNodeId`, `count`, `identity`, `status`, `slot`, `code`, `angular` (`selector`, `importPath`, `module` or `standalone`), `states` (other values to build) |
| `verify` | `pass`, `retired`, `unresolved` |
| `decisions` | `recorded` (was a decision.json there), `picks`, `rejected`, the same lists as the decision record |

`code` is the code-map answer: a component and import, `unmapped` (never guessed), or `unknown` (its library is not learned). An unmapped part is an open item: stop and ask.

## Sample

[`fixtures/aidlc/acme-sample.json`](../fixtures/aidlc/acme-sample.json): the Acme `Confirm payment` screen with the Acme Angular code map. A test rebuilds it and checks it is the same and passes the schema.

## Not in version 1

- Pushing to AIDLC. The export writes a file; the AIDLC side reads it.
- Approved records skipping future brief questions (a follow-up).
