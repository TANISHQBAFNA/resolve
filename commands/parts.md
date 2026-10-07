---
description: What's on this screen and its code twin (or unmapped)
argument-hint: <Figma link to the screen>
---
The designer typed: $ARGUMENTS

This command answers one question: what's on this screen and its code twin (or unmapped). It is not the developer build sheet. That is `/handoff`.

1. The input must be a Figma link to a screen (with `node-id`). If it is empty, ask for the link and stop. If they named a component instead of a screen, ask for the screen link.
2. Run in the project folder: `resolve-figma parts "<link>"`. This is the local command from the same install as the MCP server. Do not use an unpinned `npx` package. If the shell says the command is not found, say: Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself. A client that only has the MCP server needs `RESOLVE_MCP_ADVANCED=1` and then calls `get_ingredients` for each real component on the screen. `/parts` takes a screen link, not a component name.
3. List every real component on the screen: name, Figma id, and the code twin. When `code` is `unmapped`, say unmapped. A part from another library is `other-library` with code `unknown`, not unmapped. A retired component stays in the list, labelled retired, with its replacement. Do not list a guess from a layer name. Do not show recipe slots, templates, or open questions. The command prints compact JSON. `--pretty` indents it.
4. If the screen is not learned, say so in plain words. Point them at `/handoff` only if they ask for the developer build sheet.
5. If no design system is learned, tell the designer to run `/design-system <Figma link>` first.

Never guess a code component. Never invent a component, name or node id.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
