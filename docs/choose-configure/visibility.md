# Child visibility

`configure` reads `componentPropertyReferences` that capture stored on the graph and calls `controllingFromReferences`. A child counts only when that reference names a property defined on the component. A hidden child and an overridden value stay in the result. A missing boolean value is `missing`. A reference that matches no property, or a layer whose identity is guessed, stays unknown with a reason.

This branch is the integration stack. It starts at screen-map PR 155 and includes choose-and-configure through PR 163. It is not a merge to `main`.

Order: screen-map PRs 148–155, then choose-and-configure PRs 156–163, then this branch.

`src/server/tools.ts` was over 1000 lines after the merge. The handoff tool schema moved next to the handoff command. Shared input fields moved to `src/server/toolFields.ts`.
