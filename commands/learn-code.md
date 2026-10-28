---
description: Learn the coded design system in the repo so Resolve can pick real classes
argument-hint: <repo folder, optional>
---
The user typed: $ARGUMENTS

Learn the coded design system. Resolve only reads the repo.

1. Call the Resolve tool `code_scan`. If the user gave a folder, pass it as `repoPath`. With no folder and no `repoPath` in `.resolve/config.json`, ask which folder holds the design system CSS and stop.
2. Report in plain words: components found, class and token counts, and the deprecated classes. Use `list: true` only if the user asks what exists.
3. If it says no repo is set or the folder has no CSS, say that and stop.

Never invent a component or class.
