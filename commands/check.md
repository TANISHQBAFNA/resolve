---
description: Check a Figma screen for retired, wrong or unknown components
argument-hint: <Figma link to the screen or frame>
---
The designer typed: $ARGUMENTS

Check that the screen only uses approved components. Resolve only reads; it does not change the design.

1. The input must be a Figma link to a screen (with `node-id`, for example `?node-id=20-40`). If it is empty, ask for the link and stop. Pass the link as it is to Resolve as `frame`; Resolve reads the `node-id`.
2. Fetch the frame's design context from Figma (`get_design_context`) so Resolve can read the text.
3. Call the Resolve tool `verify_frame` with `frame` (the link) and `designContext`.
4. If a library file and a product file are both learned, also call `check_cousins` with `frame` (the link).
5. If Resolve says the frame or the design system is not learned, tell the designer to run `/design-system <link>` for that file first. Stop.
6. Report in plain words, three short lists: **Retired** (old components still on the screen, with the current replacement), **Wrong** (a lookalike from another family, with the right one), **Unknown** (not in the learned design system). Say PASS when all three are empty. Quote component names and ids exactly as Resolve gave them.

Do not fix anything unless the designer asks. Never invent a component, name or node id.
