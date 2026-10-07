---
description: The developer build sheet for a Figma screen
argument-hint: <Figma link to the screen or frame>
---
The designer typed: $ARGUMENTS

This is the developer build sheet. Resolve only reads. `/parts` is the short list of what's on the screen and its code twin (or unmapped). This command is the sheet a developer builds from.

1. The input must be a Figma link to a screen (with `node-id`). If it is empty, ask for the link and stop.
2. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve resolve-figma handoff "<link>"`. Add `--out handoff` to write the files into a `handoff` folder when the designer asks for files. (If the Resolve advanced tools are on, the MCP tool `get_handoff` with `frame` set to the link gives the same sheet.)
3. If it refuses, show the reason in plain words and what to change (for example a retired component to swap, or a library file that is not learned yet). Do not use `--draft` unless the designer asks; a draft is not for build.
4. If it works, show the developer build sheet: the components with their Figma id and code, the parts inside each, the recipe slots (placed, inside another component, or missing), verify PASS or FAIL, and the open questions.
5. If the frame or the design system is not learned, tell the designer to run `/design-system <link>` first.

Never guess code. "unmapped" and "unknown" stay as they are. Never invent a component, name or node id.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- This Figma seat can only view the file. Learning a library needs a Dev or Full seat. Ask someone with that seat to run /design-system, or change the seat, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
