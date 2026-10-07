---
description: What's on this screen and its code twin (or unmapped)
argument-hint: <Figma link to the screen>
---
The designer typed: $ARGUMENTS

This command answers one question: what's on this screen and its code twin (or unmapped). It is not the developer build sheet. That is `/handoff`.

1. The input must be a Figma link to a screen (with `node-id`). If it is empty, ask for the link and stop. If they named a component instead of a screen, ask for the screen link.
2. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve resolve-figma handoff "<link>" --json`. (If the Resolve advanced tools are on, the MCP tool `get_handoff` with `frame` set to the link gives the same data.)
3. Show only the components on the screen: name, Figma id, and the code twin. When `code` is `unmapped`, say unmapped. When `code` is `unknown`, say unknown. Do not show recipe slots, templates, or open questions.
4. If it refuses, say the reason in plain words (for example a retired component, or no design system learned yet). Point them at `/handoff` only if they ask for the developer build sheet.
5. If no design system is learned, tell the designer to run `/design-system <Figma link>` first.

Never guess a code component. Never invent a component, name or node id.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- This Figma seat can only view the file. Learning a library needs a Dev or Full seat. Ask someone with that seat to run /design-system, or change the seat, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
