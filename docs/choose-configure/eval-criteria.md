# Formative evaluation: choose and configure

These criteria are fixed before any run. A run that does not use them is not a result.

Compare three conditions on the same unseen tasks, with the same model and the same settings:

1. Baseline. No Resolve evidence and no `guidelines.md`.
2. Evidence only. The `configure` card, without the guidelines file.
3. Evidence plus guidance. The `configure` card and `skills/resolve-configure/guidelines.md`.

Score each task on:

- Component correctness. The chosen id is a real component and it is the one the task needs.
- Property and child configuration. Each set property is an allowed value the request supports. Each child is a slot the library lists. An unset property is not counted as a set.
- Unsupported claims. A sentence that states a fact the card does not return.
- Appropriate uncertainty. A gap on the card is named, including `visibility: unknown`. A sure claim where the card warned is a miss.
- Corrections. How many times the answer is changed after a warning.
- Completion time. Milliseconds from the task to the final answer.

Do not train on these tasks. Do not copy a private held-out phrase into the repo. Do not treat a file check, a setup spawn, or a SessionStart print as a model run.

No transcripts means the result is `not run`. Do not fill the table.
