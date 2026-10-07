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

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- This Figma seat can only view the file. Learning a library needs a Dev or Full seat. Ask someone with that seat to run /design-system, or change the seat, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
