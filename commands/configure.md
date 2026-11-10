---
description: Choose and configure a real component for a screen
argument-hint: <what the screen needs>
---
The designer typed: $ARGUMENTS

This chooses a real component and sets only properties the learned library allows. It is for the designer choosing and configuring that component. It stops there.

1. If the input is empty, ask what the screen needs and stop.
2. Call the MCP tool `configure` with `intent` set to the designer's words. If that tool is missing, run in the project folder: `resolve configure "<words>"`.
3. Place only the returned id. Set a property only when its evidence is `request`. Leave `unset` properties unset. Place a child only when `slots` lists it.
4. `visibility` is `controlled` when a child names a real property. The child lists that property. Otherwise `visibility` is `unknown`, with a reason. Do not guess a property the result does not name.
5. Show each warning and its `next:` line. A weak match stays weak. No match means stop. Never invent a component, a property value, or a child slot.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
