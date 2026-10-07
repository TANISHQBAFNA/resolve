---
description: Ask Resolve which real component to use for a phrase
argument-hint: <what you need, e.g. payee picker>
---
The designer typed: $ARGUMENTS

Find the right component in the learned design system. Do not draw anything.

1. If the input is empty, ask what the designer needs and stop.
2. Call the Resolve tool `recommend` with `intent` set to the phrase. If the phrase is an exact component name, call `resolve` with `name` instead.
3. If Resolve says no design system is learned, tell the designer to run `/design-system <Figma link>` first. Stop.
4. Read the match before you speak. If the result says `weak match`, or the hint starts with "Weak match", show it as a weak match and quote the one-line reason (`why` or `hint`). Do not tell the designer to place it as if you were sure. A guess is never a confident pick.
5. A confident top pick: component name, `fileKey` and `figmaNodeId`, and the one-line reason. Show the next two hits as name and id only. If the top pick has an example (`ex`), name it; call `get_example` only when asked how to place it.
6. If Resolve has no match (no candidates), say exactly that: Resolve has no component for this phrase. Suggest another wording or `/design-system` for the right file. Do not guess or make one up.

Never invent a component, name or node id. Only use ids Resolve returned.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- This Figma seat can only view the file. Learning a library needs a Dev or Full seat. Ask someone with that seat to run /design-system, or change the seat, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
