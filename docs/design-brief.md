# Design brief

A design brief is a short file a designer fills in **before** drawing a screen. It is built from the requirements document. It works with or without Resolve: a hand-written brief and a Resolve handoff pack pass the same check.

## Files

| File | What it is |
|---|---|
| [`templates/design-brief/brief.md`](../templates/design-brief/brief.md) | The per-ticket brief. Copy it into the ticket. |
| [`templates/design-brief/experience-rules.md`](../templates/design-brief/experience-rules.md) | The product-level rules. One per product: accessibility level, audience, compliance copy and must-nots. A brief only lists where it departs from them. |
| [`examples/design-brief/acme-approval/brief.md`](../examples/design-brief/acme-approval/brief.md) | A worked Acme example: a maker/checker approval screen. |

The brief has frontmatter (`ticket`, `product`, `journey`, `ui_scope`, `requirements_source`, `status`) and five sections:

1. **Journey changes.** Only the steps this ticket adds or changes, by journey id (`journey-<verb>-<noun>`). It points to the product's journey file and does not copy it.
2. **Screen inventory.** One row per screen and state: default, empty, loading, error (one row per named error), success and permission. Each row is filled in, or says `N/A — <reason>`.
3. **Content and data.** One row per displayed field: its source (API field, column or static copy), format and limits. The `provenance` column says `contract`, `inferred` or `proposed`. A field for a new endpoint is `proposed`, which tells API design what the screen needs.
4. **Experience-rule exceptions.** Only the departures from the product's rules.
5. **Open questions for the product owner.** Each has an owner and an answer.

## When a ticket is UI scope

A ticket is UI scope when it:

- touches the UI, or
- changes an API response or error code that a screen consumes.

Set `ui_scope: true` for these. A backend-only ticket sets `ui_scope: false` and skips the brief. The check then passes with a note, as long as the frontmatter is valid.

## Ready for planning

A ticket is ready for planning when one command exits 0:

```
resolve brief check <brief.md | handoff-folder>
```

The input is either a complete brief, or a Resolve handoff pack (the folder `resolve handoff "<frame>" --out <folder>` wrote) that is not a draft and where verify passed on every screen.

| Exit | Meaning |
|---|---|
| 0 | Pass |
| 1 | The file or folder is missing or unreadable (the CLI's usual error) |
| 2 | Frontmatter missing or invalid |
| 3 | Screen inventory: an empty cell, `N/A` with no reason, or a screen with no row for a state |
| 4 | A content field with no source or no provenance |
| 5 | An open question is unanswered (checked when `status: complete`) |
| 6 | `status` is still `draft`. A ticket needs a `complete` brief |
| 7 | The handoff pack is a draft, was refused, or verify did not pass |

When several things fail, the lowest code is the exit code and every problem is listed. `--json` prints the same report as data.

## Advisory suggestions

`resolve brief check <brief.md> --suggest` also runs `resolve spec` over the screen rows and lists each as mapped, weak or no match. A no-match row is a likely new component. This is advisory: it needs a learned library, and neither it nor a failure of it can change the exit code.

## Using the exit code

The exit code is the only contract. Any delivery process can run `resolve brief check` on a ticket and treat 0 as "ready for planning" and anything else as "not yet". The brief is built from the requirements document, and `requirements_source` points to it. Nothing in the brief names a code stack or a process, and Resolve's other features are not needed to fill it in.
