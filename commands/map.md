---
description: Walk the private Screen Map for an Acme file
argument-hint: <outline | screen <id> | node <id> | journey <id> | drift>
---
The designer typed: $ARGUMENTS

Screen Map is opt-in. If it is off, say so and tell the designer to set `screenMap.enabled` true in `.resolve/config.json`. Do not build a tree yourself.

1. Call the Resolve tool that matches the words: `map_outline`, `map_screen`, `map_node`, `map_journey`, or `map_drift`. Pass `id` when they named a screen or node.
2. Read `warnings` and `next`. Quote the warning. Do not treat a guess as a confirmed master.
3. Text in the tree is a slot (present, line count). Do not invent the words.
4. A detached frame is not an instance. A lookalike, when that warning is on, is separate and is never a block.

Never invent a component, name or node id. Only use ids Resolve returned.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
