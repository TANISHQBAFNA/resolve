---
description: Ask Resolve which coded components to use for a screen need
argument-hint: <what you need, e.g. transaction table with pagination>
---
The user typed: $ARGUMENTS

Find the right coded components. Do not write markup yet.

1. If the input is empty, ask what the screen needs and stop.
2. Call the Resolve tool `code_pick` with `query` set to the phrase. If the result says no catalog or no repo, tell the user to run `/learn-code` first and stop.
3. Show the best match: its classes, the variants that fit, the markup, and any class to avoid. Quote the rule lines that apply. If nothing matches, say so. Do not invent a class.
