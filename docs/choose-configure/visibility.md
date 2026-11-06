# Child visibility and the screen-map stack

Status: not shipped. No merge. `configure` on this branch still returns `visibility: "unknown"` unless a learned node already carries `componentPropertyReferences`. This branch's ingest does not write that field.

## What screen map already computes

On `origin/cursor/screen-map-lookalike-dba6` (PR 155, top of PRs 148–155):

- `src/core/ingestion/adapters/figmaRest.ts` reads Figma `componentPropertyReferences`.
- `src/core/transform/buildGraph.ts` copies that object onto node metadata.
- `src/core/screenMap/capture.ts` `controllingFromReferences` turns `visible: "showHelper#9:1"` into `{ property: "showHelper", type: "BOOLEAN" }` when the component's definitions name that property. Otherwise the type falls back to `BOOLEAN` inside screen map only.

Screen map is off unless `screenMap.enabled` is set. Choose-and-configure does not import `src/core/screenMap`.

## Local combined tree

Detached worktree at choose-configure `9f06f34`, merged with `origin/cursor/screen-map-lookalike-dba6`. Not committed. Not pushed.

Conflicts, two files:

- `package.json` `resolveSizeBudget`. This stack has server 7225 and core 35100. Screen map has server 7200 and core 35440.
- `tests/plugin.manifest.test.ts` command list. This stack adds `configure.md`. Screen map adds `map.md` and `map-build.md`.

After those two were filled in only in the worktree:

- `tsc --noEmit` passed.
- `tests/screenMap.capture.test.ts` passed. The Acme helper node stores `{ visible: "showHelper#9:1" }`, and `controllingFromReferences` returns `{ property: "showHelper", type: "BOOLEAN" }`.
- A probe built the same kind of Acme file, found that metadata on the Helper child, and `configureChoice(..., "button")` still returned `visibility: "unknown"`.
- `tests/chooseConfigure.command.test.ts` passed.
- Size on that tree: core 35578, server 7265. `src/server/tools.ts` is 1002 lines, over the 1000-line file cap. A real merge has to split that file. This document does not.

## Merge order, if it is authorised later

Do not merge from this note.

1. Screen map, in PR order: 148 schema, 149 capture, 150 builder, 151 views, 152 refs, 153 CLI, 154 fidelity, 155 lookalike.
2. Choose-and-configure, in PR order: 156 guidance, 157 command, 158 eval, 159 discovery, 160 folders, then this note's PR.
3. A follow-up that calls `controllingFromReferences` from `configureChoice` only when the child metadata has `visible`. Absent field stays `unknown` and keeps the current warning. Screen map's own command stays opt-in. Do not copy the helper into `chooseConfigure`.

Either stack can land first. The follow-up waits until both are on the same branch. Combining them also needs a new core budget of at least 35578, a server budget of at least 7265, and a split of `tools.ts`.

## Default behaviour

On this branch, with screen map absent, `configure` does not invent a controlling property. The warning stays: which property shows or hides a child is not in this graph. `next:` is to leave visibility unset.
