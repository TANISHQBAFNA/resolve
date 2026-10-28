---
description: Check a Figma screen for retired, wrong or unknown components
argument-hint: <Figma link to the screen or frame>
---
The designer typed: $ARGUMENTS

Check that the screen only uses approved components. Resolve only reads; it does not change the design.

1. The input must be a Figma link to a screen (with `node-id`, for example `?node-id=20-40`). If it is empty, ask for the link and stop. Pass the link as it is to Resolve as `frame`; Resolve reads the `node-id`.
2. Fetch the frame's design context from Figma (`get_design_context`) so Resolve can read the text.
3. Call the Resolve tool `verify_frame` with `frame` (the link), `designContext` and `all: true`. The card then has a `layers` list: one entry per checked part, each with one status.
4. If a library file and a product file are both learned, also call `check_cousins` with `frame` (the link).
5. If Resolve says the frame or the design system is not learned, tell the designer to run `/design-system <link>` for that file first. Stop.
6. The card's first line is the overall verdict. Exit 0 starts `PASS · Components: PASS · Proper use: PASS`. Proper-use errors start `FAIL: proper use (N errors, M warnings) · components pass`. Warnings alone still start with `PASS` and name the count. A component list with no frame stays `NOTHING CHECKED` and does not add a proper-use block. `textChecked` is on the card. Report one line per entry in `layers`. Every layer has exactly one status: **pass**, **name-only** (a guess from the layer name), **retired**, **invented**, **wrong cousin**, or **missing required state**. A pass line names the layer and stops. Each problem names the layer and says what to use instead (the replacement for retired, the real component for invented or name-only, the library cousin for a wrong cousin, the required component for a missing state). Do not leave a layer off the list. Do not give a layer two statuses.
7. Then read the Proper use section. It groups findings as errors, warnings, and info. Each finding names the layer, its figmaNodeId, the problem, the fix, and the token or component to use. A detached frame should be re-inserted as the named instance. An unbound colour names the nearest library token when one matches, and never a made-up name. Info lines marked unknown were not computed; do not treat them as failures. The summary line counts what was found (for example "1 detached, 1 hard-coded colour, 1 contrast fail"). A crowded card keeps every error before `+N more`. That line says to call `verify_frame` with `all: true` for the rest.

Do not fix anything unless the designer asks. Never invent a component, name or node id.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
