---
description: Check an HTML screen against the coded design system
argument-hint: <path to the HTML file>
---
The user typed: $ARGUMENTS

Check that the screen only uses the design system's real classes and tokens. Resolve only reads; it does not edit the file.

1. If the input is empty, ask for the HTML file path and stop.
2. Call the Resolve tool `code_check` with `file` set to that path. If it says no repo is set, tell the user to set `repoPath` and stop.
3. Report the counts first, then each error and warning with its line and the fix Resolve gives. Info lines are context, not failures.
4. Do not edit the file unless the user asks. Never invent a class or token.
